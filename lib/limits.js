// lib/limits.js
//
// Per-user usage limits, now tiered by subscription (see
// lib/subscriptions.js for how a user's tier is determined). The owner is
// never limited, on any tier. Kinds of cap:
//   - messagesPerHour: a real rolling window (checked against a log of
//     events, not a fixed clock-hour bucket) — it eases naturally as old
//     messages age out, no reset job needed.
//   - maxTokens: a lifetime allowance, not a per-hour one. Deliberately a
//     "credits" model that a subscription raises, rather than something
//     that quietly refills on its own.
//   - imageGenPerMonth: a rolling 30-day window, matching the Stars
//     subscription's own renewal period.
//   - maxImagesPerMessage: how many images can go in one message together
//     (Gemini's own technical ceiling is thousands of images and a 20MB
//     total request size — these tiers stay far below that on purpose;
//     even Premium's number is picked for a snappy reply, not to chase
//     Gemini's actual max).
//   - maxAttachmentsPerChat: a lifetime cap per chat thread, not per user
//     overall — a heavy chat doesn't affect any of your other chats.
// Token counts come directly from the AI providers' own usage figures in
// their API responses, not an estimate.

import { sql, eq, and, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { usageEvents, messages } from "../db/schema.js";
import { isOwner } from "./access.js";
import { getUserTier } from "./subscriptions.js";

export const TIER_LIMITS = {
  free: {
    messagesPerHour: 20,
    maxTokens: 100000,
    maxFileBytes: 50 * 1024 * 1024,
    imageGenPerMonth: 3,
    maxImagesPerMessage: 5,
    maxAttachmentsPerChat: 20,
  },
  pro: {
    messagesPerHour: 100,
    maxTokens: 1000000,
    maxFileBytes: 200 * 1024 * 1024,
    imageGenPerMonth: 10,
    maxImagesPerMessage: 10,
    maxAttachmentsPerChat: 100,
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
  },
};

export async function limitsFor(telegramUserId) {
  const tier = await getUserTier(telegramUserId);
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
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

export async function getUsageSummary(telegramUserId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [{ count: messagesLastHour }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.telegramUserId, telegramUserId),
        eq(usageEvents.kind, "message"),
        gte(usageEvents.createdAt, oneHourAgo)
      )
    );

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

  return { messagesLastHour, totalTokens, imagesLast30Days };
}

// Call before making the AI call — returns { allowed: false, reason } if
// over either cap, so the caller can show that instead of spending an AI
// call it's just going to refuse to use anyway.
export async function checkMessageLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };

  const limits = await limitsFor(telegramUserId);
  const { messagesLastHour, totalTokens } = await getUsageSummary(telegramUserId);

  if (messagesLastHour >= limits.messagesPerHour) {
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
