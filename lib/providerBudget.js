// lib/providerBudget.js
//
// Site-wide spend guards for the two providers whose free allowance is a
// SHARED BUDGET rather than a per-model request count:
//
//   - Cloudflare Workers AI: 10,000 "neurons" per UTC day, one pool for every
//     model and every user. Bigger models burn more neurons per token.
//   - Mistral: $10/month in API credits (shared across Studio, the API and
//     Vibe Code), so every call, OCR page and transcription draws on one
//     dollar balance.
//
// Both are tracked as rows in usage_events, with telegram_user_id = 0 (the
// "site" pseudo-user — no real Telegram id is 0) so NO migration is needed:
//   kind "cf_neurons"       -> tokens column = neurons spent (rounded up)
//   kind "mistral_microusd" -> tokens column = millionths of a dollar spent
// Every other query in lib/limits.js filters by kind or by a real user id,
// so these rows never leak into anyone's message or token counts.
//
// The guards are deliberately CONSERVATIVE and FAIL OPEN:
//   - they stop calling the provider at ~90% / ~85% of the allowance, leaving
//     headroom for the calls this module can't see (OCR retries, dashboard
//     testing, a different clock for when Mistral's credit cycle resets);
//   - if the database check itself errors, the provider is allowed — a
//     wrongly-allowed call just gets a 429/403 from the provider and the
//     fallback chain moves on, whereas wrongly blocking would strand traffic.
// Neither provider can bill you by surprise on the free plan; the guard
// exists so a busy day doesn't burn the pool by lunchtime for everyone.
//
// Tunable from Vercel env vars, no code change:
//   CF_NEURON_DAILY_CAP        default 9000   (of Cloudflare's 10,000)
//   MISTRAL_MONTHLY_BUDGET_USD default 8.5    (of the $10 credit)

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { usageEvents } from "../db/schema.js";

const SITE_USER_ID = 0;

function startOfUtcDay() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function startOfUtcMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

const numEnv = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);

export const BUDGETS = {
  // Cloudflare resets at 00:00 UTC.
  cloudflare: {
    kind: "cf_neurons",
    cap: numEnv("CF_NEURON_DAILY_CAP", 9000),
    windowStart: startOfUtcDay,
  },
  // Mistral's credit cycle may not line up with the calendar month — if yours
  // resets on another day, lower the budget for the month you're in.
  mistral: {
    kind: "mistral_microusd",
    cap: Math.round(numEnv("MISTRAL_MONTHLY_BUDGET_USD", 8.5) * 1_000_000),
    windowStart: startOfUtcMonth,
  },
};

// Rough token count for when a provider's response carries no usage block.
export function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

// Cost of one call, in the unit its budget is tracked in.
//   cost: { neuronsPer1K: { in, out } }  -> neurons
//   cost: { usdPerM: { in, out } }       -> millionths of a dollar
//         (tokens x $/million tokens is exactly micro-dollars)
export function costOf(cost, promptTokens, completionTokens) {
  const p = promptTokens ?? 0;
  const c = completionTokens ?? 0;
  if (cost?.neuronsPer1K) return Math.ceil((p / 1000) * cost.neuronsPer1K.in + (c / 1000) * cost.neuronsPer1K.out);
  if (cost?.usdPerM) return Math.ceil(p * cost.usdPerM.in + c * cost.usdPerM.out);
  return 0;
}

// Short in-memory cache so a burst of messages costs one query, not one each.
// Per serverless instance only — fine, the number only needs to be roughly right.
const cache = new Map(); // budgetName -> { spent, at }
const CACHE_MS = 20_000;

async function spentInWindow(name) {
  const budget = BUDGETS[name];
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.spent;
  const [row] = await db
    .select({ total: sql`coalesce(sum(${usageEvents.tokens}), 0)`.mapWith(Number) })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.telegramUserId, SITE_USER_ID),
        eq(usageEvents.kind, budget.kind),
        gte(usageEvents.createdAt, budget.windowStart())
      )
    );
  cache.set(name, { spent: row.total, at: Date.now() });
  return row.total;
}

// True while the provider still has headroom today / this month.
export async function hasBudget(name) {
  const budget = BUDGETS[name];
  if (!budget) return true;
  try {
    return (await spentInWindow(name)) < budget.cap;
  } catch (err) {
    console.warn(`budget check for ${name} failed, allowing:`, err.message);
    return true;
  }
}

// Record what a finished call cost. Never throws — a failed bookkeeping write
// must not turn a good answer into an error.
export async function recordSpend(name, amount) {
  const budget = BUDGETS[name];
  if (!budget || !(amount > 0)) return;
  try {
    await db.insert(usageEvents).values({ telegramUserId: SITE_USER_ID, kind: budget.kind, tokens: amount });
    const hit = cache.get(name);
    if (hit) hit.spent += amount; // keep this instance's view current between refreshes
  } catch (err) {
    console.warn(`recording ${name} spend failed:`, err.message);
  }
}

// For the dashboard / debugging: where each budget stands right now.
export async function budgetStatus() {
  const out = {};
  for (const name of Object.keys(BUDGETS)) {
    try {
      out[name] = { spent: await spentInWindow(name), cap: BUDGETS[name].cap };
    } catch {
      out[name] = { spent: null, cap: BUDGETS[name].cap };
    }
  }
  return out;
}
