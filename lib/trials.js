// lib/trials.js
//
// The two trials a user can start themselves from the Plan sheet:
//   pro_promo      14 days of Pro, for the first 100 activations ever
//   premium_trial   3 days of Premium, once per account
//
// Rules (all enforced here, on the server — the UI only mirrors them):
//   - The clock starts when the user taps Start, not at signup, so a trial
//     can't run out before they knew it was on.
//   - Each kind is claimable once per account (plan_trials primary key).
//   - Not while on a paid plan, and not while another trial is running.
//   - The Pro promo counts ACTIVATIONS, not signups, so unclaimed spots aren't
//     wasted and the budget maths stays exact.
//   - TRIAL_DAILY_START_CAP new trials per rolling 24h across all users, which
//     bounds what second accounts can cost the shared free quotas.
// What a trial user may actually USE is capped in lib/limits.js (TRIAL_KINDS).
// A trial is a normal subscriptions row (charge id "trial:<kind>"), so the rest
// of the app sees an ordinary Pro/Premium user; a real Stars payment simply
// overwrites it.

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { planTrials } from "../db/schema.js";
import { isOwner } from "./access.js";
import { getSubscriptionInfo, activateSubscription, trialChargeId } from "./subscriptions.js";
import { TRIAL_KINDS, TRIAL_DAILY_START_CAP } from "./limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFER_KIND = { pro: "pro_promo", premium: "premium_trial" };

export const TRIAL_REASON_TEXT = {
  paid_plan: "You're already on a paid plan.",
  trial_active: "You already have a trial running.",
  already_used: "You've already used this trial.",
  slots_full: "All the free Pro spots have been taken.",
  daily_full: "Trial spots are full for today — try again tomorrow.",
  owner: "You're the owner — no limits to raise.",
  unknown_plan: "Unknown plan.",
};

async function countWhere(condition) {
  const [{ n }] = await db
    .select({ n: sql`count(*)`.mapWith(Number) })
    .from(planTrials)
    .where(condition);
  return n;
}

function daysLeftFrom(expiresAt) {
  return Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS));
}

// Everything the Plan sheet needs: what's running now, and for each plan
// whether a trial can be started (and if not, why).
export async function getTrialStatus(telegramUserId) {
  const info = await getSubscriptionInfo(telegramUserId);
  const active =
    info.isTrial && info.expiresAt
      ? { kind: info.trialKind, plan: info.tier, expiresAt: new Date(info.expiresAt).toISOString(), daysLeft: daysLeftFrom(info.expiresAt) }
      : null;
  const paid = info.tier !== "free" && !info.isTrial;

  const [mine, proUsed, startsToday] = await Promise.all([
    db.select({ kind: planTrials.kind }).from(planTrials).where(eq(planTrials.telegramUserId, telegramUserId)),
    countWhere(eq(planTrials.kind, "pro_promo")),
    countWhere(gte(planTrials.startedAt, new Date(Date.now() - DAY_MS))),
  ]);
  const used = new Set(mine.map((r) => r.kind));

  const offers = {};
  for (const [plan, kind] of Object.entries(OFFER_KIND)) {
    const cfg = TRIAL_KINDS[kind];
    const slotsLeft = cfg.slots == null ? null : Math.max(0, cfg.slots - proUsed);
    let reason = null;
    if (paid) reason = "paid_plan";
    else if (active) reason = "trial_active";
    else if (used.has(kind)) reason = "already_used";
    else if (slotsLeft === 0) reason = "slots_full";
    else if (startsToday >= TRIAL_DAILY_START_CAP) reason = "daily_full";
    offers[plan] = {
      available: reason === null,
      reason,
      reasonText: reason ? TRIAL_REASON_TEXT[reason] : null,
      days: cfg.days,
      slotsLeft,
      slotsTotal: cfg.slots,
      extraTokens: cfg.extraTokens,
      caps: cfg.overrides,
    };
  }
  return { active, paid, offers };
}

// Returns { ok: true, kind, plan, expiresAt } or { ok: false, reason }.
export async function startTrial(telegramUserId, plan) {
  if (isOwner(telegramUserId)) return { ok: false, reason: "owner" };
  const kind = OFFER_KIND[plan];
  if (!kind) return { ok: false, reason: "unknown_plan" };

  const status = await getTrialStatus(telegramUserId);
  const offer = status.offers[plan];
  if (!offer.available) return { ok: false, reason: offer.reason };

  const cfg = TRIAL_KINDS[kind];
  const expiresAt = new Date(Date.now() + cfg.days * DAY_MS);

  // The primary key makes the claim itself atomic: a double-tap or a replayed
  // request inserts nothing the second time.
  const inserted = await db
    .insert(planTrials)
    .values({ telegramUserId, kind, expiresAt })
    .onConflictDoNothing()
    .returning({ kind: planTrials.kind });
  if (!inserted.length) return { ok: false, reason: "already_used" };

  // Spots: two people tapping for the last spot at once can both pass the
  // check above, so re-count after inserting and back out if over.
  if (cfg.slots != null) {
    const total = await countWhere(eq(planTrials.kind, kind));
    if (total > cfg.slots) {
      await db.delete(planTrials).where(and(eq(planTrials.telegramUserId, telegramUserId), eq(planTrials.kind, kind)));
      return { ok: false, reason: "slots_full" };
    }
  }

  try {
    await activateSubscription(telegramUserId, cfg.plan, trialChargeId(kind), expiresAt);
  } catch (err) {
    // Don't burn their one-time trial on a failed write.
    await db.delete(planTrials).where(and(eq(planTrials.telegramUserId, telegramUserId), eq(planTrials.kind, kind)));
    throw err;
  }
  return { ok: true, kind, plan: cfg.plan, expiresAt: expiresAt.toISOString() };
}
