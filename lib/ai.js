// lib/ai.js
//
// Multi-turn Groq (primary, for speed) / Cerebras / OpenRouter / Mistral
// (independent free-tier fallbacks, same OpenAI-compatible shape) / Gemini
// (final fallback for text, and the only option for vision/documents)
// calling for the mini app's chat threads. This is a sibling to the
// single-prompt logic already in api/telegram-webhook.js, not a
// replacement for it — the webhook's existing DM chat, /image, and
// document reading are untouched and keep working exactly as they do now.
// This file exists because a "chat" with history is the whole point of
// the mini app, so it's built around a full message array instead of one
// prompt.
//
// Why four text providers instead of two: Groq's free tier alone is
// 1,000 requests/day and 200,000 tokens/day, shared across every user of
// the whole bot — easy to exhaust on a busy day. Cerebras and OpenRouter
// both serve gpt-oss-120b too (the exact model Groq runs), from
// completely independent free pools, so falling over to them is
// functionally invisible to the user — same model, same behavior, just a
// different account's quota being drawn from. Mistral is the last of the
// OpenAI-compatible options and a different model family (Mistral Small,
// not gpt-oss) — see the comment on MISTRAL_API_KEY below before turning
// it on, it comes with a real trade-off the others don't.

import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { ocrToText, buildOcrPrompt } from "./ocr.js";
import { hasBudget, recordSpend, costOf, estimateTokens } from "./providerBudget.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Cerebras killed its no-card free tier as of mid-2026 — new accounts now
// need a verified payment method just to unlock a one-time $5 credit that
// expires in 30 days, not a permanent daily allowance. Left wired in
// below (same OpenAI-compatible shape as the others) in case you decide
// the 30-day trial is worth a card, but it no longer belongs in a "free,
// no card" fallback chain the way it looked when this was first added —
// leave CEREBRAS_API_KEY unset and it's simply skipped, same as any
// other provider whose key isn't set. Double-check current terms at
// cloud.cerebras.ai before adding a card.
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
// ModelScope — Alibaba's model hub, a separate 2,000 requests/day pool
// (500/day per individual model) from OpenRouter's. Same token type serves
// both their SDK and this REST API — modelscope.cn/my/myaccesstoken.
const MODELSCOPE_API_KEY = process.env.MODELSCOPE_API_KEY;
// Z.ai (formerly Zhipu) — sign up at z.ai specifically, not the China-only
// bigmodel.cn domain (that one wants a Chinese phone number; z.ai doesn't).
// GLM-4.6V-Flash is genuinely free, not trial credits, just tightly
// rate-limited — sources vary on the exact number, so it's kept last in
// the chain below rather than leaned on.
const ZAI_API_KEY = process.env.ZAI_API_KEY;
// Mistral's free "Experiment" tier (~1B tokens/month, by far the biggest
// pool of the four) uses prompts sent to it to improve their models
// unless your La Plateforme workspace opts out — check Admin Console →
// Privacy before relying on this one for real user traffic. It's wired
// in below like the others, but gated on this env var being set on
// purpose: leave MISTRAL_API_KEY unset in Vercel until you've made that
// call, and this provider is simply skipped, no code change needed.
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// Exported so lib/search.js's Gemini-grounding fallback stays on the same
// model as everything else here — one constant to change, not two.
export const GEMINI_MODEL = "gemini-3.6-flash";
// Second Gemini model for vision, PDFs, transcription and the last-resort
// text fallback. Google's free tier gives every Gemini Flash model its OWN
// small quota — on this project 3.6 Flash is 5 requests/min and 20/day for
// ALL users combined — while 3.5 Flash-Lite is 15/min and 500/day and takes
// the same inputs (images, PDFs, audio). So when GEMINI_MODEL's allowance is
// spent, requests move here instead of failing. Slightly weaker, much roomier.
// Check both numbers in AI Studio -> rate limits if you change either model.
export const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const GROQ_MODEL = "openai/gpt-oss-120b";
// Cerebras hosts the same gpt-oss-120b weights Groq does — different
// company, different free-tier quota, same model.
const CEREBRAS_MODEL = "gpt-oss-120b";
// The :free suffix is what makes this free on OpenRouter — dropping it
// would silently switch to a billed route.
const OPENROUTER_MODEL = "openai/gpt-oss-120b:free";

