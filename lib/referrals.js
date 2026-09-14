// lib/referrals.js
//
// Free-tier referral ladder. A referral is "pending" the moment someone
// opens the bot via another user's invite link (recordPendingReferral)
// and becomes "credited" the moment they send their first real message —
// not just the /start click (creditReferralIfPending). Only credited
// referrals count toward the ladder.
//
// Deliberately capped well below Pro/Premium on every axis — this is
// meant to reward and retain social free users, not replace paying for
// Pro. See TIER_LIMITS in lib/limits.js for what Pro/Premium actually get.

import { eq, and, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { referrals, referralTrials } from "../db/schema.js";
import { getUserTier, activateSubscription } from "./subscriptions.js";

// The ladder is a rolling window, not a lifetime total: only referrals
// credited within the last REFERRAL_WINDOW_DAYS count toward it. This is
// what gives it a natural, ongoing "reset" — someone's count quietly
// drifts back down as their old invites age out of the window, the same
// way the hourly/daily message limits already work in lib/limits.js — no
// cron job, no shared reset date, and nobody's count drops off a cliff on
// the same day as everyone else's. All credited rows stay in the table
// forever regardless (nothing is ever deleted) — this only affects what
// counts toward the *current* bonus, not the historical record.
const REFERRAL_WINDOW_DAYS = 60;

// A referrer can only have this many referrals credited in a rolling
// 24-hour window — not really an anti-fraud measure (Telegram accounts
// already require a real phone number, which is real friction on its
// own), just a brake on a burst of invites all landing at once and
// jumping someone up multiple tiers in a single afternoon. Any referral
// that arrives over the cap just stays pending and gets picked up again
// next time that referred user sends a message.
const DAILY_CREDIT_CAP = 5;

// A one-time, lifetime "thank you" for genuinely exceptional referring —
// separate from the rolling ladder above on purpose, since 100 *lifetime*
// credited invites is a much higher, rarer bar than 100 in any rolling
// window. Deliberately not part of REFERRAL_TIERS: it's a special event
// (grants real Pro access, briefly), not a permanent free-tier bump.
const REFERRAL_TRIAL_THRESHOLD = 100;
const REFERRAL_TRIAL_DAYS = 3;

// Cumulative — each tier's bonus stacks on top of every tier before it.
// Kept intentionally short of Pro (100 msgs/hr, 1M tokens, 200MB files,
// 10 img/mo, 100 attachments/chat) even at the very top, invite 100.
export const REFERRAL_TIERS = [
  { invites: 5, bonus: { messagesPerDay: 2 } },
  { invites: 15, bonus: { messagesPerDay: 5, imageGenPerMonth: 1 } },
  { invites: 25, bonus: { imageGenPerMonth: 2, maxAttachmentsPerChat: 2 } },
  { invites: 35, bonus: { maxTokens: 20000 } },
  { invites: 55, bonus: { messagesPerDay: 5 } },
  { invites: 75, bonus: { maxFileBytes: 2 * 1024 * 1024 } },
  { invites: 100, bonus: { maxAttachmentsPerChat: 1 } },
];

const ZERO_BONUS = { messagesPerDay: 0, imageGenPerMonth: 0, maxAttachmentsPerChat: 0, maxTokens: 0, maxFileBytes: 0 };

// Sums every tier the given credited-referral count has reached. Pure
// function of the count — callers pass in getCreditedReferralCount()'s
// result, this never touches the DB itself.
export function getReferralBonus(creditedCount) {
  const bonus = { ...ZERO_BONUS };
  for (const tier of REFERRAL_TIERS) {
    if (creditedCount < tier.invites) continue;
    for (const [key, value] of Object.entries(tier.bonus)) {
      bonus[key] += value;
    }
  }
  return bonus;
}

// For "X more invites to your next reward" messaging — null once every
// tier has been reached (the ladder tops out at 100).
export function getNextMilestone(creditedCount) {
  return REFERRAL_TIERS.find((tier) => tier.invites > creditedCount) || null;
}

export function referralCodeFor(telegramUserId) {
  return `ref_${telegramUserId}`;
}

// Shareable https://t.me/<bot>?start=ref_<id> link — null if
// TELEGRAM_BOT_USERNAME isn't set, so callers can fall back to the plain
// code. Centralized here so the DM bot's /invite and the mini app's
// Settings screen build the exact same link instead of each rolling
// their own.
export function inviteLinkFor(telegramUserId) {
  const username = process.env.TELEGRAM_BOT_USERNAME;
  return username ? `https://t.me/${username}?start=${referralCodeFor(telegramUserId)}` : null;
}

// Returns the referrer's id if the payload is a well-formed referral
// code, otherwise null. Guards against non-numeric or self-referral
// payloads here so callers don't have to.
export function parseReferralPayload(payload, referredId) {
  if (!payload || !payload.startsWith("ref_")) return null;
  const referrerId = Number(payload.slice(4));
  if (!Number.isInteger(referrerId) || referrerId <= 0) return null;
  if (referrerId === referredId) return null;
  return referrerId;
}

// Called once, when a brand-new (or returning, harmlessly) user opens the
// bot via someone's invite link. Only the first ever referral for a given
// referredId sticks — the unique constraint on referred_id means a second
// call for the same user is a silent no-op, so a user can't be re-attributed
// to a different referrer just by clicking another link later.
export async function recordPendingReferral(referrerId, referredId) {
  const [row] = await db
    .insert(referrals)
    .values({ referrerId, referredId })
    .onConflictDoNothing({ target: referrals.referredId })
    .returning();
  return row || null;
}

// Safe to call on every incoming message — a no-op unless this user is
// still an uncredited pending referral. Call this for anything past the
// initial /start click (see api/telegram-webhook.js).
export async function creditReferralIfPending(referredId) {
  const [pending] = await db.select().from(referrals).where(eq(referrals.referredId, referredId));
  if (!pending || pending.creditedAt) return null;

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ count: creditedToday }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(referrals)
    .where(and(eq(referrals.referrerId, pending.referrerId), gte(referrals.creditedAt, oneDayAgo)));
  if (creditedToday >= DAILY_CREDIT_CAP) return null; // retried on this user's next message

  const [updated] = await db
    .update(referrals)
    .set({ creditedAt: new Date() })
    .where(eq(referrals.id, pending.id))
    .returning();
  return updated;
}

