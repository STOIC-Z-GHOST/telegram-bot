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
//   - maxTokens: a rolling 30-day allowance (same window as
//     imageGenPerMonth and the Stars subscription's renewal period). Usage
//     from more than 30 days ago stops counting, so the allowance refills
//     gradually as old usage ages out rather than all at once on a
//     calendar date. A subscription raises the ceiling.
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
//   - voicePerDay / maxVoiceSeconds / voiceSecondsPerDay: voice-to-text (see
//     lib/transcribe.js). voicePerDay is a rolling 24-hour count of
//     transcriptions (same shape as thinkingPerDay); maxVoiceSeconds caps ONE
//     recording's length; voiceSecondsPerDay caps total audio per rolling day
//     (so a few long clips can't use up the shared Groq pool). Free
//     tier gets a deliberately small taste, and the referral/channel bonuses
//     never extend it. Set a tier's voicePerDay to 0 to switch voice off for
//     that tier entirely. A site-wide daily budget (canUseVoiceTranscription,
//     further down) sits on top so the shared Groq Whisper free pool can't
//     be drained by everyone at once.
//   - Gemini-grounding fallback budget (canUseGeminiGroundingFallback /
//     recordGroundingFallbackUsage, further down): unlike every other
//     cap here, this one is site-wide, not per-user — it protects the
//     one Google-billed link in lib/search.js's chain from ever actually
//     getting billed. searchPerDay bounds how often any one user can
//     *reach* that link; this bounds how much of the shared free pool is
//     left once they do.
// Token counts come directly from the AI providers' own usage figures in
// their API responses, not an estimate.

