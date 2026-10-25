// Early access: the first few people get a higher plan (default Premium) so their first impression is the best the bot can give,
// and you can switch it off, shrink it or change its plan later without touching code or anyone's subscription.
//
// Everything is controlled from the environment:
//   EARLY_ACCESS_SLOTS  how many people can ever be let in. 0 or unset = early access is OFF for everyone, right now.
//                       Raising it lets more people in; lowering it below the number already let in closes the door but does
//                       NOT remove anyone; only setting it to 0 (or passing EARLY_ACCESS_ENDS) ends it for everyone.
//   EARLY_ACCESS_PLAN   "premium" (default) or "pro" — what early-access people get. Changing it moves all of them at once.
//   EARLY_ACCESS_ENDS   optional date (2026-12-01): after it, early access is over for everyone, nobody is asked anything.
// Nobody keeps early access by accident: people who pay for a plan that is at least as good simply use their paid plan, and
// when early access ends everyone falls back to what they really have (Free, a trial, or a paid subscription).
//
// How a person gets in: the first time they use the bot while places are left, a row is written to the early_access table
// (db/migrate_early_access_v17.sql). The row records WHEN they got in; the plan always comes from EARLY_ACCESS_PLAN.
// Fails safe: if the database can't be read, nobody gets early access (the bot never gives away a plan by mistake).

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { getUserTier, getSubscriptionInfo } from "./subscriptions.js";

const RANK = { free: 0, pro: 1, premium: 2 };
const CACHE_MS = 60 * 1000; // plan lookups happen on every message; this keeps them off the database for a minute at a time

export function earlyAccessConfig(env = process.env, now = new Date()) {
  const slots = Math.max(0, parseInt(env.EARLY_ACCESS_SLOTS || "0", 10) || 0);
  const plan = String(env.EARLY_ACCESS_PLAN || "premium").trim().toLowerCase() === "pro" ? "pro" : "premium";
  const endsRaw = String(env.EARLY_ACCESS_ENDS || "").trim();
  const endsAt = endsRaw ? new Date(endsRaw) : null;
  const endsInvalid = !!endsRaw && Number.isNaN(endsAt.getTime());
  const ended = !!endsAt && !endsInvalid && now >= endsAt;
  // An unreadable end date turns early access OFF (loudly) rather than letting it run forever by accident.
  if (endsInvalid) console.error(`EARLY_ACCESS_ENDS="${endsRaw}" is not a date (use 2026-12-01) — early access is switched off until it is fixed.`);
  return { slots, plan, endsAt: endsAt && !endsInvalid ? endsAt : null, ended, enabled: slots > 0 && !ended && !endsInvalid };
}

// The better of a person's real plan and the early-access plan (the owner is never touched).
export function higherTier(realTier, earlyTier) {
  if (realTier === "owner" || !earlyTier) return realTier;
  return (RANK[earlyTier] ?? 0) > (RANK[realTier] ?? 0) ? earlyTier : realTier;
}

// Same idea for the fuller subscription record. An early-access plan replaces Free and any trial that is not better; a paid plan
// that is as good or better is left exactly as it was.
export function effectiveInfo(info, earlyTier) {
  if (!earlyTier || !info || info.tier === "owner") return info;
  if ((RANK[info.tier] ?? 0) > (RANK[earlyTier] ?? 0)) return info;
  if (info.tier === earlyTier && !info.isTrial) return info; // a real paid plan of the same level
  return { ...info, tier: earlyTier, isTrial: false, trialKind: null, isEarlyAccess: true };
}

const rowsOf = (result) => (Array.isArray(result) ? result : result?.rows ?? []);

