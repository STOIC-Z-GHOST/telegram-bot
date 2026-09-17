// lib/limits.js
//
// Per-user usage limits, now tiered by subscription (see
// lib/subscriptions.js for how a user's tier is determined). The owner is
// never limited, on any tier. Kinds of cap:
//   - messagesPerHour / messagesPerDay: a real rolling window (checked
//     against a log of events, not a fixed clock-hour or clock-day
//     bucket) — it eases naturally as old messages age out, no reset job
//     needed. Free tier uses the daily field, Pro/Premium the hourly one
//     — see checkMessageLimit.
//   - maxTokens: a lifetime allowance, not a per-hour one. Deliberately a
//     "credits" model that a subscription raises, rather than something
//     that quietly refills on its own.
//   - imageGenPerMonth: a rolling 30-day window, matching the Stars
//     subscription's own renewal period.
//   - thinkingPerDay: a rolling 24-hour window, same shape as
//     messagesPerDay — every tier gets the same reasoning depth per
//     /think call, this only caps how often you can call it.
//   - searchPerDay: same shape as thinkingPerDay, for the mini app's 🔍
//     Search toggle — every tier gets the same search chain (SearXNG ->
//     Tavily -> Gemini grounding, see lib/search.js), this only caps how
//     often you can invoke it. Exists mainly to bound Tavily/Gemini-
//     grounding usage (the two paid-beyond-free-tier links in that
//     chain) per user, since SearXNG itself has no such cap to protect.
//   - maxImagesPerMessage: how many images can go in one message together
//     (Gemini's own technical ceiling is thousands of images and a 20MB
//     total request size — these tiers stay far below that on purpose;
//     even Premium's number is picked for a snappy reply, not to chase
//     Gemini's actual max).
//   - maxAttachmentsPerChat: a lifetime cap per chat thread, not per user
//     overall — a heavy chat doesn't affect any of your other chats.
//   - Gemini-grounding fallback budget (canUseGeminiGroundingFallback /
//     recordGroundingFallbackUsage, further down): unlike every other
//     cap here, this one is site-wide, not per-user — it protects the
//     one Google-billed link in lib/search.js's chain from ever actually
//     getting billed. searchPerDay bounds how often any one user can
//     *reach* that link; this bounds how much of the shared free pool is
//     left once they do.
// Token counts come directly from the AI providers' own usage figures in
// their API responses, not an estimate.

import { sql, eq, and, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { usageEvents, messages } from "../db/schema.js";
import { isOwner } from "./access.js";
import { getUserTier } from "./subscriptions.js";
import { getCreditedReferralCount, getReferralBonus } from "./referrals.js";
import { hasActiveChannelBonus, CHANNEL_BONUS_IMAGES } from "./channel.js";

export const TIER_LIMITS = {
  free: {
    // Daily rather than hourly on purpose — a 15/day bucket is easier for
    // a free user to understand and to actually exhaust gracefully than
    // an hourly one (which either resets too fast to mean anything, or
    // locks someone out mid-conversation for the rest of the hour).
    messagesPerDay: 15,
    maxTokens: 20000,
    maxFileBytes: 5 * 1024 * 1024,
    imageGenPerMonth: 3,
    maxImagesPerMessage: 5,
    // Lifetime per chat thread (see the comment on maxAttachmentsPerChat
    // below) — 2 is a deliberately tight number, not a placeholder. A free
    // user who wants to attach more just starts a new chat.
    maxAttachmentsPerChat: 2,
    // /think uses the same reasoning depth on every tier — the ladder
    // here is purely about how often you can invoke it before hitting the
    // daily wall, not how "smart" each individual answer is.
    thinkingPerDay: 3,
    // Lowered from 5 — see the searchPerDay comment above. Free tier is
    // the bulk of the user base, so it's the biggest lever on total
    // site-wide search volume.
    searchPerDay: 3,
  },
  pro: {
    messagesPerHour: 100,
    maxTokens: 1000000,
    maxFileBytes: 200 * 1024 * 1024,
    imageGenPerMonth: 10,
    maxImagesPerMessage: 10,
    maxAttachmentsPerChat: 100,
    thinkingPerDay: 15,
    // Lowered from 40 — was large enough that a handful of Pro users
    // alone could exceed Tavily's whole 1,000/month pool in a single day
    // if SearXNG had a bad stretch. See the searchPerDay comment above.
    searchPerDay: 15,
  },
  premium: {
    // Not mathematically infinite — a very high finite ceiling reads as
    // "unlimited" in practice without the edge cases an actual Infinity
    // could cause in storage/serialization.
    messagesPerHour: 1000,
    maxTokens: 10000000,
    maxFileBytes: 500 * 1024 * 1024,
    imageGenPerMonth: 1000,
    maxImagesPerMessage: 20,
    maxAttachmentsPerChat: 100000,
    thinkingPerDay: 40,
    // Lowered from 200 — same reasoning as pro, scaled up. Still the
    // most generous tier, just no longer big enough on its own to burn
    // through the entire site-wide Tavily/Gemini-grounding fallback
    // budget in one user's one day. The hard site-wide grounding budget
    // (see canUseGeminiGroundingFallback below) is the real backstop
    // either way — this cap is just a sane per-user limit on top of it.
    searchPerDay: 50,
  },
};

// Free tier's numbers get topped up by the referral ladder (see
// lib/referrals.js) and the channel-join bonus (see lib/channel.js) —
// Pro/Premium are already generous enough that neither bonus is the
// point for them, so they're returned as-is.
export async function limitsFor(telegramUserId) {
  const tier = await getUserTier(telegramUserId);
  const base = TIER_LIMITS[tier] || TIER_LIMITS.free;
  if (tier !== "free") return base;

  const [creditedReferrals, channelBonusActive] = await Promise.all([
    getCreditedReferralCount(telegramUserId),
    hasActiveChannelBonus(telegramUserId),
  ]);
  const bonus = getReferralBonus(creditedReferrals);
  return {
    ...base,
    messagesPerDay: base.messagesPerDay + bonus.messagesPerDay,
    maxTokens: base.maxTokens + bonus.maxTokens,
    maxFileBytes: base.maxFileBytes + bonus.maxFileBytes,
    imageGenPerMonth: base.imageGenPerMonth + bonus.imageGenPerMonth + (channelBonusActive ? CHANNEL_BONUS_IMAGES : 0),
    maxAttachmentsPerChat: base.maxAttachmentsPerChat + bonus.maxAttachmentsPerChat,
  };
}

async function countMessagesSince(telegramUserId, since) {
  const [{ count }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.telegramUserId, telegramUserId),
        eq(usageEvents.kind, "message"),
        gte(usageEvents.createdAt, since)
      )
    );
  return count;
}

