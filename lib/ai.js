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
const GROQ_MODEL = "openai/gpt-oss-120b";
// Cerebras hosts the same gpt-oss-120b weights Groq does — different
// company, different free-tier quota, same model.
const CEREBRAS_MODEL = "gpt-oss-120b";
// The :free suffix is what makes this free on OpenRouter — dropping it
// would silently switch to a billed route.
const OPENROUTER_MODEL = "openai/gpt-oss-120b:free";
const MISTRAL_MODEL = "mistral-small-latest";

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
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: MISTRAL_API_KEY,
    model: MISTRAL_MODEL,
    // Mistral Small doesn't understand gpt-oss's reasoning_effort param —
    // a thinking-mode request that falls through to Mistral just answers
    // at normal depth instead of erroring out.
    supportsReasoningEffort: false,
  },
];

const SYSTEM_PROMPT =
  "You are a helpful, knowledgeable personal assistant chatting inside a Telegram " +
  "mini app. Match your answer's length and depth to the question — a quick, " +
  "simple question gets a quick, simple answer; go into real detail only when " +
  "the question is genuinely complex or the person is clearly asking for depth " +
  "(or used thinking mode). Plain text only, no markdown headers. " +
  "If asked who you are, what model you are, or who made you: you're this app's " +
  "own AI assistant, running on a mix of AI providers behind the scenes — never " +
  "claim to be ChatGPT, GPT-4, or any other OpenAI product, and don't cite a " +
  "training cutoff date as if you were one of those products. " +
  "When you don't have live search results for THIS message and the question " +
  "needs a specific, verifiable fact you can't actually be sure of — a score, a " +
  "date, a statistic, anything about a recent or time-sensitive event — say so " +
  "plainly and suggest turning on Search, rather than guessing something that " +
  "merely sounds plausible. This holds even mid-conversation: a fact you " +
  "established with Search a turn or two ago doesn't mean a related new detail " +
  "asked about now is also known — if this specific message has no fresh search " +
  "results attached, treat unconfirmed specifics exactly as if Search had never " +
  "been used at all in this chat.";

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
export function buildSystemInstruction({ savedMemories, allowMemorySave, searchResults, cachedSearchContext } = {}) {
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

  return text;
}

// history: [{ role: "user" | "assistant", content: "..." }, ...] in order,
// oldest first. Gemini calls the assistant's turns "model", not "assistant".
// thinking, when true, requests a real reasoning pass — same idea as the DM
// bot's /think in api/telegram-webhook.js.
async function askGeminiConversation(history, memoryOptions, { thinking = false } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body = {
    system_instruction: { parts: [{ text: buildSystemInstruction(memoryOptions) }] },
    contents,
  };
  if (thinking) body.generationConfig = { thinkingConfig: { thinkingBudget: 8192 } };
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, thinking ? 45000 : 20000);
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;
  return { text, tokensUsed };
}

async function askOpenAiCompatible(provider, history, memoryOptions, { thinking = false } = {}) {
  const body = {
    model: provider.model,
    messages: [
      { role: "system", content: buildSystemInstruction(memoryOptions) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
  if (thinking && provider.supportsReasoningEffort) body.reasoning_effort = "high";
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
  const tokensUsed = data?.usage?.total_tokens ?? null;
  return { text, tokensUsed };
}

// One-shot image/PDF analysis for attachments sent in the mini app —
// mirrors api/telegram-webhook.js's askGeminiVision. Deliberately not part
// of the running conversation history/memory machinery above: like the DM
// bot, an attachment is analyzed on its own plus whatever caption came
// with it, not the whole chat's history. No Groq fallback here either,
// same reason as the DM bot — Groq's vision model isn't reliable enough
// to trust as a silent fallback.
//
// fileParts: [{ base64, mimeType }, ...] — up to 5 images sent together,
// or a single PDF. Gemini accepts multiple inline_data parts in one
// request, so all of them go in a single call rather than one per file.
async function askGeminiVisionOnce(prompt, fileParts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
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
  }, 40000); // the real bottleneck for a complex image/PDF — budgeted against messages.js's 60s Vercel ceiling alongside the 15s file download in lib/attachments.js, leaving a margin for the DB writes after
  if (!resp.ok) throw new Error(`Gemini vision error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini vision returned no text");
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;
  return { text, tokensUsed };
}

export async function getVisionReply(prompt, fileParts) {
  try {
    return await askGeminiVisionOnce(prompt, fileParts);
  } catch (err) {
    console.error("Gemini vision failed:", err.message);
    return { text: `⚠️ Couldn't analyze that file right now: ${err.message}`, tokensUsed: null };
  }
}

// Walks TEXT_PROVIDERS in order — Groq first for latency, the rest as
// headroom for days Groq's shared free pool runs dry (see the file-level
// comment above) — then Gemini as the true last resort, same as before.
// A provider with no apiKey configured is skipped with no network call.
// memoryOptions: { savedMemories?: string[], allowMemorySave?: boolean }
// Returns { text, tokensUsed } — tokensUsed comes straight from whichever
// provider answered, or null if every single one failed.
export async function getConversationReply(history, memoryOptions, opts = {}) {
  for (const provider of TEXT_PROVIDERS) {
    if (!provider.apiKey) continue;
    try {
      const result = await askOpenAiCompatible(provider, history, memoryOptions, opts);
      console.log(`${provider.name} answered (${result.tokensUsed ?? "?"} tokens)`);
      return result;
    } catch (err) {
      console.warn(`${provider.name} failed, trying next provider:`, err.message);
    }
  }
  try {
    return await askGeminiConversation(history, memoryOptions, opts);
  } catch (err) {
    console.error("Every text provider failed, including Gemini:", err.message);
    return { text: "⚠️ All AI providers failed to respond just now — try again in a moment.", tokensUsed: null };
  }
}
