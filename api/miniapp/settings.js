// api/miniapp/settings.js
//
// GET  -> the calling user's settings:
//           memoryEnabled
//           dataSharing: { allow, choice, needsAnswer, version }   ("Extended models", see lib/dataSharing.js)
//           dataSharingCopy: the wording the screen and the first-run sheet show (lib/dataUse.js — one copy for every surface)
// GET  ?section=storage -> Settings -> Storage: { usedBytes, quotaBytes (null = no limit), uploadDays, generatedDays,
//           files: [{ url, name, type, bytes, source: "upload"|"generated", chatTitle, createdAt, expiresAt, daysLeft }] } (lib/storage.js)
// POST { memoryEnabled }  and/or  { dataSharing }  (booleans) -> update them
// POST { storageDelete: { urls: [...] } | { all: true } } -> delete those of the caller's own files; answers with the fresh storage view
//
// This is separate from the theme toggle on purpose — theme is purely
// cosmetic and lives in the browser's localStorage, but these settings change
// how messages.js actually answers, so they have to be readable from the
// backend regardless of which device or session is asking.

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { userSettings } from "../../db/schema.js";
import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { dataSharingFromRow, setDataSharing } from "../../lib/dataSharing.js";
import { DATA_SHARING_COPY } from "../../lib/dataUse.js";
import { getStorage, deleteUserFiles } from "../../lib/storage.js";
import { limitsFor } from "../../lib/limits.js";
import { isOwner } from "../../lib/access.js";

const MAX_DELETE_URLS = 200;

// The whole Storage view for one person: their files, what they use, what their plan allows.
async function storageView(userId) {
  const quota = isOwner(userId) ? null : (await limitsFor(userId)).storageBytes;
  return getStorage(userId, { quota });
}

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method === "GET" && req.query?.section === "storage") {
    try {
      res.status(200).json(await storageView(user.id));
    } catch (err) {
      console.error("storage view failed:", err);
      res.status(500).json({ error: "storage_unavailable", message: "Couldn't load your storage right now — please try again." });
    }
    return;
  }

  if (req.method === "GET") {
    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.telegramUserId, user.id));
    res.status(200).json({
      memoryEnabled: row?.memoryEnabled ?? false,
      dataSharing: dataSharingFromRow(row),
      dataSharingCopy: DATA_SHARING_COPY,
    });
    return;
  }

  if (req.method === "POST" && req.body && req.body.storageDelete !== undefined) {
    const del = req.body.storageDelete;
    const all = del?.all === true;
    const urls = Array.isArray(del?.urls) ? del.urls : null;
    if (!all && (!urls || urls.length === 0 || urls.length > MAX_DELETE_URLS || urls.some((u) => typeof u !== "string" || u.length > 2048))) {
      res.status(400).json({ error: "bad_request", message: "Pick the files you want to delete." });
      return;
    }
    try {
      const result = await deleteUserFiles(user.id, all ? { all: true } : { urls });
      res.status(200).json({ ...result, storage: await storageView(user.id) });
    } catch (err) {
      console.error("storage delete failed:", err);
      res.status(500).json({ error: "storage_unavailable", message: "Couldn't delete those right now — please try again." });
    }
    return;
  }

  if (req.method === "POST") {
    const { memoryEnabled, dataSharing } = req.body || {};
    const hasMemory = memoryEnabled !== undefined;
    const hasSharing = dataSharing !== undefined;
    if (!hasMemory && !hasSharing) {
      res.status(400).json({ error: "send memoryEnabled and/or dataSharing" });
      return;
    }
    if (hasMemory && typeof memoryEnabled !== "boolean") {
      res.status(400).json({ error: "memoryEnabled must be a boolean" });
      return;
    }
    if (hasSharing && typeof dataSharing !== "boolean") {
      res.status(400).json({ error: "dataSharing must be a boolean" });
      return;
    }
    const out = {};
    if (hasMemory) {
      await db
        .insert(userSettings)
        .values({ telegramUserId: user.id, memoryEnabled })
        .onConflictDoUpdate({
          target: userSettings.telegramUserId,
          set: { memoryEnabled, updatedAt: new Date() },
        });
      out.memoryEnabled = memoryEnabled;
    }
    if (hasSharing) out.dataSharing = await setDataSharing(user.id, dataSharing);
    res.status(200).json(out);
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