import { sql, eq, and, gte, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { usageEvents, messages } from "../db/schema.js";
import { isOwner } from "./access.js";
import { getUserTier, getSubscriptionInfo } from "./subscriptions.js";
import { getCreditedReferralCount, getReferralBonus } from "./referrals.js";
import { classifyFile } from "./fileTypes.js";

// How far back token usage is counted. Messages use a rolling 24 hours (free) or
// rolling hour (Pro/Premium); tokens use this. Both are ROLLING windows, not
// clock-aligned: usage ages out one event at a time, so there is no midnight
// to game and no timezone to pick. Changing this changes what the maxTokens
// numbers below MEAN — 30 means "per 30 days", 1 would mean "per day" — so
// change maxTokens with it (see the usage bar in the mini app's menu footer).
export const TOKEN_WINDOW_DAYS = Number(process.env.TOKEN_WINDOW_DAYS) > 0 ? Number(process.env.TOKEN_WINDOW_DAYS) : 30;

export const TIER_LIMITS = {
  free: {
    // Daily rather than hourly on purpose — a 15/day bucket is easier for
    // a free user to understand and to actually exhaust gracefully than
    // an hourly one (which either resets too fast to mean anything, or
    // locks someone out mid-conversation for the rest of the hour).
    messagesPerDay: 15,
    maxTokens: 300000, // per rolling 30 days
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
    // Voice input: a small taste, not a feature free users can lean on.
    voicePerDay: 3,
    maxVoiceSeconds: 30,
    voiceSecondsPerDay: 90,
    extraPerDay: 0, // the Extra model tier is Premium-only (MODEL_TIER_MIN_PLAN in lib/ai.js)
    maxPerDay: 0, // the Max model tier is Pro+ (MODEL_TIER_MIN_PLAN in lib/ai.js)
  },
  pro: {
    messagesPerHour: 100,
    maxTokens: 1800000,
    maxFileBytes: 200 * 1024 * 1024,
    imageGenPerMonth: 10,
    maxImagesPerMessage: 10,
    maxAttachmentsPerChat: 100,
    thinkingPerDay: 15,
    // Lowered from 40 — was large enough that a handful of Pro users
    // alone could exceed Tavily's whole 1,000/month pool in a single day
    // if SearXNG had a bad stretch. See the searchPerDay comment above.
    searchPerDay: 15,
    voicePerDay: 30,
    maxVoiceSeconds: 90,
    voiceSecondsPerDay: 1200, // 20 minutes of audio a day
    extraPerDay: 0,
    maxPerDay: null, // null = no per-user cap on Max replies (only trials set one — see TRIAL_KINDS)
  },
  premium: {
    // Not mathematically infinite — a very high finite ceiling reads as
    // "unlimited" in practice without the edge cases an actual Infinity
    // could cause in storage/serialization.
    messagesPerHour: 1000,
    maxTokens: 4500000,
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
    voicePerDay: 100,
    // Bounded by the 4.5MB request-body limit on Vercel functions, not by
    // Whisper (see MAX_VOICE_BYTES in api/miniapp/transcribe.js) — don't
    // raise this past ~180 without switching that endpoint to Blob uploads.
    maxVoiceSeconds: 180,
    voiceSecondsPerDay: 3600, // 1 hour of audio a day
    extraPerDay: 10, // replies on the Extra model tier per rolling 24h (see checkExtraLimit)
    maxPerDay: null,
  },
};

// ---------------------------------------------------------------------------
// Trials (see lib/trials.js for how they start, are counted and are capped)
// ---------------------------------------------------------------------------
//
// A trial is a real Pro/Premium subscription row, so it unlocks that plan's
// tiers and features — but its numbers are deliberately NOT the paid plan's.
// The shared free infrastructure (Mistral's $10 credit, Gemini's few requests a
// day) can't carry a full Pro or Premium allowance for every trial user, so:
//   - maxTokens = the user's own FREE allowance + extraTokens, because tokens
//     already used in the rolling 30 days count against it (a flat cap could
//     lock someone out the moment they start);
//   - maxPerDay caps replies served by the Max model (Mistral Large 3, the
//     expensive one) per rolling 24h; over the cap a reply runs on Standard;
//   - overrides lower the other per-day caps that draw on shared quotas.
// The clock starts when the user taps Start, not at signup, so a trial never
// runs out before they knew it was on.
const MB = 1024 * 1024;
const envInt = (name, fallback) => (Number(process.env[name]) > 0 ? Math.floor(Number(process.env[name])) : fallback);
export const TRIAL_DAILY_START_CAP = envInt("TRIAL_DAILY_START_CAP", 20); // new trials started per rolling 24h, all users together
export const TRIAL_KINDS = {
  pro_promo: {
    plan: "pro",
    label: "Pro",
    days: 14,
    slots: envInt("PRO_PROMO_SLOTS", 100), // first N activations ever
    extraTokens: 300000,
    overrides: { maxPerDay: 2, thinkingPerDay: 5, searchPerDay: 5, voicePerDay: 10, voiceSecondsPerDay: 300, imageGenPerMonth: 5, maxFileBytes: 50 * MB },
  },
  premium_trial: {
    plan: "premium",
    label: "Premium",
    days: 3,
    slots: null, // once per account, no overall limit (the daily start cap protects the budget)
    extraTokens: 150000,
    overrides: { maxPerDay: 5, extraPerDay: 3, thinkingPerDay: 10, searchPerDay: 10, voicePerDay: 20, voiceSecondsPerDay: 600, imageGenPerMonth: 10, maxFileBytes: 100 * MB },
  },
};

// Free tier's numbers get topped up by the referral ladder (see
// lib/referrals.js) —
// Pro/Premium are already generous enough that neither bonus is the
// point for them, so they're returned as-is.
async function freeLimitsWithBonus(telegramUserId) {
  const base = TIER_LIMITS.free;
  const creditedReferrals = await getCreditedReferralCount(telegramUserId);
  const bonus = getReferralBonus(creditedReferrals);
  return {
    ...base,
    messagesPerDay: base.messagesPerDay + bonus.messagesPerDay,
    maxTokens: base.maxTokens + bonus.maxTokens,
    maxFileBytes: base.maxFileBytes + bonus.maxFileBytes,
    imageGenPerMonth: base.imageGenPerMonth + bonus.imageGenPerMonth,
    maxAttachmentsPerChat: base.maxAttachmentsPerChat + bonus.maxAttachmentsPerChat,
  };
}

export async function limitsFor(telegramUserId) {
  const info = await getSubscriptionInfo(telegramUserId);
  if (info.tier === "free") return freeLimitsWithBonus(telegramUserId);
  const base = TIER_LIMITS[info.tier] || TIER_LIMITS.free;
  const trial = info.isTrial ? TRIAL_KINDS[info.trialKind] : null; // the 100-invite "referral_trial" keeps full Pro numbers
  if (!trial) return base;
  const free = await freeLimitsWithBonus(telegramUserId);
  return { ...base, ...trial.overrides, maxTokens: free.maxTokens + trial.extraTokens };
}

// ---------------------------------------------------------------------------
// Max model tier — per-user daily cap, set only for trials
// ---------------------------------------------------------------------------
// Max (Mistral Large 3) is the costly model: ~$0.0014 an exchange against a
// shared $10/month credit (see lib/providerBudget.js). Paid plans have no
// per-user cap (maxPerDay: null); trials do. Counted only when a reply was
// really served by that model (messages.js), so falling back to Standard
// costs the user nothing. Over the cap isn't an error — the reply runs on
// Standard and says so.
export async function recordMaxUsage(telegramUserId) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "max_tier" });
}

