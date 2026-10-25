// Run from the project folder:  node --no-deprecation tests/earlyAccess.test.mjs
// Early access: the first N people get a higher plan, and every way of turning it down or off really works.

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { earlyAccessConfig, higherTier, effectiveInfo, earlyAccessTierWith, clearEarlyAccessCache, formatEarlyAccessStatus } = await import("../lib/earlyAccess.js");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

// a pretend early_access table
const table = () => {
  const rows = new Set();
  return {
    rows,
    deps: {
      async readRow(id) { return rows.has(id); },
      async grant(id, slots) { if (rows.size < slots && !rows.has(id)) { rows.add(id); return true; } return false; },
      async taken() { return rows.size; },
    },
  };
};
const at = (iso) => new Date(iso);
const opts = (env, now = at("2026-11-01T00:00:00Z")) => ({ env, now, useCache: false });

// ---- configuration
check("not set = OFF", earlyAccessConfig({}).enabled === false && earlyAccessConfig({ EARLY_ACCESS_SLOTS: "0" }).enabled === false);
check("a number of places turns it ON, plan defaults to premium", (() => { const c = earlyAccessConfig({ EARLY_ACCESS_SLOTS: "30" }); return c.enabled && c.slots === 30 && c.plan === "premium"; })());
check("the plan can be pro; anything else means premium", earlyAccessConfig({ EARLY_ACCESS_SLOTS: "5", EARLY_ACCESS_PLAN: "Pro" }).plan === "pro" && earlyAccessConfig({ EARLY_ACCESS_SLOTS: "5", EARLY_ACCESS_PLAN: "gold" }).plan === "premium");
check("junk in the places number means OFF, never 'unlimited'", earlyAccessConfig({ EARLY_ACCESS_SLOTS: "lots" }).enabled === false && earlyAccessConfig({ EARLY_ACCESS_SLOTS: "-4" }).enabled === false);
check("an end date in the future keeps it ON, in the past turns it OFF", earlyAccessConfig({ EARLY_ACCESS_SLOTS: "9", EARLY_ACCESS_ENDS: "2026-12-01" }, at("2026-11-01T00:00:00Z")).enabled === true && earlyAccessConfig({ EARLY_ACCESS_SLOTS: "9", EARLY_ACCESS_ENDS: "2026-12-01" }, at("2026-12-01T00:00:01Z")).enabled === false);
{ const e = console.error; console.error = () => {};
  check("an end date that isn't a date turns it OFF (it must not run forever by accident)", earlyAccessConfig({ EARLY_ACCESS_SLOTS: "9", EARLY_ACCESS_ENDS: "next week" }).enabled === false);
  console.error = e; }

// ---- who gets in
{
  const { rows, deps } = table();
  const env = { EARLY_ACCESS_SLOTS: "3" };
  const got = []; for (const id of [11, 22, 33, 44, 55]) got.push(await earlyAccessTierWith(deps, id, opts(env)));
  check("the first 3 people get premium, the 4th and 5th do not", got.join() === "premium,premium,premium,,", got.join("|"));
  check("someone already let in keeps it when places run out, and the table has exactly 3 rows", (await earlyAccessTierWith(deps, 22, opts(env))) === "premium" && rows.size === 3);
  check("lowering the places below the number already taken closes the door but removes nobody", (await earlyAccessTierWith(deps, 11, opts({ EARLY_ACCESS_SLOTS: "1" }))) === "premium" && (await earlyAccessTierWith(deps, 99, opts({ EARLY_ACCESS_SLOTS: "1" }))) === null);
  check("changing the plan moves everyone at once (no migration)", (await earlyAccessTierWith(deps, 11, opts({ EARLY_ACCESS_SLOTS: "3", EARLY_ACCESS_PLAN: "pro" }))) === "pro");
  check("SLOTS=0 ends it for everyone, including people already in", (await earlyAccessTierWith(deps, 11, opts({ EARLY_ACCESS_SLOTS: "0" }))) === null);
  check("passing the end date ends it for everyone", (await earlyAccessTierWith(deps, 11, opts({ EARLY_ACCESS_SLOTS: "3", EARLY_ACCESS_ENDS: "2026-10-30" }))) === null);
  const before = rows.size;
  await earlyAccessTierWith(deps, 777, opts({ EARLY_ACCESS_SLOTS: "0" }));
  check("while it is off nobody new is written to the table", rows.size === before && !rows.has(777));
}

