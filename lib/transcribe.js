// lib/transcribe.js
//
// Voice-to-text for both surfaces (the mini app's 🎤 button and Telegram
// voice notes sent to the DM bot).
//
//   1. Groq Whisper (whisper-large-v3-turbo) — primary. Reuses the existing
//      GROQ_API_KEY, no new signup. Groq's free tier allows 2,000 requests/day
//      and 28,800 audio-seconds/day account-wide, 25MB per file; every request
//      is billed as at least 10 seconds of audio. Per-user and site-wide
//      budgets that keep us under that live in lib/limits.js.
//   2. Gemini (audio as inline_data) — best-effort fallback on the existing
//      GEMINI_API_KEY for when Groq is rate-limited or down. Gemini documents
//      WAV/MP3/AIFF/AAC/OGG/FLAC; webm and mp4/m4a recordings from some
//      browsers may be rejected, in which case the original Groq error is
//      what the caller sees.
//
// Either provider is skipped with no network call if its key is unset.

import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { GEMINI_MODEL } from "./ai.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

// Groq decides the audio format from the uploaded file's name, so the
// extension has to match what the bytes really are.
const EXT_BY_MIME = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

function baseMime(mimeType) {
  return (mimeType || "").split(";")[0].trim().toLowerCase();
}

export function isSupportedAudioMime(mimeType) {
  return baseMime(mimeType) in EXT_BY_MIME;
}

async function transcribeWithGroq(buffer, mimeType) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
  const ext = EXT_BY_MIME[baseMime(mimeType)] || "ogg";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: baseMime(mimeType) }), `voice.${ext}`);
  form.append("model", GROQ_WHISPER_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
  // No "language" on purpose — Whisper auto-detects, which matters for a
  // multilingual user base.

  const resp = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    { method: "POST", headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: form },
    25000
  );
  if (!resp.ok) {
    throw new Error(`Groq transcription ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.text || "").trim();
}

async function transcribeWithGemini(buffer, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  "Transcribe this audio exactly as spoken, in the language spoken. " +
                  "Reply with ONLY the transcript — no quotes, labels, or commentary. " +
                  "If there is no speech, reply with an empty string.",
              },
              { inline_data: { mime_type: baseMime(mimeType), data: buffer.toString("base64") } },
            ],
          },
        ],
      }),
    },
    25000
  );
  if (!resp.ok) {
    throw new Error(`Gemini transcription ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

// Returns { text, provider }. text may be "" if nothing intelligible was
// said — callers should treat that as "couldn't hear anything", not an error.
// Throws only if every configured provider failed.
export async function transcribeAudio(buffer, mimeType) {
  let groqError;
  try {
    return { text: await transcribeWithGroq(buffer, mimeType), provider: "groq" };
  } catch (err) {
    groqError = err;
    console.error("Groq transcription failed:", err.message);
  }
  try {
    return { text: await transcribeWithGemini(buffer, mimeType), provider: "gemini" };
  } catch (err) {
    console.error("Gemini transcription failed:", err.message);
  }
  throw groqError;
}
