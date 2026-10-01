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

export async function getUserTier(telegramUserId) {
  if (isOwner(telegramUserId)) return "owner";
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.telegramUserId, telegramUserId));
  if (sub && sub.status === "active" && sub.expiresAt && sub.expiresAt > new Date()) {
    return sub.tier; // "pro" | "premium"
  }
  return "free";
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