// Counts only referrals credited in the last REFERRAL_WINDOW_DAYS — see
// the comment on that constant above. This is what makes the whole ladder
// self-resetting without any scheduled job.
export async function getCreditedReferralCount(referrerId) {
  const windowStart = new Date(Date.now() - REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(referrals)
    .where(and(eq(referrals.referrerId, referrerId), isNotNull(referrals.creditedAt), gte(referrals.creditedAt, windowStart)));
  return count;
}

// Unlike getCreditedReferralCount, this is NOT windowed — it's every
// credited referral this user has ever earned. Only used to check the
// one-time 100-invite trial threshold below; the ladder bonus itself
// always uses the rolling, windowed count.
async function getLifetimeCreditedReferralCount(referrerId) {
  const [{ count }] = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(referrals)
    .where(and(eq(referrals.referrerId, referrerId), isNotNull(referrals.creditedAt)));
  return count;
}

// Call this right after a referral is credited (see
// api/telegram-webhook.js). Returns { expiresAt } if a trial was just
// granted, otherwise null — including when the referrer already got one
// before, or is already paying (a trial would be a downgrade risk for an
// existing Premium subscriber, and pointless for an existing Pro one, so
// this only ever fires for someone currently on free).
export async function maybeGrantReferralTrial(referrerId) {
  const lifetimeCount = await getLifetimeCreditedReferralCount(referrerId);
  if (lifetimeCount < REFERRAL_TRIAL_THRESHOLD) return null;

  const [alreadyGranted] = await db.select().from(referralTrials).where(eq(referralTrials.telegramUserId, referrerId));
  if (alreadyGranted) return null;

  const tier = await getUserTier(referrerId);
  if (tier !== "free") return null;

  const expiresAt = new Date(Date.now() + REFERRAL_TRIAL_DAYS * 24 * 60 * 60 * 1000);
  await activateSubscription(referrerId, "pro", "referral_trial", expiresAt);
  await db.insert(referralTrials).values({ telegramUserId: referrerId }).onConflictDoNothing();
  return { expiresAt };
}
