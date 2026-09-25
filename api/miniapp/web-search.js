// api/miniapp/web-search.js
//
// POST { query } -> raw web search results for the mini app's standalone
// search tab (the 🔍 button next to the chat list's + button). Deliberately
// NOT routed through the AI — this returns actual links/snippets, not a
// model-written summary, for when the user wants to see real sources
// themselves rather than something Groq/Gemini wrote from them.
//
// Reuses the exact same SearXNG -> Tavily -> Gemini-grounding chain as the
// composer's 🔍 Search toggle (see lib/search.js) and the same daily search
// cap (checkSearchLimit in lib/limits.js) — it's the same underlying cost
// either way, so this entry point doesn't get its own separate/looser limit.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { searchWeb } from "../../lib/search.js";
import { checkSearchLimit, recordSearchUsage } from "../../lib/limits.js";

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const query = (req.body?.query || "").trim();
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const searchCheck = await checkSearchLimit(user.id);
  if (!searchCheck.allowed) {
    res.status(429).json({ error: "rate_limited", message: searchCheck.reason });
    return;
  }

  // No conversation history/memory to hand it — this is a bare lookup, not
  // a chat turn. Only matters if the chain falls all the way through to
  // Gemini grounding, which then answers the query on its own.
  const outcome = await searchWeb(query, [], {}, user.id);
  // Recorded whenever a search was attempted, win or lose — same rule the
  // composer's Search toggle follows (see api/miniapp/messages.js), so this
  // tab draws from the same daily budget rather than a free side door.
  await recordSearchUsage(user.id);

  if (outcome?.results?.length) {
    res.status(200).json({ results: outcome.results });
    return;
  }
  if (outcome?.groundedReply?.text) {
    // SearXNG and Tavily both failed, but Gemini's grounding fallback still
    // wrote something — surfaced as a labeled summary on the frontend
    // rather than dropped, even though it's not a plain link list.
    res.status(200).json({ summary: outcome.groundedReply.text });
    return;
  }
  res.status(200).json({ results: [] });
}