// --- Cloudflare Workers AI -------------------------------------------------
// Free plan = 10,000 "neurons" per UTC day for EVERY model and user combined
// (see lib/providerBudget.js, which stops calling it at ~90%). Uses
// Cloudflare's OpenAI-compatible endpoint, so it plugs into the same helper
// as Groq/OpenRouter/Mistral. Needs BOTH CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN (a token with Workers AI permission); with either
// missing it is skipped with no network call.
// Model ids come from env vars because Workers AI retires models (kimi-k2.5
// is already deprecated) — a retired id just 404s and the chain moves on.
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_BASE_URL = CF_ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1` : "";
const CF_KEY = CF_ACCOUNT_ID ? CF_API_TOKEN : undefined;
// Neurons per 1K tokens, from Cloudflare's pricing page.
const CF_STANDARD_MODEL = process.env.CF_STANDARD_MODEL || "@cf/openai/gpt-oss-120b"; // 31.8 in / 68.2 out
const CF_FLASH_MODEL = process.env.CF_FLASH_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8-fast"; // 4.1 in / 34.9 out
const CF_VISION_MODEL = process.env.CF_VISION_MODEL || "@cf/google/gemma-4-26b-a4b-it"; // 9.1 in / 27.3 out

// --- Mistral ---------------------------------------------------------------
// Mistral's free plan is $10/month of API credit shared by everything (see
// lib/providerBudget.js — stops at ~$8.50). Ids are PINNED rather than
// "-latest": the aliases may resolve to a model with a far lower rate limit
// (mistral-large-4 is 20K tokens/min vs 250K for mistral-large-2512).
// Prices are $ per million tokens (in / out).
const MISTRAL_SMALL_MODEL = process.env.MISTRAL_SMALL_MODEL || "mistral-small-2603"; // 0.15 / 0.60
const MISTRAL_LARGE_MODEL = process.env.MISTRAL_LARGE_MODEL || "mistral-large-2512"; // 0.50 / 1.50
const MISTRAL_14B_MODEL = process.env.MISTRAL_14B_MODEL || "ministral-14b-2512"; // 0.20 / 0.20
const MISTRAL_8B_MODEL = process.env.MISTRAL_8B_MODEL || "ministral-8b-2512"; // 0.15 / 0.15
// Exported so callers can tell whether a reply was really served by the (costly)
// Max model — used for the trial per-day cap in lib/limits.js.
export const MAX_MODEL_ID = MISTRAL_LARGE_MODEL;


// Every OpenAI-compatible text provider in the fallback chain, in
// priority order. Groq is first for latency (LPU hardware, built for
// real-time replies) — the rest are here purely for headroom on days
// Groq's shared free pool runs dry, not because they're faster.
// A provider whose apiKey is unset (below) is skipped with no network
// call, so adding a new key later is the only step needed to turn one on
// — no other code change.
const TEXT_PROVIDERS = [
  {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: GROQ_API_KEY,
    model: GROQ_MODEL,
    supportsReasoningEffort: true,
  },
  {
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKey: CEREBRAS_API_KEY,
    model: CEREBRAS_MODEL,
    supportsReasoningEffort: true,
  },
  {
    // Same gpt-oss-120b weights as Groq, so answers keep one style when Groq's
    // pool is spent. Skipped in think mode: reasoning tokens bill as output
    // and one deep answer can cost ~4x the neurons of a normal one.
    name: "Cloudflare",
    baseUrl: CF_BASE_URL,
    apiKey: CF_KEY,
    model: CF_STANDARD_MODEL,
    supportsReasoningEffort: false,
    skipWhenThinking: true,
    budget: "cloudflare",
    cost: { neuronsPer1K: { in: 31.8, out: 68.2 } },
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY,
    model: OPENROUTER_MODEL,
    supportsReasoningEffort: true,
    // OpenRouter asks every caller to send these two so abuse/traffic can
    // be traced back to an app — not an auth requirement, safe to leave
    // as-is, but feel free to change the title.
    extraHeaders: { "HTTP-Referer": "https://t.me", "X-Title": "Telegram AI Bot" },
  },
  {
    // Cheapest decent Mistral model, tried before Small 4 to stretch the $10.
    name: "Ministral 14B",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: MISTRAL_API_KEY,
    model: MISTRAL_14B_MODEL,
    supportsReasoningEffort: false,
    budget: "mistral",
    cost: { usdPerM: { in: 0.2, out: 0.2 } },
  },
  {
    name: "Mistral Small",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: MISTRAL_API_KEY,
    model: MISTRAL_SMALL_MODEL,
    // Neither Mistral model understands gpt-oss's reasoning_effort param —
    // a thinking-mode request that falls through to Mistral just answers
    // at normal depth instead of erroring out.
    supportsReasoningEffort: false,
    budget: "mistral",
    cost: { usdPerM: { in: 0.15, out: 0.6 } },
  },
];

// The Flash/Max model-quality tiers (Standard is just TEXT_PROVIDERS
// above, unchanged; Extra's Gemini models are defined just below) — see getConversationReply's tier handling below for
// how these compose with the fallback chain rather than replace it.
// Deliberately reuse GROQ_API_KEY/MISTRAL_API_KEY rather than separate
// keys: same accounts already configured and already privacy-reviewed
// (see the comment on MISTRAL_API_KEY near the top of this file), just a
// different model on each.
// Flash: Groq's 8B first, then Cloudflare's 8B (cheap — ~9 neurons an
// exchange), then Ministral 8B (~$0.0003 an exchange), then the Standard chain.
const FLASH_PROVIDERS = [
  {
    name: "Groq Flash",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: GROQ_API_KEY,
    model: "llama-3.1-8b-instant",
    supportsReasoningEffort: false,
  },
  {
    name: "Cloudflare Flash",
    baseUrl: CF_BASE_URL,
    apiKey: CF_KEY,
    model: CF_FLASH_MODEL,
    supportsReasoningEffort: false,
    budget: "cloudflare",
    cost: { neuronsPer1K: { in: 4.1, out: 34.9 } },
  },
  {
    name: "Ministral 8B",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: MISTRAL_API_KEY,
    model: MISTRAL_8B_MODEL,
    supportsReasoningEffort: false,
    budget: "mistral",
    cost: { usdPerM: { in: 0.15, out: 0.15 } },
  },
];
// Max (and Extra, once its Gemini models are spent): Mistral Large 3, pinned.
// ~$0.0014 an exchange, so $10 buys only ~7,000 — see the budget guard.
const MAX_PROVIDERS = [
  {
    name: "Mistral Large",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: MISTRAL_API_KEY,
    model: MISTRAL_LARGE_MODEL,
    supportsReasoningEffort: false,
    budget: "mistral",
    cost: { usdPerM: { in: 0.5, out: 1.5 } },
  },
];

// A provider is usable when its key is set, it isn't a no-go in think mode,
// and (for the shared-budget providers) today's/this month's budget has room.
async function providerUsable(provider, { thinking = false } = {}) {
  if (!provider.apiKey || !provider.baseUrl) return false;
  if (thinking && provider.skipWhenThinking) return false;
  if (provider.budget && !(await hasBudget(provider.budget))) return false;
  return true;
}

// Charge a finished call to its provider's shared budget. Uses the provider's
// own usage figures, falling back to a rough estimate if the response has none.
async function trackSpend(provider, data, requestChars, text) {
  if (!provider.budget) return;
  const promptTokens = data?.usage?.prompt_tokens ?? estimateTokens({ length: requestChars });
  const completionTokens = data?.usage?.completion_tokens ?? estimateTokens(text);
  await recordSpend(provider.budget, costOf(provider.cost, promptTokens, completionTokens));
}
// Extra (Premium) is the top tier. It tries Google's newest Flash models
// first, in this order, and only then Max's model:
//   gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash, gemini-3-flash-preview
// WHY FOUR: Google's free tier applies limits per project AND per model, and
// on this project each of these is only 5 requests/min and 20/day for all
// users combined (Gemini 2.5 Pro and 3.1 Pro show 0 — not available on the
// free tier at all). Separate models are separate quotas, so chaining four
// gives about 80 Extra replies a day instead of 20. gemini-3.6-flash is
// deliberately NOT in this list: vision and PDFs (GEMINI_MODEL above) use it.
// A spent quota is just a fast 429 and the chain moves on, so order is only
// about quality — newest first. "-preview" ids can be retired; if that one
// 404s it is skipped the same way.
// Per-user and site-wide daily budgets for Extra live in lib/limits.js.
// Timeouts are short on purpose: the whole chain has to fit inside the
// function's 60s maxDuration (see EXTRA_BUDGET_MS below).
const EXTRA_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];
// Thinking depth for Extra's Gemini calls. Gemini 3 models take a level, not a
// token budget; "minimal" is avoided because 3.7 Flash rejects it with a 400.
const EXTRA_THINKING_LEVEL = { normal: "low", think: "high" };
const EXTRA_TIMEOUT_MS = { normal: 14000, think: 25000 };
// Stop starting new Extra attempts once this much time has gone by, so a
// run of slow attempts can't leave no time for the Standard chain after it.
const EXTRA_BUDGET_MS = 22000;

// Which subscription tier a model-quality tier requires — "owner" always
// passes regardless of what's listed here (see the isOwner check wherever
// this is read, e.g. api/miniapp/messages.js). Free/Pro/Premium ranked
// low to high; a plan at or above the listed one qualifies.
export const MODEL_TIER_MIN_PLAN = {
  flash: "free",
  standard: "free",
  max: "pro",
  extra: "premium",
};

const SYSTEM_PROMPT =
  "You are a helpful, knowledgeable personal assistant chatting inside a Telegram " +
  "mini app. Match your answer's length and depth to the question — a quick, " +
  "simple question gets a quick, simple answer; go into real detail only when " +
  "the question is genuinely complex or the person is clearly asking for depth " +
  "(or used thinking mode). Plain text only, no markdown headers. " +
  "If asked who you are, what model you are, or who made you: you're this app's " +
  "own AI assistant. Say honestly that it runs on a mix of AI models behind the " +
  "scenes and that you can't see which one is answering a given message — never " +
  "name specific providers or models, never say how many there are, never claim " +
  "which AI makes the images, never claim to be ChatGPT, GPT-4, or any other " +
  "OpenAI product, and don't cite a training cutoff date as if you were one of " +
  "those products. If the person keeps pressing (\"only 2?\", \"which ones?\"), " +
  "answer in fresh words that you don't know — don't repeat your earlier sentence. " +
  "When you don't have live search results for THIS message and the question " +
  "needs a specific, verifiable fact you can't actually be sure of — a score, a " +
  "date, a statistic, anything about a recent or time-sensitive event — say so " +
  "plainly and suggest turning on Search, rather than guessing something that " +
  "merely sounds plausible. This holds even mid-conversation: a fact you " +
  "established with Search a turn or two ago doesn't mean a related new detail " +
  "asked about now is also known — if this specific message has no fresh search " +
  "results attached, treat unconfirmed specifics exactly as if Search had never " +
  "been used at all in this chat. " +
  "If asked what commands or features this app has: there are no slash commands " +
  "for general use except /image <description> (AI image generation) and " +
  "/review <code> (code-review mode) — everything else is a UI control, not " +
  "something typed: a Search toggle for live web results, a Think toggle for " +
  "slower/deeper answers, a model-quality picker (Flash/Standard/Max/Extra), " +
  "a standalone web search tab, chat pinning, and multi-select delete. Never " +
  "invent a slash command or feature beyond this real list (no /weather, " +
  "/remind, /todo, /poll, etc.) — if asked about something not on it, say " +
  "plainly that this app doesn't have it.";

// Appended instead of the normal persona staying purely agreeable, only for
// /review requests (see codeReview below) — deliberately adversarial rather
// than the default helpful-assistant tone, and scoped to just this block so
// it never bleeds into ordinary chat.
const CODE_REVIEW_INSTRUCTION =
  "\n\nThe user has invoked code-review mode. For this reply only, drop the " +
  "usual agreeable tone and act as an uncompromising lead systems architect. " +
  "Rules:\n" +
  "1. Never compliment the code or confirm it's correct before you've tried to " +
  "break it. Assume it contains a subtle concurrency bug, memory leak, or edge " +
  "case until you've actually checked.\n" +
  "2. Don't trust the user's description of what the code does — trace the " +
  "actual execution: event-loop order, async boundaries, shared-state " +
  "mutations, listener lifetimes.\n" +
  "3. Follow this structure: (a) trace every async boundary and state mutation, " +
  "(b) list specific concrete ways this fails under concurrency, latency, or " +
  "dropped events — not generic advice, (c) check every map/listener/promise " +
  "for references that are never cleared, (d) only then give the minimal fix.\n" +
  "4. If a proposed fix reintroduces the same bug under a different " +
  "abstraction, say so explicitly instead of approving it.";

// Builds the system instruction for one call. savedMemories (if any) are
// folded in as known facts; allowMemorySave, when true, tells the model it
// may end its reply with a [SAVE_MEMORY: ...] marker — but only when the
// user's latest message actually asked it to remember/save something.
// lib/memory.js strips that marker back out before the reply is shown.
// searchResults (if any) are Search-mode's web results, folded in the same
// way — see lib/search.js, which also calls this directly for its own
// last-resort Gemini-grounding fallback, so a searched reply still gets
// the same persona/memory context a normal reply would.
// cachedSearchContext (if any) is a condensed leftover from a previous
// search earlier in the same chat, reused for a Search-off follow-up
// instead of a fresh search — see condenseSearchOutcomeForCache and the
// reuse block in api/miniapp/messages.js. Mutually exclusive with
// searchResults in practice (a message either triggers a live search or
// reuses a cached one, never both), but nothing here enforces that.
// codeReview (if true) appends CODE_REVIEW_INSTRUCTION — see /review in
// api/miniapp/messages.js. Scoped to just this one call's system prompt,
// never a persistent persona change.
export function buildSystemInstruction({ savedMemories, allowMemorySave, searchResults, cachedSearchContext, codeReview } = {}) {
  let text = SYSTEM_PROMPT;

  if (savedMemories && savedMemories.length) {
    text +=
      `\n\nFacts the user has explicitly asked you to remember, true across all their chats:\n` +
      savedMemories.map((m) => `- ${m}`).join("\n");
  }

  if (allowMemorySave) {
    text +=
      "\n\nIf — and only if — the user's latest message explicitly asks you to " +
      "remember, save, or keep in mind something specific (not merely uses the word " +
      "'remember' in passing), end your reply with one line in exactly this format: " +
      "[SAVE_MEMORY: <a short, self-contained restatement of the fact>]. Never include " +
      "this line otherwise.";
  }

  if (searchResults && searchResults.length) {
    text +=
      `\n\nLive web search results for the user's latest message — use these to answer ` +
      `if they're relevant and the question needs current information, and mention ` +
      `that you looked this up. Cite sources by name where it helps; don't invent ` +
      `results beyond what's listed here:\n` +
      searchResults.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`).join("\n");
  }

  if (cachedSearchContext) {
    text +=
      `\n\nContext from a web search earlier in this same chat (not brand new — ` +
      `Search wasn't used for this specific message, so this wasn't just looked ` +
      `up):\n${cachedSearchContext}\n\nUse it only if it actually answers what's ` +
      `being asked now — if this message needs a specific fact that isn't covered ` +
      `by that context, say you don't have current info for that part rather than ` +
      `guessing, same as if no search context were here at all.`;
  }

  text +=
    "\n\nIf — and only if — the user's latest message is clearly asking you to " +
    "generate, create, draw, or make an image (not just discussing or asking " +
    "about images in general), respond with ONLY this single line and nothing else: " +
    "[GENERATE_IMAGE: <a clear, well-formed image generation prompt capturing what " +
    "they asked for>]. Do not add any other text before or after it, and never use " +
    "this format unless they're clearly requesting a brand-new image be created.";

  if (codeReview) text += CODE_REVIEW_INSTRUCTION;

  return text;
}

