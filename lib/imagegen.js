// lib/imagegen.js
//
// Pollinations.ai image generation for the mini app. A separate,
// deliberately not-shared implementation from api/telegram-webhook.js's
// own askPollinationsImage — that one is already working and untouched;
// duplicating ~8 lines here is cheaper than risking it over reuse.
// Anonymous, free, no API key — rate-limited to roughly 1 request per 15
// seconds, a non-issue for how either surface calls it.

import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { brandImage } from "./brandImage.js";
import { hasBudget, recordSpend } from "./providerBudget.js";

// Pollinations' no-key tier quietly uses a small fast model when you don't pick
// one — an error it returned showed the defaults: model "sana", 768x768. That is
// what made pictures soft and any text gibberish. So ask for Flux at 1024 first;
// if that attempt fails (busy queue, rate limit), try the plain defaults once so
// a bad moment on Flux doesn't mean no image at all. Two attempts at ~22s each
// still fit the 60s function limit (vercel.json) with room for branding/upload.
const POLLINATIONS_URL = "https://image.pollinations.ai/prompt/";
const POLLINATIONS_ATTEMPTS = [
  { label: "flux 1024", query: "?model=flux&width=1024&height=1024", timeoutMs: 16000 },
  { label: "default", query: "", timeoutMs: 14000 },
];

// --- Cloudflare Workers AI (tried first when configured) --------------------
// FLUX.1 [schnell] through Cloudflare's REST API: same Flux family as
// Pollinations' "flux", but on a dedicated, much steadier service. Image volume
// is tiny next to text (a free user gets a few a month), so the shared
// 10,000-neuron daily pool (lib/providerBudget.js) can afford it; if the pool is
// spent this step is skipped and Pollinations takes over. Needs the same
// CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN as the text models.
// Cost per image ≈ 4 tiles (1024x1024) x 4.8 neurons + steps x 9.6 neurons
// (Cloudflare's published per-tile / per-step prices) ≈ 58 at 4 steps.
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_IMAGE_MODEL = process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
const CF_IMAGE_STEPS = Math.min(8, Math.max(1, Number(process.env.CF_IMAGE_STEPS) || 4)); // schnell allows 1-8
const CF_IMAGE_NEURONS = Math.ceil(4 * 4.8 + CF_IMAGE_STEPS * 9.6);
const CF_IMAGE_TIMEOUT_MS = 18000;
const TOTAL_BUDGET_MS = 50000; // every attempt together must fit the 60s function limit (vercel.json)
// A refusal for safety/policy reasons is final — we don't shop the same prompt around
// other providers hoping one lets it through.
const REFUSAL_PATTERN = /nsfw|flagged|safety|policy|moderat|not allowed|inappropriate/i;

async function cloudflareImage(prompt, timeoutMs) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_IMAGE_MODEL}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 2000), steps: CF_IMAGE_STEPS }),
    },
    timeoutMs
  );
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 300);
    console.warn(`Cloudflare image ${resp.status}: ${body}`);
    const err = new Error(`Cloudflare error ${resp.status}`);
    if (resp.status === 400 && REFUSAL_PATTERN.test(body)) err.refused = true;
    throw err;
  }
  let buffer;
  let mimeType = "image/jpeg";
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.startsWith("image/")) {
    // some Workers AI image models (SDXL, ...) return the raw image bytes
    mimeType = contentType;
    buffer = Buffer.from(await resp.arrayBuffer());
  } else {
    // flux-1-schnell wraps a base64 JPEG: { result: { image: "..." } }
    const data = await resp.json();
    const b64 = data?.result?.image;
    if (!b64) throw new Error("Cloudflare returned no image");
    buffer = Buffer.from(b64, "base64");
  }
  await recordSpend("cloudflare", CF_IMAGE_NEURONS); // only a delivered image spends neurons
  return brandImage(buffer, mimeType);
}