export async function recordMessageUsage(telegramUserId, tokens) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "message", tokens: tokens ?? null });
}

export async function recordFileUsage(telegramUserId, bytes) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "file", bytes: bytes ?? null });
}

export async function recordImageUsage(telegramUserId) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "image" });
}

export async function recordThinkingUsage(telegramUserId) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "thinking" });
}

export async function recordSearchUsage(telegramUserId) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "search" });
}

// Gemini's own free grounding pool (5,000 search requests/month, shared
// across every Gemini 3.x call on this API key — not per user) backs the
// true-last-resort link in lib/search.js's fallback chain. Google only
// waives the charge on the first 5,000/month; past that it's $14/1,000,
// billed automatically if Cloud Billing is enabled on the project. These
// two track site-wide usage of THAT specific fallback path (not regular
// Gemini replies, which don't use grounding) so search.js can stop
// attempting it before crossing into paid territory, rather than
// trusting it'll rarely be hit.
//
// Rolls over a 30-day window rather than a calendar month — same
// approximation this file already uses for imageGenPerMonth, and it
// avoids needing to track Google's actual billing-cycle boundary.
const GEMINI_GROUNDING_MONTHLY_CAP = 5000;
// Stop at 90% of the free pool, not 100% — leaves headroom for the
// rolling-window approximation being a little off from Google's actual
// cycle, and for any other grounding usage elsewhere in the app.
const GEMINI_GROUNDING_SAFETY_CAP = Math.floor(GEMINI_GROUNDING_MONTHLY_CAP * 0.9);

export async function recordGroundingFallbackUsage(telegramUserId) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "grounding_fallback" });
}

// Site-wide, not per-user — this budget is shared across the whole bot,
// same as the real Google quota it protects. lib/search.js calls this
// right before it would otherwise call Gemini grounding; false means
// skip that call entirely so the chain resolves to null (proceed
// without search) instead of risking a billed request.
export async function canUseGeminiGroundingFallback() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(and(eq(usageEvents.kind, "grounding_fallback"), gte(usageEvents.createdAt, thirtyDaysAgo)));
  return count < GEMINI_GROUNDING_SAFETY_CAP;
}

export async function getUsageSummary(telegramUserId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [messagesLastHour, messagesLast24h] = await Promise.all([
    countMessagesSince(telegramUserId, oneHourAgo),
    countMessagesSince(telegramUserId, oneDayAgo),
  ]);

  const [{ total: totalTokens }] = await db
    .select({ total: sql`coalesce(sum(${usageEvents.tokens}), 0)`.mapWith(Number) })
    .from(usageEvents)
    .where(eq(usageEvents.telegramUserId, telegramUserId));

  const [{ count: imagesLast30Days }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.telegramUserId, telegramUserId),
        eq(usageEvents.kind, "image"),
        gte(usageEvents.createdAt, thirtyDaysAgo)
      )
    );

  const [{ count: thinkingLast24h }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.telegramUserId, telegramUserId),
        eq(usageEvents.kind, "thinking"),
        gte(usageEvents.createdAt, oneDayAgo)
      )
    );

  const [{ count: searchLast24h }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.telegramUserId, telegramUserId),
        eq(usageEvents.kind, "search"),
        gte(usageEvents.createdAt, oneDayAgo)
      )
    );

  return { messagesLastHour, messagesLast24h, totalTokens, imagesLast30Days, thinkingLast24h, searchLast24h };
}

