// Storage: what each person has kept in Vercel Blob (their uploads and the images/files the bot made for them).
//
//   - a per-account quota (TIER_LIMITS[...].storageBytes in lib/limits.js: Free 20 MB, Pro 100 MB, Premium 250 MB)
//   - Settings -> Storage in the mini app: see every file and delete the ones you don't want (api/miniapp/settings.js)
//   - expiry: uploads are deleted after STORAGE_UPLOAD_DAYS (default 7), things the bot made after STORAGE_GENERATED_DAYS
//     (default 30). A daily Vercel Cron call to the webhook runs it (see README -> Storage). The chat keeps the message; the file
//     is shown as "removed".
//
// A file lives in two places: the bytes in Vercel Blob, and a pointer ({ url, name, type, bytes }) inside messages.attachments.
// Deleting always removes the bytes first and only then marks the pointer { removed: true } (the url is dropped), so a failed
// delete never leaves a chat pointing at nothing without anyone knowing — it is simply retried by the next cleanup.
// Blob deletes are free, but uploads (put) are counted against the plan's monthly operation limit, which is why uploads that
// were refused are cleaned up too (discardUnreferencedBlobs).

import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { chats, messages } from "../db/schema.js";
import { isOwner } from "./access.js";

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const envInt = (name, fallback) => { const n = Math.floor(Number(process.env[name])); return n > 0 ? n : fallback; };

export const UPLOAD_RETENTION_DAYS = envInt("STORAGE_UPLOAD_DAYS", 7);
export const GENERATED_RETENTION_DAYS = envInt("STORAGE_GENERATED_DAYS", 30);
// Big files go sooner: anything over STORAGE_LARGE_MB (default 50) is deleted after STORAGE_LARGE_DAYS (default 3) whatever its
// source — a few of them would otherwise fill a person's whole quota (and the shared store) for a week or a month.
export const LARGE_FILE_MB = envInt("STORAGE_LARGE_MB", 50);
export const LARGE_FILE_DAYS = envInt("STORAGE_LARGE_DAYS", 3);
const LIST_ROW_LIMIT = 2000;     // most messages with files looked at for one person
const DELETE_CHUNK = 100;        // urls per blob delete call
const CLEANUP_ROW_LIMIT = 300;   // messages handled per daily run (keeps it well inside the function's time limit)

// ---------------------------------------------------------------------------
// Pure helpers (tested without a database)
// ---------------------------------------------------------------------------

// Only our own Blob storage is ever touched.
export function isBlobUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /\.blob\.vercel-storage\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// rows: [{ messageId, chatId, chatTitle, role, createdAt, attachments }] -> one entry per file that still exists.
// A message the person wrote holds their uploads; a message from the assistant holds things the bot made.
export function flattenStoredFiles(rows) {
  const files = [];
  for (const row of rows) {
    const list = Array.isArray(row.attachments) ? row.attachments : [];
    list.forEach((a, index) => {
      if (!a || typeof a.url !== "string" || a.removed) return;
      files.push({
        messageId: row.messageId,
        index,
        chatId: row.chatId,
        chatTitle: row.chatTitle || "Chat",
        url: a.url,
        name: typeof a.name === "string" && a.name ? a.name : "file",
        type: typeof a.type === "string" ? a.type : "",
        bytes: Math.max(0, Number(a.bytes) || 0),
        source: row.role === "assistant" ? "generated" : "upload",
        createdAt: new Date(row.createdAt),
      });
    });
  }
  return files;
}

export const usedBytes = (files) => files.reduce((sum, f) => sum + f.bytes, 0);

export function retentionDaysFor(source) {
  return source === "generated" ? GENERATED_RETENTION_DAYS : UPLOAD_RETENTION_DAYS;
}
// Days a file is kept: its source's normal period, or the short big-file period if it is over the size threshold (the shorter wins).
export function retentionDaysForFile(file, largeBytes = LARGE_FILE_MB * MB, largeDays = LARGE_FILE_DAYS) {
  const normal = retentionDaysFor(file.source);
  return file.bytes > largeBytes ? Math.min(normal, largeDays) : normal;
}
export function expiresAtFor(file) {
  return new Date(file.createdAt.getTime() + retentionDaysForFile(file) * DAY_MS);
}

const fmtMB = (bytes) => {
  const mb = bytes / MB;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
};
export { fmtMB as formatMegabytes };

// May this person add `adding` more bytes? A person at or over their quota cannot add anything; a person under it can add a file
// that takes them to or below the quota. The owner has no quota.
export function storageDecision({ used, quota, adding = 0, owner = false }) {
  if (owner || !(quota > 0)) return { allowed: true, used, quota, adding };
  if (used >= quota) {
    return { allowed: false, used, quota, adding, reason: `Your storage is full (${fmtMB(used)} of ${fmtMB(quota)}). Delete some files in Settings → Storage, then try again.` };
  }
  if (used + adding > quota) {
    return { allowed: false, used, quota, adding, reason: `That would take you over your ${fmtMB(quota)} of storage (you're using ${fmtMB(used)}). Delete some files in Settings → Storage, or send a smaller one.` };
  }
  return { allowed: true, used, quota, adding };
}

