// db/schema.js
//
// Two tables: a "chat" is one conversation thread the user can create and
// switch between in the mini app; a "message" belongs to exactly one chat
// and holds either the user's turn or the assistant's reply, in order.

import { pgTable, serial, integer, bigint, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";

export const chats = pgTable(
  "chats",
  {
    id: serial("id").primaryKey(),
    // Telegram user IDs are up to 64-bit — bigint avoids overflow.
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    title: text("title").notNull().default("New chat"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    // Lets a quick follow-up right after a searched reply reuse that
    // search's context instead of triggering a brand-new search or
    // answering ungrounded — see condenseSearchOutcomeForCache in
    // lib/search.js and the reuse block in api/miniapp/messages.js.
    // Both null until the first search in this chat; overwritten (not
    // accumulated) by every search after that, so this only ever holds
    // the most recent one.
    lastSearchContext: text("last_search_context"),
    lastSearchAt: timestamp("last_search_at"),
  },
  (table) => ({
    userIdx: index("chats_telegram_user_id_idx").on(table.telegramUserId),
  })
);

// One row per Telegram user, holding preferences that affect server-side
// behavior (unlike theme, which is purely cosmetic and stays client-side
// in localStorage).
export const userSettings = pgTable("user_settings", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  memoryEnabled: boolean("memory_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Explicit, user-controlled memory — one row per fact the user asked the
// bot to remember (or added manually in Settings). Not tied to any chat;
// capped per user in lib/memory.js, not here.
export const memories = pgTable(
  "memories",
  {
    id: serial("id").primaryKey(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("memories_telegram_user_id_idx").on(table.telegramUserId),
  })
);

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "user" | "assistant"
    content: text("content").notNull(),
    // Legacy single-attachment fields — kept only so messages sent before
    // multi-image support still render correctly. New messages use
    // `attachments` below instead, even for a single file.
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    attachmentType: text("attachment_type"),
    // Up to 5 images together, or a single PDF/.docx/.txt — an array of
    // { url, name, type } objects. The file itself lives in Vercel Blob;
    // this just points at it so the bubble can render thumbnails later.
    attachments: jsonb("attachments"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    chatIdx: index("messages_chat_id_idx").on(table.chatId),
  })
);

// One row per Telegram user who has ever interacted with the access
// system — the whole lifecycle lives in `status`, so this one table is
// the single source of truth for both the DM bot and the mini app:
//   awaiting_reason -> pending -> approved | denied
// The owner (OWNER_CHAT_ID) never gets a row here — they're always
// implicitly approved, checked separately in lib/access.js.
export const accessRequests = pgTable("access_requests", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  status: text("status").notNull(), // awaiting_reason | pending | approved | denied
  displayName: text("display_name"),
  reason: text("reason"),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  decidedAt: timestamp("decided_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// One row per usage event (a message answered, a file processed, or an
// image generated) — a log rather than a running counter, so "messages in
// the last hour" and "images in the last 30 days" are real rolling
// windows (ages out naturally) rather than fixed clock-aligned buckets.
// Tokens come straight from the AI providers' own usage figures in their
// responses, not an estimate.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    kind: text("kind").notNull(), // "message" | "file" | "image"
    tokens: integer("tokens"),
    bytes: integer("bytes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userTimeIdx: index("usage_events_user_time_idx").on(table.telegramUserId, table.createdAt),
  })
);

// Referral ladder — one row per successfully-referred user. referredId is
// unique so a user can only ever be credited to the one referrer who first
// sent them here; creditedAt stays null until that user sends their first
// real message (not just the /start click), which is what actually counts
// toward the referrer's ladder — see lib/referrals.js for the tiers.
export const referrals = pgTable(
  "referrals",
  {
    id: serial("id").primaryKey(),
    referrerId: bigint("referrer_id", { mode: "number" }).notNull(),
    referredId: bigint("referred_id", { mode: "number" }).notNull().unique(),
    creditedAt: timestamp("credited_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    referrerIdx: index("referrals_referrer_id_idx").on(table.referrerId),
  })
);

// One row per user who's ever received the 100-invite Pro trial — a
// separate, lifetime-only flag rather than reusing the rolling referral
// count, specifically so someone can't re-earn the trial every time their
// rolling count dips below 100 and climbs back over it. See
// maybeGrantReferralTrial in lib/referrals.js.
export const referralTrials = pgTable("referral_trials", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
});

// One row per user who has ever verified channel membership. verifiedAt
// is re-stamped each time they successfully re-run /channelbonus — the
// image-gen bonus in lib/channel.js only counts as active within a recent
// window of that timestamp, so it quietly lapses if someone leaves the
// channel and never re-verifies, without the bot needing to poll Telegram
// on every single message.
export const channelMemberships = pgTable("channel_memberships", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  verifiedAt: timestamp("verified_at").notNull().defaultNow(),
});

// One row per Telegram user who has ever subscribed. A missing row (or a
// row whose expiresAt has passed) means "free tier" — there's no explicit
// cancellation flow to handle: Telegram's own subscription UI lets a user
// cancel any time, and a lapsed/canceled subscription simply stops
// renewing, so checking expiresAt against now() is enough to self-heal
// back to free without needing to react to a cancellation event at all.
export const subscriptions = pgTable("subscriptions", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  tier: text("tier").notNull(), // "pro" | "premium"
  status: text("status").notNull(), // "active" | "lapsed"
  telegramChargeId: text("telegram_charge_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Editable Stars prices, so /setprice can change them without a redeploy.
// Missing rows fall back to the hardcoded defaults in lib/subscriptions.js
// — the table only needs a row once someone actually changes a price.
export const planPrices = pgTable("plan_prices", {
  tier: text("tier").primaryKey(), // "pro" | "premium"
  priceStars: integer("price_stars").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
