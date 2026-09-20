-- Run this once in Neon's SQL editor. Lets a quick follow-up right after a
-- searched reply reuse that search's context instead of triggering a new
-- search or answering ungrounded — see condenseSearchOutcomeForCache in
-- lib/search.js and the reuse block in api/miniapp/messages.js.

ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_search_context TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_search_at TIMESTAMP;