// history: [{ role: "user" | "assistant", content: "..." }, ...] in order,
// oldest first. Gemini calls the assistant's turns "model", not "assistant".
// thinking, when true, requests a real reasoning pass — same idea as the DM
// bot's /think in api/telegram-webhook.js.
async function askGeminiConversation(history, memoryOptions, { thinking = false, codeReview = false, model = GEMINI_MODEL, timeoutMs, thinkingLevel } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body = {
    system_instruction: { parts: [{ text: buildSystemInstruction({ ...memoryOptions, codeReview }) }] },
    contents,
  };
  if (thinkingLevel) body.generationConfig = { thinkingConfig: { thinkingLevel } };
  else if (thinking) body.generationConfig = { thinkingConfig: { thinkingBudget: 8192 } };
  // Low temperature for review mode only — keeps the critique grounded in
  // the actual code instead of generic, plausible-sounding advice. Left
  // unset (provider default) for every normal reply.
  if (codeReview) body.generationConfig = { ...(body.generationConfig || {}), temperature: 0.1 };
  const send = () =>
    fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeoutMs ?? (thinking ? 45000 : 20000));
  let resp = await send();
  // A model that doesn't accept the thinking level we asked for answers 400.
  // Retry once with the model's own default thinking rather than losing the
  // whole attempt (and, for Extra, silently skipping a model that works).
  if (resp.status === 400 && thinkingLevel) {
    const detail = await resp.text();
    if (/thinking/i.test(detail)) {
      console.warn(`Gemini (${model}) rejected thinkingLevel "${thinkingLevel}", retrying with its default`);
      delete body.generationConfig.thinkingConfig;
      if (!Object.keys(body.generationConfig).length) delete body.generationConfig;
      resp = await send();
    } else {
      throw new Error(`Gemini (${model}) error 400: ${detail}`);
    }
  }
  if (!resp.ok) throw new Error(`Gemini (${model}) error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;
  return { text, tokensUsed };
}

async function askOpenAiCompatible(provider, history, memoryOptions, { thinking = false, maxTokens, codeReview = false } = {}) {
  const body = {
    model: provider.model,
    messages: [
      { role: "system", content: buildSystemInstruction({ ...memoryOptions, codeReview }) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
  if (thinking && provider.supportsReasoningEffort) body.reasoning_effort = "high";
  if (maxTokens) body.max_tokens = maxTokens;
  // Same reasoning as the Gemini path above — grounded critique over
  // generic-sounding drift, scoped to /review only.
  if (codeReview) body.temperature = 0.1;
  const resp = await fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.extraHeaders,
    },
    body: JSON.stringify(body),
  }, thinking ? 40000 : 20000);
  if (!resp.ok) throw new Error(`${provider.name} error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider.name} returned no text`);
  await trackSpend(provider, data, JSON.stringify(body.messages).length, text);
  const tokensUsed = data?.usage?.total_tokens ?? null;
  return { text, tokensUsed };
}

// One-shot image/PDF analysis for attachments sent in the mini app —
// mirrors api/telegram-webhook.js's askGeminiVision. Deliberately not part
// of the running conversation history/memory machinery above: like the DM
// bot, an attachment is analyzed on its own plus whatever caption came
// with it, not the whole chat's history.
//
// Gemini goes first since it's the only one of the bunch that natively
// reads PDFs (inline_data, same as an image) — Pixtral and Qwen2.5-VL
// below are image-only vision-language models, no PDF support, so they're
// only tried as a fallback when every attached file is actually an image.
// A PDF that fails on Gemini has nowhere left to fall back to; getVisionReply
// below skips straight to the graceful failure message for those, rather
// than sending PDF bytes to a model that can't read them and getting a
// confusing error back. No Groq vision fallback either, unrelated to any
// of this — a different, standing call: Groq's vision model wasn't
// reliable enough to trust as a silent fallback, images or not.
//
// fileParts: [{ base64, mimeType }, ...] — up to 5 images sent together,
// or a single PDF. Gemini accepts multiple inline_data parts in one
// request, so all of them go in a single call rather than one per file.
async function askGeminiVisionOnce(prompt, fileParts, model = GEMINI_MODEL, timeoutMs = 40000) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          parts: [
            { text: prompt },
            ...fileParts.map((f) => ({ inline_data: { mime_type: f.mimeType, data: f.base64 } })),
          ],
        },
      ],
    }),
  }, timeoutMs); // the real bottleneck for a complex image/PDF — budgeted against messages.js's 60s Vercel ceiling alongside the 15s file download in lib/attachments.js, leaving a margin for the DB writes after
  if (!resp.ok) throw new Error(`Gemini vision error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini vision returned no text");
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;
  return { text, tokensUsed };
}