// attachments array -> same array, with the files at `urls` turned into { name, type, bytes, removed: true, removedAt }.
export function markRemoved(attachments, urls, now = new Date()) {
  const gone = urls instanceof Set ? urls : new Set(urls);
  return (Array.isArray(attachments) ? attachments : []).map((a) => {
    if (!a || typeof a.url !== "string" || !gone.has(a.url)) return a;
    return { name: a.name, type: a.type, bytes: a.bytes, removed: true, removedAt: now.toISOString() };
  });
}

// Which files are past their retention? -> [{ messageId, urls: [..] }] (oldest first).
export function selectExpired(rows, now = new Date(), uploadDays = UPLOAD_RETENTION_DAYS, generatedDays = GENERATED_RETENTION_DAYS, largeBytes = LARGE_FILE_MB * MB, largeDays = LARGE_FILE_DAYS) {
  const byMessage = new Map();
  for (const f of flattenStoredFiles(rows)) {
    const normal = f.source === "generated" ? generatedDays : uploadDays;
    const days = f.bytes > largeBytes ? Math.min(normal, largeDays) : normal;
    if (now.getTime() - f.createdAt.getTime() < days * DAY_MS) continue;
    if (!byMessage.has(f.messageId)) byMessage.set(f.messageId, []);
    byMessage.get(f.messageId).push(f.url);
  }
  return [...byMessage.entries()].map(([messageId, urls]) => ({ messageId, urls }));
}

// What the Storage screen shows.
export function describeFiles(files, now = new Date()) {
  return [...files]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((f) => {
      const exp = expiresAtFor(f);
      return {
        url: f.url, name: f.name, type: f.type, bytes: f.bytes, source: f.source, chatTitle: f.chatTitle,
        createdAt: f.createdAt.toISOString(), expiresAt: exp.toISOString(),
        daysLeft: Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / DAY_MS)),
      };
    });
}

