// Run from the project folder:  node --no-deprecation tests/budgets.test.mjs
// Checks the Max-mode protections: per-user daily caps for paid plans, and Max's own slice of the shared
// Mistral credit. (Pure logic and wiring — no network, no database.)

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

// Config is read when the modules load, so each variation runs in a fresh process.
const probeFile = path.join(here, "_probe_budgets.mjs");
fs.writeFileSync(probeFile, `
process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { BUDGETS, budgetsOf } = await import("../lib/providerBudget.js");
const { TIER_LIMITS } = await import("../lib/limits.js");
const { providerCatalog } = await import("../lib/ai.js");
const rows = providerCatalog().openAiCompatible;
console.log(JSON.stringify({
  mistralCap: BUDGETS.mistral.cap, maxCap: BUDGETS.mistral_max.cap, maxKind: BUDGETS.mistral_max.kind, maxKindOverall: BUDGETS.mistral.kind,
  free: TIER_LIMITS.free.maxPerDay, pro: TIER_LIMITS.pro.maxPerDay, premium: TIER_LIMITS.premium.maxPerDay,
  maxBudgets: rows.filter((r) => r.tier === "max").map(budgetsOf),
  otherMistral: rows.filter((r) => /mistral/.test(r.baseUrl) && r.tier !== "max").map(budgetsOf),
  cloudflare: rows.filter((r) => /^Cloudflare/.test(r.name)).map(budgetsOf), // by name: with no CLOUDFLARE_* keys these have no base URL
  noBudget: budgetsOf({}), nothing: budgetsOf(undefined),
}));
`);
const run = (env = {}) => JSON.parse(execFileSync(process.execPath, ["--no-deprecation", probeFile], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());

try {
  // ---------- defaults
  const d = run();
  check("Max gets its own slice: $5 of the $8.50 Mistral credit", d.maxCap === 5_000_000 && d.mistralCap === 8_500_000, `${d.maxCap} / ${d.mistralCap}`);
  check("the slice is tracked separately from the pot (different usage_events kinds)", d.maxKind === "mistral_max_microusd" && d.maxKindOverall === "mistral_microusd" && d.maxKind !== d.maxKindOverall);
  check("at least $3 of the credit is always left for the cheap Mistral models", d.mistralCap - d.maxCap >= 3_000_000, `${(d.mistralCap - d.maxCap) / 1e6}`);
  check("Max draws on BOTH the pot and its slice", d.maxBudgets.length === 1 && d.maxBudgets[0].join() === "mistral,mistral_max", JSON.stringify(d.maxBudgets));
  check("cheap Mistral models draw only on the pot (so they keep working when Max's slice is spent)", d.otherMistral.length >= 3 && d.otherMistral.every((b) => b.join() === "mistral"), JSON.stringify(d.otherMistral));
  check("Cloudflare is unaffected", d.cloudflare.length >= 1 && d.cloudflare.every((b) => b.join() === "cloudflare"));
  check("a provider with no budget -> none", d.noBudget.length === 0 && d.nothing.length === 0);
  check("Free still has no Max; Pro 5/day and Premium 10/day by default (was: unlimited)", d.free === 0 && d.pro === 5 && d.premium === 10, `${d.free}/${d.pro}/${d.premium}`);
  check("Premium's cap is above Pro's, and both above the trials' (2 and 5)", d.premium > d.pro && d.pro > 2);

  // ---------- env overrides
  const o = run({ MISTRAL_MAX_BUDGET_USD: "3", MAX_PER_DAY_PRO: "3", MAX_PER_DAY_PREMIUM: "20" });
  check("MISTRAL_MAX_BUDGET_USD / MAX_PER_DAY_* override the defaults", o.maxCap === 3_000_000 && o.pro === 3 && o.premium === 20, JSON.stringify([o.maxCap, o.pro, o.premium]));
  const u = run({ MAX_PER_DAY_PRO: "unlimited", MAX_PER_DAY_PREMIUM: "NONE" });
  check("'unlimited' / 'none' (any case) removes a cap — for owners who've put Mistral on a paid plan", u.pro === null && u.premium === null, JSON.stringify([u.pro, u.premium]));
  const g = run({ MAX_PER_DAY_PRO: "abc", MAX_PER_DAY_PREMIUM: "-4" });
  check("garbage or negative values fall back to the safe defaults, not to 'no cap'", g.pro === 5 && g.premium === 10, JSON.stringify([g.pro, g.premium]));
  const z = run({ MAX_PER_DAY_PRO: "0" });
  check("0 is not accepted as 'no cap' (default stays)", z.pro === 5);
  const f = run({ MAX_PER_DAY_PRO: "7.9" });
  check("decimals round down", f.pro === 7);
  const e = run({ MISTRAL_MAX_BUDGET_USD: "" });
  check("empty budget override -> default", e.maxCap === 5_000_000);
} finally {
  fs.rmSync(probeFile, { force: true });
}

// ---------- the wiring: the provider gate and the spend tracker must use EVERY budget (guards a revert)
const ai = fs.readFileSync(path.join(root, "lib/ai.js"), "utf8");
const limits = fs.readFileSync(path.join(root, "lib/limits.js"), "utf8");
const gate = ai.slice(ai.indexOf("async function providerUsable"), ai.indexOf("async function trackSpend"));
const track = ai.slice(ai.indexOf("async function trackSpend"), ai.indexOf("async function trackSpend") + 700);
check("providerUsable checks every budget the provider draws on", /for \(const name of budgetsOf\(provider\)\)/.test(gate) && /hasBudget\(name\)/.test(gate));
check("trackSpend charges every budget (pot AND slice)", /const names = budgetsOf\(provider\)/.test(track) && /for \(const name of names\) await recordSpend\(name, cost\)/.test(track));
check("the Max provider declares the slice", /subBudget: "mistral_max"/.test(ai));
check("the Max-cap message no longer says 'trial' (paid users see it now)", !/your trial allows/.test(limits) && /Max replies you get per day/.test(limits));

// ---------- the numbers behind the "Max replies" bar (pure function; runs in a child process because limits.js needs a DB URL to load)
{
  const f = path.join(here, "_probe_window.mjs");
  fs.writeFileSync(f, `
process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { maxWindowStatus } = await import("../lib/limits.js");
const H = 3600e3, W = 24 * H, now = Date.UTC(2026, 9, 12, 12, 0, 0);
const ago = (h) => new Date(now - h * H);
const r = (list, cap) => { const x = maxWindowStatus(list, cap, W, now); return { used: x.used, resetAt: x.resetAt ? x.resetAt.getTime() - now : null }; };
console.log(JSON.stringify({
  empty: r([], 5),
  under: r([ago(1), ago(2), ago(3)], 5),
  exact: r([ago(1), ago(2), ago(3), ago(5), ago(10)], 5),          // oldest is 10h old -> frees in 14h
  over: r([ago(1), ago(2), ago(3), ago(5), ago(10), ago(11), ago(12)], 5), // 7 of 5 -> 3 must age out: the 3rd oldest (10h) -> 14h
  stale: r([ago(25), ago(30), ago(1)], 5),                          // older than 24h don't count
  unsorted: r([ago(3), ago(10), ago(1), ago(5), ago(2)], 5),
  nocap: r([ago(1), ago(2)], 0),
  asDates: maxWindowStatus([ago(1).toISOString(), ago(2).getTime()], 2, W, now).used,
}));
`);
  try {
    const o = JSON.parse(execFileSync(process.execPath, ["--no-deprecation", f], { env: { PATH: process.env.PATH }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
    check("Max bar: nothing used -> 0, no reset time", o.empty.used === 0 && o.empty.resetAt === null);
    check("Max bar: under the cap -> no reset time", o.under.used === 3 && o.under.resetAt === null);
    check("Max bar: exactly at the cap -> room frees when the OLDEST reply is 24h old", o.exact.used === 5 && o.exact.resetAt === 14 * 3600e3, String(o.exact.resetAt));
    check("Max bar: over the cap (cap lowered, or a trial ended) -> waits for enough replies to age out", o.over.used === 7 && o.over.resetAt === 14 * 3600e3, String(o.over.resetAt));
    check("Max bar: replies older than 24h are ignored", o.stale.used === 1 && o.stale.resetAt === null);
    check("Max bar: input order doesn't matter", o.unsorted.used === 5 && o.unsorted.resetAt === 14 * 3600e3);
    check("Max bar: a cap of 0 never shows a reset time", o.nocap.resetAt === null);
    check("Max bar: accepts Date, ISO string and epoch inputs", o.asDates === 2);
  } finally { fs.rmSync(f, { force: true }); }
}
// ---------- wiring: the endpoint only sends the Max block when there is a cap to show
const usageSrc = fs.readFileSync(path.join(root, "api/miniapp/usage.js"), "utf8");
check("usage endpoint sends `max` only for plans with a daily cap", /if \(limits\.maxPerDay > 0\)/.test(usageSrc) && /body\.max = \{ perDay: limits\.maxPerDay/.test(usageSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
