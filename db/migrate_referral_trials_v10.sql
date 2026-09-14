-- Run this once in Neon's SQL editor. Tracks the one-time, lifetime
-- 100-invite Pro trial — separate from the rolling referral count so it
-- can't re-fire every time someone's rolling count dips and climbs back
-- over 100. See maybeGrantReferralTrial in lib/referrals.js.

CREATE TABLE IF NOT EXISTS referral_trials (
  telegram_user_id BIGINT PRIMARY KEY,
  granted_at TIMESTAMP NOT NULL DEFAULT now()
);
