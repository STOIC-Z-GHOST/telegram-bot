// lib/ai.js
//
// Multi-turn Groq (primary, for speed) / Gemini (fallback for text, and
// the only option for vision/documents) calling for the mini app's chat
// threads. This is a sibling to the single-prompt logic already in
// api/telegram-webhook.js, not a replacement for it — the webhook's
// existing DM chat, /image, and document reading are untouched and keep
// working exactly as they do now. This file exists because a "chat" with
// history is the whole point of the mini app, so it's built around a full
// message array instead of one prompt.

import { fetchWithTimeout } from "./fetchWithTimeout.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const GEMINI_MODEL = "gemini-3.6-flash";
const GROQ_MODEL = "openai/gpt-oss-120b";

const SYSTEM_PROMPT =
  "You are a helpful, knowledgeable personal assistant chatting inside a Telegram " +
  "mini app. Give complete, specific answers with real detail — don't artificially " +
  "shorten a good answer just to be brief. Plain text only, no markdown headers.";

// Builds the system instruction for one call. savedMemories (if any) are
// folded in as known facts; allowMemorySave, when true, tells the model it
// may end its reply with a [SAVE_MEMORY: ...] marker — but only when the
// user's latest message actually asked it to remember/save something.
// lib/memory.js strips that marker back out before the reply is shown.
function buildSystemInstruction({ savedMemories, allowMemorySave } = {}) {
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
async function askGeminiConversation(history, memoryOptions) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: buildSystemInstruction(memoryOptions) }] },
      contents,
    }),
  }, 20000);
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;
  return { text, tokensUsed };
}

async function askGroqConversation(history, memoryOptions) {
  const resp = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: buildSystemInstruction(memoryOptions) },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  }, 20000);
  if (!resp.ok) throw new Error(`Groq error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned no text");
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

// Groq first for the same reason as the DM bot's getAiReply in
// telegram-webhook.js — Groq's hardware is built for low-latency
// inference, and it was going unused sitting as a fallback-only option.
// memoryOptions: { savedMemories?: string[], allowMemorySave?: boolean }
// Returns { text, tokensUsed } — tokensUsed comes straight from whichever
// provider answered, or null if both failed.
export async function getConversationReply(history, memoryOptions) {
  try {
    return await askGroqConversation(history, memoryOptions);
  } catch (err) {
    console.warn("Groq failed, falling back to Gemini:", err.message);
    try {
      return await askGeminiConversation(history, memoryOptions);
    } catch (err2) {
      console.error("Gemini also failed:", err2.message);
      return { text: "⚠️ Both Groq and Gemini failed to respond just now — try again in a moment.", tokensUsed: null };
    }
  }
}
