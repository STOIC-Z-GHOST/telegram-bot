-- v14: voice-to-text budgeting by audio SECONDS, not just request count.
-- Groq's free Whisper plan limits audio seconds per hour/day as well as
-- requests per day, so we record how many seconds each transcription used.
-- Run this BEFORE deploying the matching code (inserts that include
-- "seconds" fail until the column exists). Safe to run twice.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS seconds INTEGER;