// Image-only fallback chain for when Gemini's tight ~20/day free-tier
// vision quota is exhausted — reuses the SAME API keys already configured
// for TEXT_PROVIDERS above where possible, no new signup needed for those.
// ModelScope and Z.ai are the two exceptions requiring their own separate
// keys (MODELSCOPE_API_KEY, ZAI_API_KEY) — real, no-card free tiers, just
// not ones already in use elsewhere in this file. Mistral (Pixtral, on
// the same free "Experiment" tier as its text usage — same training-data
// privacy call applies here too, see the comment on MISTRAL_API_KEY near
// the top of this file, arguably even more worth weighing now that it's
// user photos/documents, not just chat text) goes first among the
// fallbacks since it's the most generously rate-limited; Z.ai goes last
// since its free tier is real but tightly concurrency-limited by most
// accounts. All four support multiple images per request, same as Gemini.
const VISION_PROVIDERS = [
  // Pixtral was retired by Mistral (folded into Medium 3.5) and is gone from
  // its rate card, so it is no longer in this chain. Gemma 4 takes its place:
  // multimodal, ~36 neurons for a typical image question, shared with the
  // text budget in lib/providerBudget.js.
  {
    name: "Cloudflare",
    baseUrl: CF_BASE_URL,
    apiKey: CF_KEY,
    model: CF_VISION_MODEL,
    budget: "cloudflare",
    cost: { neuronsPer1K: { in: 9.1, out: 27.3 } },
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY,
    model: "qwen/qwen2.5-vl-32b-instruct:free",
    // Shares OpenRouter's one daily free-tier counter with the text chain's
    // OpenRouter fallback above — not a separate additional allowance.
    extraHeaders: { "HTTP-Referer": "https://t.me", "X-Title": "Telegram AI Bot" },
  },
  {
    name: "ModelScope",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    apiKey: MODELSCOPE_API_KEY,
    model: "Qwen/Qwen3-VL-235B-A22B-Instruct",
  },
  {
    name: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKey: ZAI_API_KEY,
    model: "glm-4.6v-flash",
  },
];

