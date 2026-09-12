-- Run this once in Neon's SQL editor. Adds the referral ladder: one row
-- per successfully-referred user. referred_id is unique so a user can
-- only ever be credited to whoever first sent them here; credited_at
-- stays null until that user sends their first real message (not just
-- the /start click) — see lib/referrals.js for the tier ladder itself.

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_id BIGINT NOT NULL,
  referred_id BIGINT NOT NULL UNIQUE,
  credited_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_referrer_id_idx ON referrals(referrer_id);