// Call before making the AI call — returns { allowed: false, reason } if
// over either cap, so the caller can show that instead of spending an AI
// call it's just going to refuse to use anyway.
export async function checkMessageLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };

  const tier = await getUserTier(telegramUserId);
  const limits = await limitsFor(telegramUserId);
  const { messagesLastHour, messagesLast24h, totalTokens } = await getUsageSummary(telegramUserId);

  // Free tier is a daily bucket; Pro/Premium are the rolling hourly one.
  if (tier === "free") {
    if (messagesLast24h >= limits.messagesPerDay) {
      return {
        allowed: false,
        reason: `You've hit your limit of ${limits.messagesPerDay} messages per day. Try again in 24 hours, or /upgrade for a higher limit.`,
      };
    }
  } else if (messagesLastHour >= limits.messagesPerHour) {
    return {
      allowed: false,
      reason: `You've hit your limit of ${limits.messagesPerHour} messages per hour. Try again in a bit, or /upgrade for a higher limit.`,
    };
  }
  if (totalTokens >= limits.maxTokens) {
    return {
      allowed: false,
      reason: `You've used all ${limits.maxTokens.toLocaleString()} tokens of your allowance. /upgrade for more.`,
    };
  }
  return { allowed: true };
}

export async function checkFileSize(telegramUserId, bytes) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  if (bytes > limits.maxFileBytes) {
    const mb = Math.floor(limits.maxFileBytes / (1024 * 1024));
    return { allowed: false, reason: `That file's too big — your limit is ${mb}MB. /upgrade for a higher cap.` };
  }
  return { allowed: true };
}

export async function checkImageGenLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  const { imagesLast30Days } = await getUsageSummary(telegramUserId);
  if (imagesLast30Days >= limits.imageGenPerMonth) {
    return {
      allowed: false,
      reason: `You've used all ${limits.imageGenPerMonth} image generations for this 30-day period. /upgrade for more.`,
    };
  }
  return { allowed: true };
}

// /think gets the same reasoning depth on every tier — this caps how many
// times per day you can invoke it, not how thorough any single answer is.
export async function checkThinkingLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  const { thinkingLast24h } = await getUsageSummary(telegramUserId);
  if (thinkingLast24h >= limits.thinkingPerDay) {
    return {
      allowed: false,
      reason: `You've used all ${limits.thinkingPerDay} /think replies for today — resets on a rolling 24 hours. /upgrade for more.`,
    };
  }
  return { allowed: true };
}

// Same shape as checkThinkingLimit, for the 🔍 Search toggle — every tier
// gets the same search chain, this only caps how often per day you can
// invoke it (see lib/search.js and the searchPerDay comment above).
export async function checkSearchLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  const { searchLast24h } = await getUsageSummary(telegramUserId);
  if (searchLast24h >= limits.searchPerDay) {
    return {
      allowed: false,
      reason: `You've used all ${limits.searchPerDay} searches for today — resets on a rolling 24 hours. /upgrade for more.`,
    };
  }
  return { allowed: true };
}

// Checked before analyzing a batch of images — how many were attached to
// THIS message, not anything cumulative.
export async function checkImageCountLimit(telegramUserId, requestedCount) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  if (requestedCount > limits.maxImagesPerMessage) {
    return {
      allowed: false,
      reason: `Up to ${limits.maxImagesPerMessage} images per message on your plan — that was ${requestedCount}. /upgrade for more.`,
    };
  }
  return { allowed: true };
}

// Lifetime total for one chat thread — counts both the new `attachments`
// array column and the older single-attachment columns, so history from
// before multi-image support still counts toward the same cap.
export async function getChatAttachmentCount(chatId) {
  const [{ count }] = await db
    .select({
      count: sql`
        coalesce(sum(jsonb_array_length(${messages.attachments})), 0)
        + count(*) filter (where ${messages.attachmentUrl} is not null)
      `.mapWith(Number),
    })
    .from(messages)
    .where(eq(messages.chatId, chatId));
  return count;
}

// Checked before analyzing a batch of images — this chat's running total,
// not the user's overall usage, so one heavy chat never affects any of
// their other chats.
export async function checkChatAttachmentLimit(telegramUserId, chatId, addingCount) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  const existing = await getChatAttachmentCount(chatId);
  if (existing + addingCount > limits.maxAttachmentsPerChat) {
    return {
      allowed: false,
      reason: `This chat has hit its lifetime limit of ${limits.maxAttachmentsPerChat} attachments on your plan — start a new chat, or /upgrade for a higher cap.`,
    };
  }
  return { allowed: true };
}