async function askOpenAiCompatibleVision(provider, prompt, fileParts) {
  const content = [
    { type: "text", text: prompt },
    ...fileParts.map((f) => ({ type: "image_url", image_url: { url: `data:${f.mimeType};base64,${f.base64}` } })),
  ];
  const resp = await fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.extraHeaders,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    }),
  }, 40000);
  if (!resp.ok) throw new Error(`${provider.name} vision error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider.name} vision returned no text`);
  await trackSpend(provider, data, 6000 + fileParts.length * 4000, text); // fallback estimate if the response has no usage block: ~1.5K tokens of prompt + ~1K per image
  const tokensUsed = data?.usage?.total_tokens ?? null;
  return { text, tokensUsed };
}

export async function getVisionReply(prompt, fileParts) {
  const startedAt = Date.now();
  try {
    const result = await askGeminiVisionOnce(prompt, fileParts);
    console.log(`Gemini vision answered (${result.tokensUsed ?? "?"} tokens)`);
    return result;
  } catch (err) {
    console.warn("Gemini vision failed:", err.message);
  }

  // GEMINI_MODEL's free daily allowance is tiny (20/day here), so it is
  // usually a quota error — which comes back in about a second. Try the
  // roomier model before leaving Gemini. Skipped if the first attempt was
  // slow: 40s + this + the 15s file download wouldn't fit in 60s.
  if (Date.now() - startedAt < 10000) {
    try {
      const result = await askGeminiVisionOnce(prompt, fileParts, GEMINI_FALLBACK_MODEL, 25000);
      console.log(`Gemini vision (${GEMINI_FALLBACK_MODEL}) answered (${result.tokensUsed ?? "?"} tokens)`);
      return result;
    } catch (err) {
      console.warn(`Gemini vision (${GEMINI_FALLBACK_MODEL}) failed:`, err.message);
    }
  }

  const allImages = fileParts.every((f) => f.mimeType.startsWith("image/"));
  if (allImages) {
    for (const provider of VISION_PROVIDERS) {
      if (!(await providerUsable(provider))) continue;
      try {
        const result = await askOpenAiCompatibleVision(provider, prompt, fileParts);
        console.log(`${provider.name} vision answered (${result.tokensUsed ?? "?"} tokens)`);
        return result;
      } catch (err) {
        console.warn(`${provider.name} vision failed:`, err.message);
      }
    }
  }

  // A single PDF that Gemini couldn't read has no vision fallback (see the
  // comment above) — but Mistral OCR can turn it into text, which any of the
  // normal text models can then answer from. No-op without MISTRAL_API_KEY.
  // Skipped if the vision attempts already used a lot of the function's 60s —
  // OCR plus the text-model reply after it wouldn't fit, and a half-finished
  // fallback is worse than the plain error. The usual trigger (Gemini's quota
  // running out) fails in about a second, so it normally fits easily.
  if (fileParts.length === 1 && fileParts[0].mimeType === "application/pdf" && Date.now() - startedAt < 15000) {
    try {
      const ocr = await ocrToText(fileParts[0].base64, "application/pdf");
      if (ocr) {
        const result = await getConversationReply([{ role: "user", content: buildOcrPrompt(prompt, ocr) }]);
        console.log(`Mistral OCR fallback answered (${ocr.pages} pages)`);
        return result;
      }
    } catch (err) {
      console.warn("Mistral OCR fallback failed:", err.message);
    }
  }

  return { text: "⚠️ Couldn't analyze that file right now — every available vision provider failed.", tokensUsed: null };
}