export async function generateImage(prompt) {
  let lastError;
  const startedAt = Date.now();
  const timeLeft = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

  if (CF_ACCOUNT_ID && CF_API_TOKEN && (await hasBudget("cloudflare"))) {
    try {
      return await cloudflareImage(prompt, Math.min(CF_IMAGE_TIMEOUT_MS, timeLeft()));
    } catch (err) {
      if (err.refused) throw err;
      lastError = err;
      console.warn("Image attempt \"cloudflare\" failed:", err.message);
    }
  }

  for (const attempt of POLLINATIONS_ATTEMPTS) {
    const timeoutMs = Math.min(attempt.timeoutMs, timeLeft());
    if (timeoutMs < 4000) break; // not enough of the function's time left for a real try
    try {
      const resp = await fetchWithTimeout(`${POLLINATIONS_URL}${encodeURIComponent(prompt)}${attempt.query}`, {}, timeoutMs);
      if (!resp.ok) {
        // Keep the provider's (long, JSON) body in the logs only — never in what a user sees.
        const body = (await resp.text()).slice(0, 300);
        console.warn(`Pollinations (${attempt.label}) ${resp.status}: ${body}`);
        throw new Error(`Pollinations error ${resp.status}`);
      }
      const mimeType = resp.headers.get("content-type") || "image/jpeg";
      const arrayBuffer = await resp.arrayBuffer();
      // Stamp the Assist AI badge (bottom-left; Pollinations' own mark stays untouched).
      return await brandImage(Buffer.from(arrayBuffer), mimeType);
    } catch (err) {
      lastError = err;
      console.warn(`Image attempt "${attempt.label}" failed:`, err.message);
    }
  }
  throw lastError ?? new Error("No image provider available");
}

// What a person is shown when generation fails. The provider's raw error (a wall
// of JSON naming upstream models) is for the logs, not for chat. A failed
// generation never spends image allowance — recordImageUsage only runs on success.
export function friendlyImageError(err) {
  if (err?.refused) return "I can't make that image — try a different idea. This didn't use any of your image allowance.";
  const m = String(err?.message || "");
  const busy = /\b(429|500|502|503|504)\b|timeout|timed out|abort/i.test(m);
  const reason = busy
    ? "The image service is busy right now — please try again in a minute."
    : "I couldn't make that image — try rephrasing the prompt, or try again in a minute.";
  return `${reason} This didn't use any of your image allowance.`;
}

// Does this message plausibly ask for a picture? Used ONLY to protect the Flash
// tier: its small model sometimes misreads "build a simple website" as an image
// request, and every false positive spends one of a free user's few monthly
// image generations. So for Flash the marker instruction is only offered to the
// model when this says yes — see allowImageMarker in api/miniapp/messages.js.
// Stronger models (Standard/Max/Extra) are trusted to judge for themselves.
//
// Two deliberate leniencies, so it can't block real requests:
//   - a few common non-English image words (Oromo, Swahili, Spanish, ...);
//   - text that is mostly NON-Latin script (Amharic, Arabic, ...) always passes,
//     because an English word list can't judge it — the model decides there.
const IMAGE_REQUEST_WORDS = new RegExp(
  "\\b(" +
    [
      "image", "images", "picture", "pictures", "photo", "photos", "pic", "pics",
      "illustration", "illustrate", "drawing", "draw", "sketch", "paint", "painting",
      "artwork", "wallpaper", "logo", "poster", "icon", "avatar", "portrait", "banner",
      "thumbnail", "render", "rendering", "mockup", "mock-up",
      // a few other languages that use Latin script
      "imagen", "imagem", "dibuja", "desenha", "bild", "zeichne", "dessine", "suuraa", "picha", "gambar",
    ].join("|") +
    ")\\b",
  "i"
);
export function plausiblyImageRequest(text) {
  if (!text) return false;
  if (IMAGE_REQUEST_WORDS.test(text)) return true;
  const letters = text.replace(/[^\p{L}]/gu, "");
  const latin = text.replace(/[^\p{Script=Latin}]/gu, "");
  return letters.length > 0 && latin.length / letters.length < 0.5; // mostly non-Latin: let the model decide
}

// Pulls a [GENERATE_IMAGE: ...] marker out of an AI reply, if the model
// included one — see the always-on instruction in lib/ai.js's
// buildSystemInstruction. Lets someone just type "generate an image of a
// cat wearing a hat" in the mini app instead of needing the literal
// /image command.
export function extractImageGenMarker(text) {
  const match = text.match(/\[GENERATE_IMAGE:\s*([^\]]+)\]/);
  return match ? match[1].trim() : null;
}