// ---------------------------------------------------------------------------
// Blob (real storage) — kept behind small functions so tests can replace them
// ---------------------------------------------------------------------------
export const blobOps = {
  async del(urls) {
    const { del } = await import("@vercel/blob");
    await del(urls);
  },
  async size(url) {
    const { head } = await import("@vercel/blob");
    const info = await head(url);
    return Number(info?.size) || null;
  },
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
// A message that still points at at least one file (a removed file drops its url). Keeps finished messages out of every query, so
// the daily cleanup never wastes its small batch on messages it already emptied.
const hasLiveFile = sql`jsonb_typeof(${messages.attachments}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${messages.attachments}) AS a WHERE jsonb_exists(a, 'url'))`;

async function rowsForUser(telegramUserId, database = db) {
  const rows = await database
    .select({ messageId: messages.id, chatId: messages.chatId, chatTitle: chats.title, role: messages.role, createdAt: messages.createdAt, attachments: messages.attachments })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(and(eq(chats.telegramUserId, telegramUserId), isNotNull(messages.attachments), hasLiveFile))
    .orderBy(desc(messages.createdAt))
    .limit(LIST_ROW_LIMIT);
  return rows;
}

// How much a person has stored, in one aggregate query (no file list): used by the quota checks, the upload gate and the usage bar.
// Files whose size was never recorded count as 0.
export async function storageUsedBytes(telegramUserId, database = db) {
  const r = await database.execute(sql`
    SELECT COALESCE(SUM(CASE WHEN a->>'bytes' ~ '^[0-9]+$' THEN (a->>'bytes')::bigint ELSE 0 END), 0)::bigint AS n
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END) AS a
    WHERE c.telegram_user_id = ${telegramUserId}::bigint AND jsonb_exists(a, 'url')`);
  const rows = Array.isArray(r) ? r : r?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

export async function getStorage(telegramUserId, { quota, now = new Date(), database = db } = {}) {
  const files = flattenStoredFiles(await rowsForUser(telegramUserId, database));
  return {
    usedBytes: usedBytes(files),
    quotaBytes: quota ?? null,
    uploadDays: UPLOAD_RETENTION_DAYS,
    generatedDays: GENERATED_RETENTION_DAYS,
    largeMB: LARGE_FILE_MB,
    largeDays: LARGE_FILE_DAYS,
    files: describeFiles(files, now),
  };
}

// Used by messages.js before accepting an upload or making a file/image. Fails OPEN on a database error (a limiter must not
// take the feature down) — Blob's own plan limit is the backstop.
export async function checkStorageQuota(telegramUserId, addingBytes = 0, { quota, database = db } = {}) {
  try {
    if (isOwner(telegramUserId)) return { allowed: true };
    if (quota == null) {
      const { limitsFor } = await import("./limits.js");
      quota = (await limitsFor(telegramUserId)).storageBytes;
    }
    const used = await storageUsedBytes(telegramUserId, database);
    return storageDecision({ used, quota, adding: addingBytes });
  } catch (err) {
    console.error("storage quota check failed (allowing):", err.message);
    return { allowed: true };
  }
}

// Real sizes for files the browser says it uploaded (the browser's own number could be anything). Falls back to the claimed size.
export async function verifiedAttachments(attachments, ops = blobOps) {
  return Promise.all(
    attachments.map(async (a) => {
      let real = null;
      try { real = await ops.size(a.url); } catch { /* keep the claimed size */ }
      return { ...a, bytes: real ?? Math.max(0, Number(a.bytes) || 0) };
    })
  );
}

async function referencedUrls(urls, database = db) {
  const found = new Set();
  for (const url of urls) {
    const hit = await database
      .select({ id: messages.id })
      .from(messages)
      .where(sql`${messages.attachments} @> ${JSON.stringify([{ url }])}::jsonb`)
      .limit(1);
    if (hit.length > 0) found.add(url);
  }
  return found;
}

// Delete freshly uploaded files that were refused (over the limit, wrong type, rate limited...). Only files that NO message
// points at are removed — so a forged request listing somebody else's file can never delete it.
export async function discardUnreferencedBlobs(urls, { ops = blobOps, database = db } = {}) {
  try {
    const candidates = [...new Set(urls)].filter(isBlobUrl);
    if (candidates.length === 0) return 0;
    const inUse = await referencedUrls(candidates, database);
    const orphans = candidates.filter((u) => !inUse.has(u));
    if (orphans.length > 0) await ops.del(orphans);
    return orphans.length;
  } catch (err) {
    console.error("discarding refused uploads failed:", err.message);
    return 0;
  }
}

async function removeFromBlobAndMessages(rowsWithTargets, { ops = blobOps, database = db, now = new Date() } = {}) {
  // rowsWithTargets: [{ messageId, attachments, urls }]
  const allUrls = [...new Set(rowsWithTargets.flatMap((r) => r.urls))].filter(isBlobUrl);
  const deleted = new Set();
  for (let i = 0; i < allUrls.length; i += DELETE_CHUNK) {
    const chunk = allUrls.slice(i, i + DELETE_CHUNK);
    try {
      await ops.del(chunk);
      chunk.forEach((u) => deleted.add(u));
    } catch (err) {
      console.error("blob delete failed (will be retried):", err.message);
    }
  }
  let messagesUpdated = 0;
  for (const r of rowsWithTargets) {
    const done = r.urls.filter((u) => deleted.has(u));
    if (done.length === 0) continue;
    await database.update(messages).set({ attachments: markRemoved(r.attachments, done, now) }).where(eq(messages.id, r.messageId));
    messagesUpdated++;
  }
  return { filesRemoved: deleted.size, messagesUpdated, failed: allUrls.length - deleted.size };
}

// The person's own request from Settings -> Storage: `urls` (some files) or all = true (everything). Only files that really belong
// to this person's chats can be removed, whatever the request says.
export async function deleteUserFiles(telegramUserId, { urls = [], all = false } = {}, deps = {}) {
  const database = deps.database || db;
  const rows = await rowsForUser(telegramUserId, database);
  const files = flattenStoredFiles(rows);
  const wanted = all ? new Set(files.map((f) => f.url)) : new Set(urls.filter((u) => typeof u === "string"));
  const targets = new Map(); // messageId -> { messageId, attachments, urls }
  for (const f of files) {
    if (!wanted.has(f.url)) continue;
    if (!targets.has(f.messageId)) targets.set(f.messageId, { messageId: f.messageId, attachments: rows.find((r) => r.messageId === f.messageId).attachments, urls: [] });
    targets.get(f.messageId).urls.push(f.url);
  }
  return removeFromBlobAndMessages([...targets.values()], { ops: deps.ops || blobOps, database, now: deps.now || new Date() });
}

// The daily job. Oldest first, a bounded number of messages per run; "more" says whether to expect more tomorrow.
export async function cleanupExpiredFiles({ now = new Date(), ops = blobOps, database = db } = {}) {
  const cutoff = new Date(now.getTime() - Math.min(UPLOAD_RETENTION_DAYS, GENERATED_RETENTION_DAYS, LARGE_FILE_DAYS) * DAY_MS);
  const rows = await database
    .select({ messageId: messages.id, chatId: messages.chatId, chatTitle: chats.title, role: messages.role, createdAt: messages.createdAt, attachments: messages.attachments })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(and(isNotNull(messages.attachments), hasLiveFile, lt(messages.createdAt, cutoff)))
    .orderBy(messages.createdAt)
    .limit(CLEANUP_ROW_LIMIT);
  const expired = selectExpired(rows, now);
  const byId = new Map(rows.map((r) => [r.messageId, r]));
  const targets = expired.map((e) => ({ messageId: e.messageId, attachments: byId.get(e.messageId).attachments, urls: e.urls }));
  const result = await removeFromBlobAndMessages(targets, { ops, database, now });
  return { ...result, looked: rows.length, more: rows.length >= CLEANUP_ROW_LIMIT };
}