export async function checkMaxLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  if (limits.maxPerDay == null) return { allowed: true };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(and(eq(usageEvents.telegramUserId, telegramUserId), eq(usageEvents.kind, "max_tier"), gte(usageEvents.createdAt, since)));
  if (count >= limits.maxPerDay) {
    return {
      allowed: false,
      reason: `You've used all ${limits.maxPerDay} Max replies your trial allows per day (rolling 24 hours) — this reply used Standard instead.`,
    };
  }
  return { allowed: true };
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

// ---------------------------------------------------------------------------
// Voice-to-text
// ---------------------------------------------------------------------------

// Groq's free Whisper plan (per ACCOUNT, i.e. shared by every user of this
// bot) allows 20 requests/minute, 2,000 requests/day, 7,200 audio-seconds/hour
// and 28,800 audio-seconds/day, and counts every request as at least 10
// seconds. Whichever limit is hit first blocks everyone, and the requests cap
// alone is NOT enough: 28,800s / 1,200 requests is only 24s per clip, so a
// handful of long Pro/Premium clips would exhaust the seconds first. So we
// budget all three, each at 60% so a burst can't exhaust the account and the
// same Groq key's other uses aren't starved. If you move to Groq's paid
// Developer plan, raise these. Source for the numbers: Groq's rate-limit page
// (console.groq.com/docs/rate-limits) — your org's Limits page in the Groq
// console is authoritative and can differ.
export const VOICE_SITE_DAILY_CAP = 1200; // requests / rolling day (Groq: 2,000)
export const VOICE_SITE_DAILY_SECONDS = 17280; // billed audio seconds / day (Groq: 28,800)
export const VOICE_SITE_HOURLY_SECONDS = 4320; // billed audio seconds / hour (Groq: 7,200)
export const VOICE_MIN_BILLED_SECONDS = 10; // Groq bills/counts at least 10s per request

// What one transcription counts against the budgets above.
export function billedVoiceSeconds(seconds) {
  return Math.max(VOICE_MIN_BILLED_SECONDS, Math.ceil(Number(seconds) || 0));
}

export async function recordVoiceUsage(telegramUserId, bytes, seconds) {
  await db.insert(usageEvents).values({
    telegramUserId,
    kind: "voice",
    bytes: bytes ?? null,
    seconds: billedVoiceSeconds(seconds),
  });
}

async function voiceUsageSince(since, telegramUserId) {
  const conditions = [eq(usageEvents.kind, "voice"), gte(usageEvents.createdAt, since)];
  if (telegramUserId !== undefined) conditions.push(eq(usageEvents.telegramUserId, telegramUserId));
  const [row] = await db
    .select({
      count: sql`count(*)`.mapWith(Number),
      seconds: sql`coalesce(sum(${usageEvents.seconds}), 0)`.mapWith(Number),
    })
    .from(usageEvents)
    .where(and(...conditions));
  return row;
}

export async function countVoiceLast24h(telegramUserId) {
  return (await voiceUsageSince(new Date(Date.now() - 24 * 60 * 60 * 1000), telegramUserId)).count;
}

