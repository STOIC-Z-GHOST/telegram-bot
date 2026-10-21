-- v16: "Extended models" — each person chooses whether their chats may go to AI providers that can keep, use or let
-- staff read them (see lib/dataUse.js and lib/dataSharing.js).
--   data_sharing          NULL = never asked (treated as NO), false = keep private, true = Extended models on
--   data_sharing_version  which wording version they answered
--   data_sharing_at       when — a record of what each person agreed to
-- Run this BEFORE deploying the matching code (the settings API selects these columns, so it fails until they exist).
-- Safe to run twice. Everyone starts as NULL: they are asked on their next visit and served by private models until then.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS data_sharing BOOLEAN;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS data_sharing_version INTEGER;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS data_sharing_at TIMESTAMP;
