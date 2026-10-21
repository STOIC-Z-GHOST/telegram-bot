// lib/dataSharing.js
//
// Where a person's "Extended models" choice is stored and read (the wording and the provider list are in lib/dataUse.js).
//
//   null   -> never asked (or said yes to older wording): treated as NO until they answer
//   false  -> keep my chats private
//   true   -> Extended models on (only counts if they said yes to the CURRENT wording version)
//
// Reading fails CLOSED: if the database can't be read, nobody is sent to shared providers.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSettings } from "../db/schema.js";
import { DATA_SHARING_VERSION } from "./dataUse.js";

// Pure, so it can be tested without a database. `row` is a user_settings row or undefined.
export function dataSharingFromRow(row) {
  const choice = typeof row?.dataSharing === "boolean" ? row.dataSharing : null;
  const current = row?.dataSharingVersion === DATA_SHARING_VERSION;
  const allow = choice === true && current;
  return {
    allow, // true only for a YES to the current wording
    choice: choice === true && !current ? null : choice, // a yes to old wording counts as "not answered"
    needsAnswer: choice === null || (choice === true && !current),
    version: DATA_SHARING_VERSION,
  };
}

export async function getDataSharing(telegramUserId) {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.telegramUserId, telegramUserId));
  return dataSharingFromRow(row);
}

// The one question every AI call asks. Never throws.
export async function allowsSharedModels(telegramUserId) {
  try {
    return (await getDataSharing(telegramUserId)).allow;
  } catch (err) {
    console.warn("allowsSharedModels failed, treating as private:", err.message);
    return false;
  }
}

export async function setDataSharing(telegramUserId, choice) {
  const values = { dataSharing: !!choice, dataSharingVersion: DATA_SHARING_VERSION, dataSharingAt: new Date() };
  await db
    .insert(userSettings)
    .values({ telegramUserId, ...values })
    .onConflictDoUpdate({ target: userSettings.telegramUserId, set: { ...values, updatedAt: new Date() } });
  return dataSharingFromRow({ dataSharing: values.dataSharing, dataSharingVersion: values.dataSharingVersion });
}
