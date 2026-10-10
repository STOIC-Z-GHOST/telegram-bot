// lib/safeUrl.js
//
// Attachment URLs arrive from the browser (the mini app uploads straight to Vercel
// Blob, then tells us "here's the URL"). The server later downloads them — so an
// attacker could send ANY address (an internal service, a cloud metadata endpoint,
// a 50GB file on their own server) and make our function fetch it. Everything that
// downloads a client-supplied URL goes through fetchOwnBlob() below, which:
//   • only allows https URLs on Vercel Blob's own domain (no ports, no credentials),
//   • refuses redirects (a Blob URL never legitimately redirects),
//   • checks the HTTP status, and
//   • stops reading once a size cap is passed (no memory exhaustion).
// sanitizeAttachments() does the same job for the attachments array itself, before it
// is stored or used, and keeps only the four fields the app really uses.

import { fetchWithTimeout } from "./fetchWithTimeout.js";

// Keep in step with MAX_IMAGES in lib/attachments.js (the most files one message can carry).
export const MAX_ATTACHMENTS = 20;

// Shown to the person; safe to display.
export class AttachmentFetchError extends Error {}

const BLOB_HOST = /(^|\.)blob\.vercel-storage\.com$/;

export function isOwnBlobUrl(url) {
  if (typeof url !== "string" || url.length > 600) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return BLOB_HOST.test(u.hostname.toLowerCase());
}

export async function readCapped(resp, maxBytes) {
  const tooBig = () => new AttachmentFetchError(`That file is too large for me to open here (limit ${Math.round(maxBytes / (1024 * 1024))}MB).`);
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  if (!resp.body) {
    const whole = Buffer.from(await resp.arrayBuffer());
    if (whole.length > maxBytes) throw tooBig();
    return whole;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of resp.body) {
    total += chunk.length;
    if (total > maxBytes) throw tooBig(); // leaving the loop cancels the download
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchOwnBlob(url, { timeoutMs = 15000, maxBytes }) {
  if (!isOwnBlobUrl(url)) {
    throw new AttachmentFetchError("That attachment isn't stored in this app, so I can't open it — please upload it again.");
  }
  let resp;
  try {
    resp = await fetchWithTimeout(url, { redirect: "error" }, timeoutMs);
  } catch {
    throw new AttachmentFetchError("I couldn't download that file — please try again.");
  }
  if (!resp.ok) throw new AttachmentFetchError("I couldn't download that file — please try uploading it again.");
  return readCapped(resp, maxBytes);
}

// -> { ok: true, attachments: [{url, name, type, bytes}] } or { ok: false }
export function sanitizeAttachments(raw) {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) return { ok: false };
  const attachments = [];
  for (const a of raw) {
    if (!a || typeof a !== "object" || !isOwnBlobUrl(a.url)) return { ok: false };
    const name = typeof a.name === "string" ? a.name.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 200) : "";
    const type = typeof a.type === "string" ? a.type.replace(/[^\w.+\-/;= ]/g, "").slice(0, 100) : "";
    const bytes = Number.isFinite(a.bytes) && a.bytes >= 0 ? Math.min(Math.floor(a.bytes), 2 ** 40) : 0;
    attachments.push({ url: a.url, name: name || "file", type, bytes });
  }
  return { ok: true, attachments };
}
