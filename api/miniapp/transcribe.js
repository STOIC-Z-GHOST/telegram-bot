// api/miniapp/transcribe.js
//
// POST { audio: <base64>, mimeType: "audio/webm;codecs=opus", seconds: 12 }
//   -> { text: "what the user said" }
//
// Powers the mini app's 🎤 button. The transcript is handed back to the
// browser, which drops it into the message box for the user to review and
// send — this endpoint never sends a chat message itself, so a mis-heard
// word costs nothing. Voice clips are tiny, so they travel as base64 JSON
// through this function instead of the Blob upload route files use; that
// keeps the 4.5MB request-body limit on Vercel functions as the hard ceiling
// (see MAX_VOICE_BYTES).

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { isOwner } from "../../lib/access.js";
import { limitsFor, checkVoiceLimit, recordVoiceUsage, TIER_LIMITS } from "../../lib/limits.js";
import { transcribeAudio, isSupportedAudioMime } from "../../lib/transcribe.js";

// Base64 inflates by a third, so 3MB of audio is ~4MB on the wire — just
// under Vercel's 4.5MB body limit.
const MAX_VOICE_BYTES = 3 * 1024 * 1024;
// Generous bytes-per-second ceiling (real opus/AAC voice is 2-16KB/s). Not a
// precise duration check — the client reports its own length, which we don't
// trust — it just stops someone uploading a long recording labelled "5s".
const MAX_BYTES_PER_SECOND = 16 * 1024;

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { audio, mimeType, seconds } = req.body || {};
  if (typeof audio !== "string" || !audio || !isSupportedAudioMime(mimeType)) {
    res.status(400).json({ error: "bad_request", message: "Couldn't read that recording — try again." });
    return;
  }

  const clipSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));

  const limitCheck = await checkVoiceLimit(user.id, clipSeconds);
  if (!limitCheck.allowed) {
    res.status(429).json({ error: "rate_limited", message: limitCheck.reason });
    return;
  }

  const buffer = Buffer.from(audio, "base64");
  const maxSeconds = isOwner(user.id) ? TIER_LIMITS.premium.maxVoiceSeconds : (await limitsFor(user.id)).maxVoiceSeconds;
  const byteCap = Math.min(MAX_VOICE_BYTES, maxSeconds * MAX_BYTES_PER_SECOND);
  if (buffer.length === 0 || buffer.length > byteCap) {
    res.status(413).json({
      error: "too_long",
      message: `That recording is too long — up to ${maxSeconds} seconds on your plan.`,
    });
    return;
  }

  try {
    const { text } = await transcribeAudio(buffer, mimeType);
    // Count it even when nothing was heard — the provider call was still spent.
    await recordVoiceUsage(user.id, buffer.length);
    if (!text) {
      res.status(200).json({ text: "", message: "Couldn't hear anything — try again a bit closer to the mic." });
      return;
    }
    res.status(200).json({ text });
  } catch (err) {
    console.error("miniapp transcribe failed:", err.message);
    res.status(502).json({ error: "transcription_failed", message: "Couldn't transcribe that right now — please type it instead." });
  }
}