// Site-wide, not per-user — same idea as canUseGeminiGroundingFallback.
// `seconds` is what the clip about to be transcribed would add.
export async function canUseVoiceTranscription(seconds = VOICE_MIN_BILLED_SECONDS) {
  const [day, hour] = await Promise.all([
    voiceUsageSince(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    voiceUsageSince(new Date(Date.now() - 60 * 60 * 1000)),
  ]);
  const add = billedVoiceSeconds(seconds);
  return (
    day.count < VOICE_SITE_DAILY_CAP &&
    day.seconds + add <= VOICE_SITE_DAILY_SECONDS &&
    hour.seconds + add <= VOICE_SITE_HOURLY_SECONDS
  );
}

// Call before downloading/transcribing anything. seconds is the clip length
// if the caller knows it (Telegram tells us; the mini app reports it, and
// api/miniapp/transcribe.js never lets it fall below a size-based estimate).
export async function checkVoiceLimit(telegramUserId, seconds) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);

  if (!limits.voicePerDay) {
    return { allowed: false, reason: "🎤 Voice input is a Pro feature. /upgrade to unlock it." };
  }
  if (seconds && seconds > limits.maxVoiceSeconds) {
    return {
      allowed: false,
      reason: `🎤 That recording is too long — your plan allows up to ${limits.maxVoiceSeconds} seconds per voice message. /upgrade for longer ones.`,
    };
  }
  const usedToday = await voiceUsageSince(new Date(Date.now() - 24 * 60 * 60 * 1000), telegramUserId);
  if (usedToday.count >= limits.voicePerDay) {
    return {
      allowed: false,
      reason: `🎤 You've used all ${limits.voicePerDay} voice messages for today — resets on a rolling 24 hours. /upgrade for more.`,
    };
  }
  if (usedToday.seconds + billedVoiceSeconds(seconds) > limits.voiceSecondsPerDay) {
    return {
      allowed: false,
      reason: `🎤 You've reached today's voice limit (${Math.round(limits.voiceSecondsPerDay / 60)} min of audio) — it resets on a rolling 24 hours. /upgrade for more.`,
    };
  }
  if (!(await canUseVoiceTranscription(seconds))) {
    return { allowed: false, reason: "🎤 Voice input is very busy right now — please type it instead, or try again later." };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Extra model tier (Gemini 3.8 Flash / 2.5 Pro on the free Gemini quota)
// ---------------------------------------------------------------------------
//
// Extra runs on Google's free tier. On this project each Gemini Flash model
// allows only 20 requests/day for ALL users together, and Extra chains four
// of them (EXTRA_GEMINI_MODELS in lib/ai.js) — about 80 replies a day in
// total, shared by every Premium user. Two budgets keep one heavy user from
// using it all up:
//   - extraPerDay (TIER_LIMITS above): per user, rolling 24h.
//   - EXTRA_SITE_DAILY_CAP: everyone together, default 60 — a cushion under
//     the ~80 so a burst doesn't leave nothing for the rest of the day. If
//     you change the model list or your AI Studio numbers change, set the
//     EXTRA_SITE_DAILY_CAP env var to roughly 3/4 of (models x daily limit).
// Only replies actually answered by a Gemini model are counted (see
// messages.js) — if Extra fell back to Max's model, no Gemini quota was used.
// Hitting either limit never errors: the reply simply runs on Max instead,
// with a one-line note saying so.
export const EXTRA_SITE_DAILY_CAP = Number(process.env.EXTRA_SITE_DAILY_CAP) > 0 ? Number(process.env.EXTRA_SITE_DAILY_CAP) : 60;

export async function recordExtraUsage(telegramUserId) {
  await db.insert(usageEvents).values({ telegramUserId, kind: "extra" });
}

async function extraCountSince(since, telegramUserId) {
  const conditions = [eq(usageEvents.kind, "extra"), gte(usageEvents.createdAt, since)];
  if (telegramUserId !== undefined) conditions.push(eq(usageEvents.telegramUserId, telegramUserId));
  const [{ count }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(usageEvents)
    .where(and(...conditions));
  return count;
}

export async function checkExtraLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const limits = await limitsFor(telegramUserId);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [mine, everyone] = await Promise.all([
    limits.extraPerDay ? extraCountSince(since, telegramUserId) : Promise.resolve(0),
    extraCountSince(since),
  ]);
  if (!limits.extraPerDay || mine >= limits.extraPerDay) {
    return {
      allowed: false,
      reason: `You've used all ${limits.extraPerDay || 0} Extra replies for today (resets on a rolling 24 hours) — this reply used Max instead.`,
    };
  }
  if (everyone >= EXTRA_SITE_DAILY_CAP) {
    return { allowed: false, reason: "Extra is very busy right now — this reply used Max instead." };
  }
  return { allowed: true };
}

// Plan-gating for file types (see lib/fileTypes.js for which extension sits
// on which plan). Unknown types pass through here — lib/attachments.js (and
// the DM handler) already say "I can't read that" for those.
export async function checkFileTypeAllowed(telegramUserId, name, mime) {
  if (isOwner(telegramUserId)) return { allowed: true };
  const cls = classifyFile(name, mime);
  if (!cls || cls.minPlan === "free") return { allowed: true };
  const tier = await getUserTier(telegramUserId);
  if (tier === "free") {
    return {
      allowed: false,
      reason: `📎 .${cls.ext} files are available on Pro and Premium. Free plans can attach images, PDF, Word, and text/Markdown/CSV files — /upgrade to unlock more.`,
    };
  }
  return { allowed: true };
}

export async function getUsageSummary(telegramUserId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const tokenSince = new Date(Date.now() - TOKEN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [messagesLastHour, messagesLast24h] = await Promise.all([
    countMessagesSince(telegramUserId, oneHourAgo),
    countMessagesSince(telegramUserId, oneDayAgo),
  ]);

  const [{ total: tokensInWindow }] = await db
    .select({ total: sql`coalesce(sum(${usageEvents.tokens}), 0)`.mapWith(Number) })
    .from(usageEvents)
    .where(and(eq(usageEvents.telegramUserId, telegramUserId), gte(usageEvents.createdAt, tokenSince)));

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

  return { messagesLastHour, messagesLast24h, tokensInWindow, imagesLast30Days, thinkingLast24h, searchLast24h };
}

// ---------------------------------------------------------------------------
// "When does room free up?" — for the countdown on a full usage bar
// ---------------------------------------------------------------------------
// Every window here is ROLLING, so a full bar doesn't "reset" all at once: each
// event ages out on its own schedule. These return the moment the person drops
// back under the limit (room for one more message / enough tokens for the
// next one), or null if they aren't at the limit. They only run when a bar is
// actually full, so the extra query costs nothing on a normal request.
export async function messagesFreeAt(telegramUserId, windowMs, limit) {
  const since = new Date(Date.now() - windowMs);
  const rows = await db
    .select({ at: usageEvents.createdAt })
    .from(usageEvents)
    .where(and(eq(usageEvents.telegramUserId, telegramUserId), eq(usageEvents.kind, "message"), gte(usageEvents.createdAt, since)))
    .orderBy(asc(usageEvents.createdAt));
  const excess = rows.length - limit; // drop excess + 1 of the oldest to get back under
  if (excess < 0) return null;
  return new Date(rows[excess].at.getTime() + windowMs);
}

export async function tokensFreeAt(telegramUserId, windowMs, maxTokens) {
  const since = new Date(Date.now() - windowMs);
  const rows = await db
    .select({ at: usageEvents.createdAt, tokens: usageEvents.tokens })
    .from(usageEvents)
    .where(and(eq(usageEvents.telegramUserId, telegramUserId), gte(usageEvents.createdAt, since), sql`${usageEvents.tokens} > 0`))
    .orderBy(asc(usageEvents.createdAt));
  let total = rows.reduce((sum, r) => sum + r.tokens, 0);
  if (total < maxTokens) return null;
  for (const r of rows) {
    total -= r.tokens;
    if (total < maxTokens) return new Date(r.at.getTime() + windowMs);
  }
  return null;
}

// Call before making the AI call — returns { allowed: false, reason } if
// over either cap, so the caller can show that instead of spending an AI
// call it's just going to refuse to use anyway.
export async function checkMessageLimit(telegramUserId) {
  if (isOwner(telegramUserId)) return { allowed: true };

  const tier = await getUserTier(telegramUserId);
  const limits = await limitsFor(telegramUserId);
  const { messagesLastHour, messagesLast24h, tokensInWindow } = await getUsageSummary(telegramUserId);

  // Free tier is a daily bucket; Pro/Premium are the rolling hourly one.
  if (tier === "free") {
    if (messagesLast24h >= limits.messagesPerDay) {
      return {
        allowed: false,
        reason: `You've hit your limit of ${limits.messagesPerDay} messages per rolling 24 hours — a slot frees up 24 hours after each message you sent. /upgrade for a higher limit.`,
      };
    }
  } else if (messagesLastHour >= limits.messagesPerHour) {
    return {
      allowed: false,
      reason: `You've hit your limit of ${limits.messagesPerHour} messages per hour. Try again in a bit, or /upgrade for a higher limit.`,
    };
  }
  if (tokensInWindow >= limits.maxTokens) {
    return {
      allowed: false,
      reason: `You've used all ${limits.maxTokens.toLocaleString()} tokens for this ${TOKEN_WINDOW_DAYS === 1 ? "day" : `${TOKEN_WINDOW_DAYS}-day period`} — it frees up gradually as older usage ages out. /upgrade for more.`,
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
