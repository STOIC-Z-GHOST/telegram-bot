// lib/brandImage.js
//
// Stamps a small "Assist AI" badge (logo + name) in the bottom-LEFT corner of a
// generated image, so a picture that's saved or forwarded still says where it
// came from. It is deliberately placed away from the bottom-right corner, where
// Pollinations puts its own watermark: this ADDS our mark, it never covers
// theirs. (Pollinations removes its watermark itself for accounts with an API
// key — that's the supported route if you ever want it gone; cropping or
// painting over it is not.)
//
// Never makes things worse: on ANY failure it returns the original image
// untouched, so branding can't turn a successful generation into an error.
// Pure JS (jimp 0.22, already used by lib/imageResize.js), no native packages.

import Jimp from "jimp";
import { BADGE_PNG_BASE64 } from "./badgeData.js";

const BADGE_WIDTH_FRACTION = 0.24; // badge is ~24% of the image width
const MARGIN_FRACTION = 0.025;     // gap from the left and bottom edges
const MIN_IMAGE_WIDTH = 256;       // don't stamp thumbnails — it would swamp them

let badgeBuffer; // decoded once per serverless instance
const getBadgeBuffer = () => (badgeBuffer ??= Buffer.from(BADGE_PNG_BASE64, "base64"));

// Returns { buffer, mimeType }. Output is JPEG when it was stamped.
export async function brandImage(buffer, mimeType) {
  try {
    const image = await Jimp.read(buffer);
    const width = image.bitmap.width;
    if (width < MIN_IMAGE_WIDTH) return { buffer, mimeType };

    const badge = await Jimp.read(getBadgeBuffer());
    badge.resize(Math.round(width * BADGE_WIDTH_FRACTION), Jimp.AUTO);

    const margin = Math.round(width * MARGIN_FRACTION);
    const x = margin;
    const y = image.bitmap.height - badge.bitmap.height - margin;
    image.composite(badge, x, y, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 1, opacityDest: 1 });

    const out = await image.quality(90).getBufferAsync(Jimp.MIME_JPEG);
    return { buffer: out, mimeType: Jimp.MIME_JPEG };
  } catch (err) {
    console.warn("brandImage failed, sending the image unbranded:", err.message);
    return { buffer, mimeType };
  }
}
