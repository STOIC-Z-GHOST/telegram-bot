// lib/transcribe.js
//
// Voice-to-text for both surfaces (the mini app's 🎤 button and Telegram
// voice notes sent to the DM bot).
//
//   1. Groq Whisper (whisper-large-v3-turbo) — primary. Reuses the existing
//      GROQ_API_KEY, no new signup. Groq's free plan, account-wide: 20
//      requests/minute, 2,000 requests/day, 7,200 audio-seconds/hour, 28,800
//      audio-seconds/day, 25MB per file; every request counts as at least 10
//      seconds. The per-user and site-wide budgets that keep us under all of
//      that (requests AND seconds) live in lib/limits.js.
// Timeouts are deliberately short: the worst case is Groq timing out and THEN
// Gemini timing out, and that total has to fit inside the function's
// maxDuration in vercel.json (60s for transcribe.js and the DM webhook).
//   2. Gemini (audio as inline_data) — best-effort fallback on the existing
//      GEMINI_API_KEY for when Groq is rate-limited or down. Gemini documents
//      WAV/MP3/AIFF/AAC/OGG/FLAC; webm and mp4/m4a recordings from some
//      browsers may be rejected, in which case the original Groq error is
//      what the caller sees.
//
// Either provider is skipped with no network call if its key is unset.

import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { GEMINI_FALLBACK_MODEL } from "./ai.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";
// Whisper turbo transcribes minutes of audio in a few seconds, so 12s is
// generous; 12 + 15 = 27s worst case before giving up entirely.
const GROQ_TIMEOUT_MS = 12000;
const GEMINI_TIMEOUT_MS = 15000;

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

// The bytes know better than the label: some browsers report an empty or wrong type (a Safari clip labelled webm is really mp4), and
// Groq decides the format from the file name. Returns an extension, or null if the bytes aren't a format we recognise.
export function sniffAudioExt(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (a, b) => buf.toString("latin1", a, b);
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  if (ascii(4, 8) === "ftyp") return "m4a"; // mp4 / m4a container
  if (ascii(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
  return null;
}

function baseMime(mimeType) {
  return (mimeType || "").split(";")[0].trim().toLowerCase();
}

export function isSupportedAudioMime(mimeType) {
  return baseMime(mimeType) in EXT_BY_MIME;
}

// Whisper is known to invent words on silence or background noise ("Thank you.", "Thanks for watching!"), which looks broken to
// someone who tapped the mic and said nothing. verbose_json returns, per segment, how likely it is that no speech was there;
// segments that are probably not speech are dropped, so a silent clip comes back empty ("couldn't hear anything").
const PHANTOM_PHRASES = /^(thank you\.?|thanks\.?|thanks for watching[.!]?|thank you for watching[.!]?|please subscribe[.!]?|bye\.?|you|\.+)$/i;
export function speechFromVerbose(data) {
  const segments = Array.isArray(data?.segments) ? data.segments : null;
  if (!segments || segments.length === 0) return (data?.text || "").trim();
  const kept = segments.filter((seg) => {
    const nsp = Number(seg.no_speech_prob), lp = Number(seg.avg_logprob);
    if (Number.isFinite(nsp) && nsp > 0.8) return false;
    if (Number.isFinite(nsp) && nsp > 0.6 && Number.isFinite(lp) && lp < -1) return false;
    if (Number.isFinite(nsp) && nsp > 0.3 && PHANTOM_PHRASES.test(String(seg.text || "").trim())) return false;
    return true;
  });
  return kept.map((seg) => String(seg.text || "").trim()).filter(Boolean).join(" ").trim();
}

async function transcribeWithGroq(buffer, mimeType) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
  const ext = sniffAudioExt(buffer) || EXT_BY_MIME[baseMime(mimeType)] || "ogg";
  const send = (responseFormat) => {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: baseMime(mimeType) }), `voice.${ext}`);
    form.append("model", GROQ_WHISPER_MODEL);
    form.append("response_format", responseFormat);
    form.append("temperature", "0");
    // No "language" on purpose — Whisper auto-detects, which matters for a
    // multilingual user base.
    return fetchWithTimeout(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      { method: "POST", headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: form },
      GROQ_TIMEOUT_MS
    );
  };

  let resp = await send("verbose_json");
  // If Groq ever stops accepting verbose_json for this model, plain json still works (just without the silence filter).
  if (resp.status === 400 || resp.status === 422) resp = await send("json");
  if (!resp.ok) {
    throw new Error(`Groq transcription ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return speechFromVerbose(await resp.json());
}

async function transcribeWithGemini(buffer, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FALLBACK_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
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
    GEMINI_TIMEOUT_MS
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
// opts.allowShared: true only for someone who turned Extended models on. Without it the Gemini backup (which may keep and let
// staff read the audio) is never used — Groq Whisper only.
export async function transcribeAudio(buffer, mimeType, opts = {}) {
  let groqError;
  try {
    return { text: await transcribeWithGroq(buffer, mimeType), provider: "groq" };
  } catch (err) {
    groqError = err;
    console.error("Groq transcription failed:", err.message);
  }
  if (opts.allowShared === true) {
    try {
      return { text: await transcribeWithGemini(buffer, mimeType), provider: "gemini" };
    } catch (err) {
      console.error("Gemini transcription failed:", err.message);
    }
  }
  throw groqError;
}
