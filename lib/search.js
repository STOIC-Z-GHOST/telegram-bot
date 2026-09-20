// lib/search.js
//
// Backs the mini app's 🔍 Search toggle (search: true on a message POST —
// see api/miniapp/messages.js). Three-link fallback chain, cheapest/most
// generous first:
//
//   1. Self-hosted SearXNG (SEARXNG_URL) — free, no per-query cap, but can
//      be cold/asleep if it's hosted on a platform's free tier that sleeps
//      after idle time (e.g. Render's free web services do, after 15
//      minutes with no requests).
//   2. Tavily (TAVILY_API_KEY) — reliable, generous free tier. Catches
//      SearXNG being asleep, unreachable, or simply not set up yet.
//   3. Gemini's own built-in Google Search grounding (reuses
//      GEMINI_API_KEY, already set for the rest of the bot) — the true
//      last resort. This one is different in kind from the two above:
//      instead of a list of raw results to hand to whichever model
//      answers next, Gemini searches AND writes the final answer itself
//      in one call. There's nothing left to inject in that case —
//      messages.js uses that answer directly and skips the normal
//      getConversationReply call for that turn.
//
// Any link can be left unconfigured (its env var unset) and the chain
// just skips straight past it to the next one. If all three are
// unset/fail, searchWeb() resolves to null and the caller proceeds
// without search context — exactly as if Search mode had never been
// toggled on, rather than erroring the whole message out.

import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { buildSystemInstruction, GEMINI_MODEL } from "./ai.js";
import { canUseGeminiGroundingFallback, recordGroundingFallbackUsage } from "./limits.js";

const SEARXNG_URL = process.env.SEARXNG_URL; // e.g. https://your-searxng.onrender.com — trailing slash doesn't matter either way
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_RESULTS = 5;
// SearXNG fans a query out across several engines in parallel — 9s is
// wide enough that a normal warm response (usually 1-3s) never gets cut
// off by this, but short enough that a cold/sleeping instance falls
// through to Tavily quickly instead of making the user sit through a
// 15-60s cold boot.
const SEARXNG_TIMEOUT_MS = 9000;
const TAVILY_TIMEOUT_MS = 10000;
const GROUNDING_TIMEOUT_MS = 20000;

// How long a chat's cached search context (see condenseSearchOutcomeForCache
// below, and the reuse block in api/miniapp/messages.js) stays eligible for
// reuse by a Search-off follow-up. Deliberately short — long enough for a
// natural "how"/"why"/"who else" right after a searched reply, short enough
// that something genuinely time-sensitive (a score, a price) doesn't keep
// getting served stale well after the fact.
export const SEARCH_CACHE_FRESHNESS_MS = 15 * 60 * 1000;

// Condenses a searchWeb() outcome into one plain-text blob worth storing on
// chats.lastSearchContext — small enough to be cheap to re-inject into a
// follow-up's system instruction, unlike replaying the full raw results
// (SearXNG/Tavily can return long snippets) or re-running the search itself.
// Returns null for a null/empty outcome so callers know not to overwrite an
// existing cache with nothing — a failed or empty search shouldn't erase a
// previous good one.
export function condenseSearchOutcomeForCache(searchOutcome) {
  if (!searchOutcome) return null;
  if (searchOutcome.groundedReply) return searchOutcome.groundedReply.text || null;
  if (searchOutcome.results?.length) {
    return searchOutcome.results
      .slice(0, MAX_RESULTS)
      .map((r) => `${r.title}: ${r.snippet}`)
      .join("\n")
      .slice(0, 1500); // a hard ceiling, not just a guideline — keeps a pathological snippet from bloating every follow-up call after it
  }
  return null;
}

