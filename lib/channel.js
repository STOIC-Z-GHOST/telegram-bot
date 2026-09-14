// lib/channel.js
//
// Free-tier bonus for joining the bot's announcement channel: verified
// membership unlocks extra image generations on top of the base free
// allowance. Verification is explicit (via /channelbonus in the DM),
// never automatic — checking Telegram's own membership record on every
// single message would mean an extra Bot API call per message for every
// free user, which isn't worth the latency. Instead the bonus stays
// active for CHANNEL_BONUS_WINDOW_DAYS after the last successful
// /channelbonus run, so someone who joins, verifies, and later leaves the
// channel loses the bonus the next time it would've renewed rather than
// keeping it forever.

import { eq, and, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { channelMemberships } from "../db/schema.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export const CHANNEL_BONUS_IMAGES = 3;
// Matches the image-gen quota's own 30-day window — re-verifying roughly
// as often as that quota renews feels natural rather than arbitrary.
const CHANNEL_BONUS_WINDOW_DAYS = 30;

// The channel's @username (no @), e.g. "assist_ai_updates". Unset means
// the feature is simply off — /channelbonus says so plainly rather than
// erroring.
export function channelUsername() {
  return process.env.TELEGRAM_CHANNEL_USERNAME || null;
}

// Live check against Telegram's own membership record — status values per
// the Bot API: "creator" | "administrator" | "member" | "restricted" |
// "left" | "kicked". Only "left"/"kicked" really mean "not in the
// channel"; a muted/restricted member is still a member.
export async function checkChannelMembership(telegramUserId) {
  const username = channelUsername();
  if (!username || !TELEGRAM_BOT_TOKEN) return { isMember: false, configured: false };

  const resp = await fetchWithTimeout(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=@${username}&user_id=${telegramUserId}`,
    {},
    8000
  );
  const data = await resp.json();
  if (!data.ok) return { isMember: false, configured: true };
  const status = data.result?.status;
  return { isMember: status !== "left" && status !== "kicked", configured: true };
}

export async function recordChannelVerification(telegramUserId) {
  await db
    .insert(channelMemberships)
    .values({ telegramUserId })
    .onConflictDoUpdate({ target: channelMemberships.telegramUserId, set: { verifiedAt: new Date() } });
}

// Used by limitsFor() in lib/limits.js — true only if verified within the
// last CHANNEL_BONUS_WINDOW_DAYS.
export async function hasActiveChannelBonus(telegramUserId) {
  const windowStart = new Date(Date.now() - CHANNEL_BONUS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select()
    .from(channelMemberships)
    .where(and(eq(channelMemberships.telegramUserId, telegramUserId), gte(channelMemberships.verifiedAt, windowStart)));
  return !!row;
}
