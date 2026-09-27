// api/miniapp/chats.js
//
// GET    -> list the calling user's chats — pinned first (most-recently-
//           pinned first), then everything else by last activity
// POST   -> create a new chat for the calling user
// PATCH  -> pin or unpin one or more of the calling user's chats
//           (body: { chatIds: [1, 2, 3], pinned: true|false })
// DELETE -> delete one or more of the calling user's chats
//           (body: { chatIds: [1, 2, 3] } or { chatId: 1 })
//
// Every request must carry a valid X-Telegram-Init-Data header (see
// lib/telegramAuth.js) — chats are always scoped to whoever that header
// proves you are; PATCH and DELETE only ever touch chats they can prove
// this user owns. Deleting a chat also deletes its messages (DB cascade,
// see db/schema.js) and every attachment file those messages point at in
// Vercel Blob — this is meant to actually free the storage behind a chat,
// not just remove it from the list.

import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { del } from "@vercel/blob";
import { db } from "../../db/client.js";
import { chats, messages } from "../../db/schema.js";
import { requireTelegramUser } from "../../lib/telegramAuth.js";

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    const rows = await db
      .select()
      .from(chats)
      .where(eq(chats.telegramUserId, user.id))
      // NULLS LAST puts every unpinned chat (pinned_at is null) after every
      // pinned one regardless of the DESC direction; within the pinned
      // group DESC then gives most-recently-pinned first.
      .orderBy(sql`${chats.pinnedAt} DESC NULLS LAST`, desc(chats.updatedAt));
    res.status(200).json(rows);
    return;
  }

  if (req.method === "POST") {
    const [chat] = await db
      .insert(chats)
      .values({ telegramUserId: user.id, title: "New chat" })
      .returning();
    res.status(201).json(chat);
    return;
  }

  if (req.method === "PATCH") {
    const rawIds = Array.isArray(req.body?.chatIds)
      ? req.body.chatIds
      : req.body?.chatId != null
      ? [req.body.chatId]
      : [];
    const chatIds = rawIds.map(Number).filter(Number.isInteger);
    const pinned = !!req.body?.pinned;
    if (chatIds.length === 0) {
      res.status(400).json({ error: "chatId or chatIds is required" });
      return;
    }

    const updated = await db
      .update(chats)
      .set({ pinnedAt: pinned ? new Date() : null })
      .where(and(eq(chats.telegramUserId, user.id), inArray(chats.id, chatIds)))
      .returning({ id: chats.id });

    res.status(200).json({ updated: updated.map((c) => c.id), pinned });
    return;
  }

  if (req.method === "DELETE") {
    const rawIds = Array.isArray(req.body?.chatIds)
      ? req.body.chatIds
      : req.body?.chatId != null
      ? [req.body.chatId]
      : [];
    const chatIds = rawIds.map(Number).filter(Number.isInteger);
    if (chatIds.length === 0) {
      res.status(400).json({ error: "chatId or chatIds is required" });
      return;
    }

    // Ownership check first — only ever delete chats this user actually
    // has, never trust ids on their own.
    const owned = await db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.telegramUserId, user.id), inArray(chats.id, chatIds)));
    const ownedIds = owned.map((c) => c.id);
    if (ownedIds.length === 0) {
      res.status(200).json({ deleted: [] });
      return;
    }

    // Collect every attachment URL across those chats' messages before the
    // cascade delete removes the rows pointing at them — otherwise the
    // files themselves would just sit in Blob storage forever, unreachable
    // from the UI but still taking up (and billing for) space.
    const rows = await db
      .select({ attachments: messages.attachments, attachmentUrl: messages.attachmentUrl })
      .from(messages)
      .where(inArray(messages.chatId, ownedIds));
    const urls = new Set();
    for (const row of rows) {
      if (row.attachmentUrl) urls.add(row.attachmentUrl);
      if (Array.isArray(row.attachments)) {
        for (const a of row.attachments) {
          if (a?.url) urls.add(a.url);
        }
      }
    }
    if (urls.size > 0) {
      try {
        await del([...urls]);
      } catch (err) {
        // A failed Blob cleanup shouldn't block the chat itself from being
        // deleted — worst case is a small orphaned file, not a stuck chat
        // the user can't get rid of.
        console.warn("Failed to delete attachment blobs:", err.message);
      }
    }

    await db.delete(chats).where(inArray(chats.id, ownedIds)); // messages cascade via FK

    res.status(200).json({ deleted: ownedIds });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