async function searchSearxng(query) {
  if (!SEARXNG_URL) return null;
  const url = `${SEARXNG_URL.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, SEARXNG_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`SearXNG error ${resp.status}`);
  const data = await resp.json();
  const results = (data.results || [])
    .slice(0, MAX_RESULTS)
    .map((r) => ({ title: r.title, url: r.url, snippet: r.content || "" }));
  if (results.length === 0) throw new Error("no results");
  return results;
}

async function searchTavily(query) {
  if (!TAVILY_API_KEY) return null;
  const resp = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: MAX_RESULTS }),
    },
    TAVILY_TIMEOUT_MS
  );
  if (!resp.ok) throw new Error(`Tavily error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const results = (data.results || [])
    .slice(0, MAX_RESULTS)
    .map((r) => ({ title: r.title, url: r.url, snippet: r.content || "" }));
  if (results.length === 0) throw new Error("no results");
  return results;
}

// The true last resort — Gemini's own grounding tool searches AND writes
// the final answer in one call, so this returns { text, tokensUsed }, the
// same shape getConversationReply returns, not a results list. Uses
// buildSystemInstruction (imported from lib/ai.js) so a grounded reply
// still gets the same persona/memory context a normal reply would —
// nothing about falling back to this path should feel like a downgrade
// beyond "no raw sources to point to individually".
async function answerWithGeminiGrounding(history, memoryOptions, telegramUserId) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildSystemInstruction(memoryOptions) }] },
        contents,
        tools: [{ google_search: {} }],
      }),
    },
    GROUNDING_TIMEOUT_MS
  );
  if (!resp.ok) throw new Error(`Gemini grounding error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini grounding returned no text");
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;
  // Only recorded on success — a failed call (timeout, error response)
  // shouldn't count against the site-wide free pool it didn't actually
  // draw from.
  await recordGroundingFallbackUsage(telegramUserId);
  return { text, tokensUsed };
}

// query: the user's latest message — what to search for.
// history / memoryOptions: only used if the chain falls all the way
// through to Gemini grounding, which needs the full conversation (and the
// same memory/persona context a normal reply would get) to answer
// directly rather than just the bare query.
// telegramUserId: only used to attribute the grounding-fallback usage
// event if that path ends up getting called (see recordGroundingFallbackUsage
// in lib/limits.js) — the budget it's checked against is site-wide, not
// per-user, this is just bookkeeping on whose turn triggered it.
//
// Resolves to one of:
//   { results: [{ title, url, snippet }, ...] } — hand these to
//     buildSystemInstruction's searchResults option (see lib/ai.js) and
//     call getConversationReply as normal; both Groq and Gemini benefit,
//     not just Gemini.
//   { groundedReply: { text, tokensUsed } } — already a finished answer;
//     use it directly and skip getConversationReply for this turn.
//   null — nothing configured, everything failed, or the site-wide
//     Gemini-grounding free budget is used up; proceed with no search
//     context, exactly as if Search mode had been off.
export async function searchWeb(query, history, memoryOptions, telegramUserId) {
  try {
    const results = await searchSearxng(query);
    if (results) return { results };
  } catch (err) {
    console.warn("SearXNG failed, falling back to Tavily:", err.message);
  }

  try {
    const results = await searchTavily(query);
    if (results) return { results };
  } catch (err) {
    console.warn("Tavily failed, falling back to Gemini grounding:", err.message);
  }

  // Last resort, and the only link in this chain that can actually cost
  // money past its free allotment — check the site-wide budget BEFORE
  // calling it, not after. Skipping this check would mean the only thing
  // standing between the bot and real Gemini billing is "SearXNG and
  // Tavily both happened to fail rarely enough" — not a bet worth making.
  const groundingBudgetOk = await canUseGeminiGroundingFallback();
  if (!groundingBudgetOk) {
    console.warn("Gemini grounding site-wide free budget exhausted — proceeding without search");
    return null;
  }

  try {
    const groundedReply = await answerWithGeminiGrounding(history, memoryOptions, telegramUserId);
    return { groundedReply };
  } catch (err) {
    console.error("Gemini grounding also failed — proceeding without search:", err.message);
    return null;
  }
}