// Walks TEXT_PROVIDERS in order — Groq first for latency, the rest as
// headroom for days Groq's shared free pool runs dry (see the file-level
// comment above) — then Gemini as the true last resort, same as before.
// A provider with no apiKey configured is skipped with no network call.
// memoryOptions: { savedMemories?: string[], allowMemorySave?: boolean }
// opts.tier ("flash" | "standard" | "max" | "extra", default "standard"):
// Flash and Max each try ONE specific model first (see FLASH_PROVIDERS /
// MAX_PROVIDERS above); Extra tries four Gemini Flash models in turn, then
// Max's model (see EXTRA_GEMINI_MODELS). Whatever fails falls through
// to this same Standard chain rather than failing outright or maintaining
// a separate parallel fallback chain per tier — every tier's worst case is
// "you got Standard's answer instead of your pick," never "you got nothing."
// The returned object also carries servedBy (the model id that answered) so
// callers can tell whether a shared Gemini quota was really used.
// Access-gating (which tiers a user's plan allows) happens by the caller,
// not here — see MODEL_TIER_MIN_PLAN and its use in api/miniapp/messages.js;
// this function trusts whatever tier it's given.
// Returns { text, tokensUsed } — tokensUsed comes straight from whichever
// provider answered, or null if every single one failed.
export async function getConversationReply(history, memoryOptions, opts = {}) {
  const { tier = "standard" } = opts;
  const startedAt = Date.now();

  // Extra: four Gemini Flash models in turn -> Max's model -> Standard chain.
  // Each step is skipped (no network call) if its key is unset, and any
  // failure — a 429 from a spent quota included — just moves to the next.
  if (tier === "extra" && GEMINI_API_KEY) {
    const mode = opts.thinking ? "think" : "normal";
    for (const model of EXTRA_GEMINI_MODELS) {
      if (Date.now() - startedAt > EXTRA_BUDGET_MS) break;
      try {
        const result = await askGeminiConversation(history, memoryOptions, {
          ...opts,
          model,
          thinkingLevel: EXTRA_THINKING_LEVEL[mode],
          timeoutMs: EXTRA_TIMEOUT_MS[mode],
        });
        console.log(`extra (${model}) answered (${result.tokensUsed ?? "?"} tokens)`);
        return { ...result, servedBy: model };
      } catch (err) {
        console.warn(`extra (${model}) failed, trying next:`, err.message);
      }
    }
  }

  if (tier !== "standard") {
    // "max" and "extra" both land on Max's model once Extra's Gemini models are exhausted
    const tierChain = tier === "flash" ? FLASH_PROVIDERS : MAX_PROVIDERS;
    for (const provider of tierChain) {
      if (Date.now() - startedAt > EXTRA_BUDGET_MS) break;
      if (!(await providerUsable(provider, opts))) continue;
      try {
        const result = await askOpenAiCompatible(provider, history, memoryOptions, opts);
        console.log(`${tier} (${provider.name}) answered (${result.tokensUsed ?? "?"} tokens)`);
        return { ...result, servedBy: provider.model };
      } catch (err) {
        console.warn(`${tier} (${provider.name}) failed, trying next:`, err.message);
      }
    }
  }

  for (const provider of TEXT_PROVIDERS) {
    if (!(await providerUsable(provider, opts))) continue;
    try {
      const result = await askOpenAiCompatible(provider, history, memoryOptions, opts);
      console.log(`${provider.name} answered (${result.tokensUsed ?? "?"} tokens)`);
      return { ...result, servedBy: provider.model };
    } catch (err) {
      console.warn(`${provider.name} failed, trying next provider:`, err.message);
    }
  }
  try {
    return { ...(await askGeminiConversation(history, memoryOptions, opts)), servedBy: GEMINI_MODEL };
  } catch (err) {
    console.warn(`Last-resort Gemini (${GEMINI_MODEL}) failed:`, err.message);
  }
  // Same reasoning as getVisionReply: GEMINI_MODEL's allowance is tiny, so
  // when it is spent use the roomier model before giving up — if there's
  // time left in the function's 60s.
  if (Date.now() - startedAt < 35000) {
    try {
      return { ...(await askGeminiConversation(history, memoryOptions, { ...opts, model: GEMINI_FALLBACK_MODEL, timeoutMs: 15000 })), servedBy: GEMINI_FALLBACK_MODEL };
    } catch (err) {
      console.error("Every text provider failed, including both Gemini models:", err.message);
    }
  }
  return { text: "⚠️ All AI providers failed to respond just now — try again in a moment.", tokensUsed: null };
}
