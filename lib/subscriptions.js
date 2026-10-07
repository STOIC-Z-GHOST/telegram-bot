// lib/subscriptions.js
//
// Tracks Pro/Premium subscriptions paid via Telegram Stars. A user with no
// row here (or a row whose expiresAt has passed) is on the free tier —
// there's no explicit cancellation flow to handle. Telegram's own UI lets
// a user cancel their subscription any time; when they do (or a renewal
// charge fails), no new successful_payment arrives, expiresAt eventually
// passes, and getUserTier() naturally falls back to "free" on its own.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { subscriptions, planPrices } from "../db/schema.js";
import { isOwner } from "./access.js";

// Telegram Stars subscriptions are locked to exactly 30 days per renewal —
// not our choice, that's a hard constraint of createInvoiceLink/sendInvoice.
export const SUBSCRIPTION_PERIOD_SECONDS = 2592000;

// Telegram's own hard limit on a single Stars price.
export const MAX_PRICE_STARS = 2500;

// Used only until a real row exists in plan_prices — /setprice writes
// there, so after the first price change these defaults are never read
// again for that tier.
const FALLBACK_PRICES_STARS = {
  pro: 300, // ~$3/month
  premium: 600, // ~$6/month
};

export async function getTierPrices() {
  const rows = await db.select().from(planPrices);
  const prices = { ...FALLBACK_PRICES_STARS };
  for (const row of rows) prices[row.tier] = row.priceStars;
  return prices;
}

export async function setTierPrice(tier, priceStars) {
  await db
    .insert(planPrices)
    .values({ tier, priceStars })
    .onConflictDoUpdate({
      target: planPrices.tier,
      set: { priceStars, updatedAt: new Date() },
    });
}

const TIER_RANK = { free: 0, pro: 1, premium: 2, owner: 3 };

// True if buying `requestedTier` would put someone on a LOWER plan than the
// one they already have (e.g. a Premium user tapping Pro) — checkout would
// otherwise charge them and overwrite their tier with the cheaper one.
export function isDowngrade(currentTier, requestedTier) {
  return (TIER_RANK[requestedTier] ?? 0) < (TIER_RANK[currentTier] ?? 0);
}

// Trials are ordinary subscription rows whose charge id says so, so every
// existing "what tier is this person on" path keeps working unchanged:
//   "trial:pro_promo" / "trial:premium_trial" — started from the Plan sheet
//   "referral_trial"                          — the 100-invite 3-day Pro trial
// A real Telegram payment overwrites the row with a real charge id, which is
// what turns a trial into a paid plan (and forfeits the trial's leftover days).
export function trialChargeId(kind) {
  return `trial:${kind}`;
}

// { tier, isTrial, trialKind, expiresAt } — tier is the EFFECTIVE tier (a
// Pro trial is "pro"); use getPaidTier when you need what they actually pay for.
export async function getSubscriptionInfo(telegramUserId) {
  if (isOwner(telegramUserId)) return { tier: "owner", isTrial: false, trialKind: null, expiresAt: null };
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.telegramUserId, telegramUserId));
  if (sub && sub.status === "active" && sub.expiresAt && sub.expiresAt > new Date()) {
    const charge = sub.telegramChargeId || "";
    const isTrial = charge.startsWith("trial:") || charge === "referral_trial";
    const trialKind = charge.startsWith("trial:") ? charge.slice("trial:".length) : charge === "referral_trial" ? "referral_trial" : null;
    return { tier: sub.tier, isTrial, trialKind, expiresAt: sub.expiresAt }; // tier: "pro" | "premium"
  }
  return { tier: "free", isTrial: false, trialKind: null, expiresAt: null };
}

export async function getUserTier(telegramUserId) {
  return (await getSubscriptionInfo(telegramUserId)).tier;
}

// What the person is actually PAYING for: "free" while on a trial. Used for the
// checkout downgrade guard, so someone on a Premium trial can still buy Pro.
export async function getPaidTier(telegramUserId) {
  const info = await getSubscriptionInfo(telegramUserId);
  return info.isTrial ? "free" : info.tier;
}

// Called from the successful_payment handler — for both a brand-new
// subscription and every 30-day renewal (Telegram sends a fresh
// successful_payment for each, which is why this just upserts rather than
// requiring a "first payment" special case).
export async function activateSubscription(telegramUserId, tier, chargeId, expiresAt) {
  await db
    .insert(subscriptions)
    .values({ telegramUserId, tier, status: "active", telegramChargeId: chargeId, expiresAt })
    .onConflictDoUpdate({
      target: subscriptions.telegramUserId,
      set: { tier, status: "active", telegramChargeId: chargeId, expiresAt, updatedAt: new Date() },
    });
}
