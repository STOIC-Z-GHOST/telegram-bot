// lib/access.js
//
// Single source of truth for who's allowed to use the bot — both the DM
// webhook and the mini app check through here, so access can never drift
// out of sync between the two surfaces. The owner is defined by
// OWNER_CHAT_ID and is always implicitly approved; everyone else's status
// lives in the access_requests table, which doubles as the request's full
// history: awaiting_reason -> pending -> approved | denied.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { accessRequests } from "../db/schema.js";

const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ? Number(process.env.OWNER_CHAT_ID) : null;

export function isOwner(telegramUserId) {
  return OWNER_CHAT_ID != null && Number(telegramUserId) === OWNER_CHAT_ID;
}

export function getOwnerChatId() {
  return OWNER_CHAT_ID;
}

export async function getAccessStatus(telegramUserId) {
  if (isOwner(telegramUserId)) return "owner";
  const [row] = await db
    .select()
    .from(accessRequests)
    .where(eq(accessRequests.telegramUserId, telegramUserId));
  return row?.status || "none";
}

export async function isApproved(telegramUserId) {
  const status = await getAccessStatus(telegramUserId);
  return status === "owner" || status === "approved";
}

// The bot is public now — anyone who isn't banned (see removeUser below)
// gets an "approved" row the moment they first show up, no owner review
// needed. Kept as a real row (not just a bypass in the gate check) so
// /users still lists them and /remove still works as a ban.
export async function autoApproveUser(telegramUserId, displayName) {
  await db
    .insert(accessRequests)
    .values({ telegramUserId, status: "approved", displayName, decidedAt: new Date() })
    .onConflictDoUpdate({
      target: accessRequests.telegramUserId,
      set: { status: "approved", displayName, decidedAt: new Date(), updatedAt: new Date() },
    });
}

// Kicks off (or restarts) a request — puts the user in "awaiting_reason"
// so their very next text message gets treated as their reason. Left in
// place for the callback handlers that still reference it, but the
// webhook's gate no longer routes new users through it — see
// autoApproveUser above.
export async function startAccessRequest(telegramUserId, displayName) {
  await db
    .insert(accessRequests)
    .values({ telegramUserId, status: "awaiting_reason", displayName })
    .onConflictDoUpdate({
      target: accessRequests.telegramUserId,
      set: { status: "awaiting_reason", displayName, updatedAt: new Date() },
    });
}

// Only actually submits if the user is genuinely mid-request — protects
// against a stray text message being mistaken for a reason.
export async function submitAccessReason(telegramUserId, reason) {
  const [row] = await db
    .select()
    .from(accessRequests)
    .where(eq(accessRequests.telegramUserId, telegramUserId));
  if (!row || row.status !== "awaiting_reason") return null;

  const [updated] = await db
    .update(accessRequests)
    .set({
      status: "pending",
      reason: reason.trim().slice(0, 500),
      requestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(accessRequests.telegramUserId, telegramUserId))
    .returning();
  return updated;
}

export async function decideAccessRequest(telegramUserId, approved) {
  const [updated] = await db
    .update(accessRequests)
    .set({ status: approved ? "approved" : "denied", decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(accessRequests.telegramUserId, telegramUserId))
    .returning();
  return updated || null;
}

// Revoking access reuses "denied" rather than deleting the row — keeps
// the history and means re-requesting later works the same way it would
// for anyone else who was denied.
export async function removeUser(telegramUserId) {
  return decideAccessRequest(telegramUserId, false);
}

export async function listApprovedUsers() {
  return db.select().from(accessRequests).where(eq(accessRequests.status, "approved"));
}

export async function listPendingRequests() {
  return db.select().from(accessRequests).where(eq(accessRequests.status, "pending"));
}