export const depsFor = (database) => ({
  async readRow(telegramUserId) {
    const r = await database.execute(sql`SELECT telegram_user_id FROM early_access WHERE telegram_user_id = ${telegramUserId}::bigint`);
    return rowsOf(r).length > 0;
  },
  // One statement: insert only while the table still has room. (Two people arriving in the same instant can both get in:
  // the count is checked per statement, not locked, so the total can overshoot by a person or two — harmless.)
  async grant(telegramUserId, slots) {
    const r = await database.execute(sql`
      INSERT INTO early_access (telegram_user_id)
      SELECT ${telegramUserId}::bigint
      WHERE (SELECT count(*) FROM early_access) < ${slots}
      ON CONFLICT (telegram_user_id) DO NOTHING
      RETURNING telegram_user_id`);
    return rowsOf(r).length > 0;
  },
  async taken() {
    const r = await database.execute(sql`SELECT count(*)::int AS n FROM early_access`);
    return Number(rowsOf(r)[0]?.n ?? 0);
  },
});
export const realDeps = depsFor(db);

const cache = new Map(); // telegramUserId -> { tier, at }
export function clearEarlyAccessCache() { cache.clear(); }

// null = no early access for this person right now; otherwise the plan they get.
export async function earlyAccessTierWith(deps, telegramUserId, { env = process.env, now = new Date(), useCache = true } = {}) {
  const cfg = earlyAccessConfig(env, now);
  if (!cfg.enabled) return null;
  const hit = useCache ? cache.get(telegramUserId) : null;
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.tier;
  let tier = null;
  try {
    if (await deps.readRow(telegramUserId)) tier = cfg.plan;
    else if (await deps.grant(telegramUserId, cfg.slots)) tier = cfg.plan;
  } catch (err) {
    console.error("early access lookup failed (no early access this time):", err.message);
    return null; // fail safe, and do not cache a failure
  }
  if (useCache) cache.set(telegramUserId, { tier, at: now.getTime() });
  return tier;
}

export const earlyAccessTier = (telegramUserId) => earlyAccessTierWith(realDeps, telegramUserId);

// ---- drop-in replacements for getUserTier / getSubscriptionInfo (lib/subscriptions.js): same answers, plus early access
export async function getEffectiveTier(telegramUserId) {
  const real = await getUserTier(telegramUserId);
  if (real === "owner") return real;
  return higherTier(real, await earlyAccessTier(telegramUserId));
}

export async function getEffectiveSubscriptionInfo(telegramUserId) {
  const info = await getSubscriptionInfo(telegramUserId);
  if (!info || info.tier === "owner") return info;
  return effectiveInfo(info, await earlyAccessTier(telegramUserId));
}

// For the owner's /early command and anything else that wants the numbers.
export async function earlyAccessStatus(deps = realDeps, env = process.env, now = new Date()) {
  const cfg = earlyAccessConfig(env, now);
  let taken = null;
  try { taken = await deps.taken(); } catch { /* the table may not exist yet */ }
  return { ...cfg, taken };
}

// The owner's /early command: one plain-English line about where early access stands.
export function formatEarlyAccessStatus(st) {
  const planName = st.plan === "pro" ? "Pro" : "Premium";
  const places = st.taken == null ? "(couldn't read the early_access table — has migrate_early_access_v17.sql been run?)" : `${st.taken} of ${st.slots} places taken`;
  if (st.endsAt && st.ended) return `Early access is OFF: it ended on ${st.endsAt.toISOString().slice(0, 10)}. Everyone is on the plan they really have. (${st.taken ?? "?"} people had been let in.)`;
  if (st.slots <= 0) return `Early access is OFF (EARLY_ACCESS_SLOTS is 0 or not set), so everyone is on the plan they really have.${st.taken ? ` ${st.taken} people had been let in earlier.` : ""}`;
  const end = st.endsAt ? `It ends on ${st.endsAt.toISOString().slice(0, 10)}.` : "It has no end date; set EARLY_ACCESS_SLOTS=0 to end it.";
  const full = st.taken != null && st.taken >= st.slots ? " All places are taken; new people start on Free." : "";
  return `Early access is ON: ${places}. Everyone let in gets ${planName}.${full} ${end}`;
}
