// api/miniapp/blob-upload.js
//
// The browser never uploads a file through one of our own functions —
// Vercel caps a function's request body at 4.5MB, far below the 50MB
// cap we actually want. Instead, the browser uploads directly to Vercel
// Blob storage, and this route only ever sees a small JSON handshake:
// it hands out a short-lived, size/type-restricted upload token after
// verifying who's asking. The actual file bytes never pass through here.
//
// Auth here works differently from every other mini app endpoint: this
// route isn't called through our own apiFetch() helper — @vercel/blob's
// upload() makes its own internal request to handleUploadUrl and does not
// forward custom headers, so X-Telegram-Init-Data never actually arrives
// here (that was the cause of the 401s). Instead, the frontend passes the
// initData through clientPayload — the field @vercel/blob/client provides
// specifically for getting arbitrary data from the browser call into
// onBeforeGenerateToken below, which is where the docs require you to
// authenticate: skip it and anyone with the URL can upload to your store
// for free.

import { handleUpload } from "@vercel/blob/client";
import { verifyTelegramInitData } from "../../lib/telegramAuth.js";
import { isApproved, isOwner } from "../../lib/access.js";
import { getUserTier } from "../../lib/subscriptions.js";
import { TIER_LIMITS } from "../../lib/limits.js";

// Coarse first gate only — the authoritative per-plan check is by file
// extension in messages.js (checkFileTypeAllowed), because browsers report
// unreliable MIME types for exactly the formats that matter here. This just
// keeps a free user's upload from ever landing in our Blob store for types
// they can't use.
const FREE_CONTENT_TYPES = [
  "image/*",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel", // Windows often labels a plain .csv this way
  "application/octet-stream", // fallback label for .md/.csv on some platforms
];
const PRO_CONTENT_TYPES = [
  ...FREE_CONTENT_TYPES,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/*",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/x-sh",
  "application/sql",
];

// Vercel Blob's handleUpload wants a Web-standard Request, but this
// project uses classic Vercel Functions (req, res) — reconstruct one from
// the Node request so the paths inside handleUpload that expect one still
// see something real to work with.
function toWebRequest(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return new Request(`${protocol}://${host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
}

export default async function handler(req, res) {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: toWebRequest(req),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const user = verifyTelegramInitData(clientPayload, process.env.TELEGRAM_BOT_TOKEN);
        if (!user || !(await isApproved(user.id))) {
          throw new Error("Not authorized");
        }
        const tier = await getUserTier(user.id);
        const maxBytes = isOwner(user.id) ? 500 * 1024 * 1024 : TIER_LIMITS[tier].maxFileBytes;
        return {
          allowedContentTypes: isOwner(user.id) || tier !== "free" ? PRO_CONTENT_TYPES : FREE_CONTENT_TYPES,
          maximumSizeInBytes: maxBytes,
          tokenPayload: JSON.stringify({ telegramUserId: user.id }),
        };
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error("blob-upload handleUpload failed:", err.message);
    res.status(400).json({ error: err.message });
  }
}
