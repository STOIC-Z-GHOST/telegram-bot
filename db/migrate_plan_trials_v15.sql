-- v15: Pro promo (first 100 activations, 14 days) and Premium trial (3 days).
-- One row per (user, trial kind) — the primary key is what makes each trial
-- claimable once per account. Run this BEFORE deploying the matching code.
-- Safe to run twice.
CREATE TABLE IF NOT EXISTS plan_trials (
  telegram_user_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP NOT NULL,
  PRIMARY KEY (telegram_user_id, kind)
);
CREATE INDEX IF NOT EXISTS plan_trials_started_idx ON plan_trials(started_at);
