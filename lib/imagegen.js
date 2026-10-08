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

export async function generateImage(prompt) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  const resp = await fetchWithTimeout(url, {}, 30000);
  if (!resp.ok) throw new Error(`Pollinations error ${resp.status}: ${await resp.text()}`);
  const mimeType = resp.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await resp.arrayBuffer();
  // Stamp the Assist AI badge (bottom-left; Pollinations' own mark stays untouched).
  return brandImage(Buffer.from(arrayBuffer), mimeType);
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