// ---- failures are safe
{
  const broken = { async readRow() { throw new Error("relation early_access does not exist"); }, async grant() { throw new Error("nope"); } };
  const e = console.error; console.error = () => {};
  const t = await earlyAccessTierWith(broken, 1, opts({ EARLY_ACCESS_SLOTS: "5" }));
  console.error = e;
  check("if the table is missing or the database is down, nobody gets early access (and nothing throws)", t === null);
}

// ---- the cache keeps lookups off the database for a minute
{
  clearEarlyAccessCache();
  let reads = 0;
  const deps = { async readRow() { reads++; return true; }, async grant() { return false; } };
  const env = { EARLY_ACCESS_SLOTS: "2" };
  await earlyAccessTierWith(deps, 7, { env, now: at("2026-11-01T00:00:00Z") });
  await earlyAccessTierWith(deps, 7, { env, now: at("2026-11-01T00:00:30Z") });
  check("a second lookup within a minute does not touch the database", reads === 1);
  await earlyAccessTierWith(deps, 7, { env, now: at("2026-11-01T00:01:10Z") });
  check("after a minute it asks again", reads === 2);
  clearEarlyAccessCache();
}

// ---- combining with the real plan
check("free + early premium = premium; premium stays premium; pro + early premium = premium; paid premium + early pro stays premium", higherTier("free", "premium") === "premium" && higherTier("premium", "premium") === "premium" && higherTier("pro", "premium") === "premium" && higherTier("premium", "pro") === "premium");
check("no early access changes nothing, and the owner is never touched", higherTier("free", null) === "free" && higherTier("owner", "premium") === "owner");
{
  const free = { tier: "free", isTrial: false, trialKind: null };
  const e = effectiveInfo(free, "premium");
  check("Free becomes premium and says it is early access", e.tier === "premium" && e.isEarlyAccess === true && e.isTrial === false);
  const proTrial = { tier: "pro", isTrial: true, trialKind: "promo_trial", expiresAt: "x" };
  const e2 = effectiveInfo(proTrial, "premium");
  check("a Pro trial is replaced by early premium, with full (non-trial) limits", e2.tier === "premium" && e2.isTrial === false && e2.trialKind === null);
  const paidPremium = { tier: "premium", isTrial: false, trialKind: null, expiresAt: "y" };
  check("a real paid Premium subscription is left exactly as it was", effectiveInfo(paidPremium, "premium") === paidPremium && effectiveInfo(paidPremium, "pro") === paidPremium);
  const premTrial = { tier: "premium", isTrial: true, trialKind: "premium_trial" };
  check("a Premium trial under early premium becomes full premium (the trial's tighter numbers no longer apply)", effectiveInfo(premTrial, "premium").isTrial === false);
  check("nothing early = the record is returned untouched", effectiveInfo(free, null) === free && effectiveInfo({ tier: "owner" }, "premium").tier === "owner");
}

// ---- the owner's /early line
{
  const base = { slots: 50, plan: "premium", endsAt: null, ended: false, enabled: true, taken: 12 };
  check("/early: on, with places and no end date", /ON: 12 of 50 places taken.*Premium.*no end date/.test(formatEarlyAccessStatus(base)), formatEarlyAccessStatus(base));
  check("/early: full", /All places are taken/.test(formatEarlyAccessStatus({ ...base, taken: 50 })));
  check("/early: off by SLOTS=0", /OFF \(EARLY_ACCESS_SLOTS is 0/.test(formatEarlyAccessStatus({ ...base, slots: 0, enabled: false })));
  check("/early: off because the end date passed", /OFF: it ended on 2026-12-01/.test(formatEarlyAccessStatus({ ...base, endsAt: new Date("2026-12-01"), ended: true, enabled: false })));
  check("/early: a missing table is explained", /migrate_early_access_v17/.test(formatEarlyAccessStatus({ ...base, taken: null })));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
