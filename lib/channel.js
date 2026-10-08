// lib/channel.js
//
// The bot's announcement channel. It is NOT a bonus any more (the old
// /channelbonus image-generation reward was removed once free trials existed);
// it is simply where people go for updates and more info about the bot, and the
// /start message points them at it. Verification isn't needed, so this is just
// the username and the join button.

// The channel's @username (no @), e.g. "assist_ai_updates". Unset means the
// join prompt is simply left out — nothing breaks.
export function channelUsername() {
  return process.env.TELEGRAM_CHANNEL_USERNAME || null;
}

// One inline-keyboard row with the join button, or null if no channel is set.
export function channelJoinRow() {
  const username = channelUsername();
  if (!username) return null;
  return [{ text: "📢 Join for updates & info", url: `https://t.me/${username}` }];
}
