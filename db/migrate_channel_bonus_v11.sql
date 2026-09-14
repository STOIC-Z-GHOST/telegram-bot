-- Run this once in Neon's SQL editor. Tracks channel-join verification
-- for the free-tier image-gen bonus — see lib/channel.js.

CREATE TABLE IF NOT EXISTS channel_memberships (
  telegram_user_id BIGINT PRIMARY KEY,
  verified_at TIMESTAMP NOT NULL DEFAULT now()
);
