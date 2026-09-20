// api/miniapp/messages.js
//
// GET  ?chatId=123 -> full message history for that chat
// POST { chatId, content, attachments? } -> saves the user's message
//        (attachments is an array of { url, name, type, bytes } — up to 5
//        images together, or a single PDF/.docx/.txt, uploaded first via
//        blob-upload.js), gets an AI reply, saves and returns it
//
// Two optional one-shot flags on the POST body, both text-only (ignored
// if attachments are present, same reasoning for both — an attachment
// already goes through its own vision/document path, not the normal
// conversational one these apply to):
//   - thinking: trades speed for depth — see lib/ai.js.
//   - search: looks up current web results before answering — see
//     lib/search.js for the SearXNG -> Tavily -> Gemini-grounding chain.
//
// Two ways to trigger image generation instead of a normal AI reply:
//   - content starting with "/image <description>" (no attachment) — same
//     command as the DM bot's /image, kept consistent across surfaces.
//   - plain natural language ("generate an image of a cat wearing a hat")
//     — the model itself detects this via a [GENERATE_IMAGE: ...] marker
//     (see buildSystemInstruction in lib/ai.js) that gets stripped out and
//     acted on here, the same technique the memory feature already uses
//     for its [SAVE_MEMORY: ...] marker.
//
// Attachments are analyzed on their own (images via vision — together in
// one call if there's more than one — PDF/.docx/.txt via text extraction)
// plus whatever caption came with them — not folded into the running
// conversation history/memory machinery, same choice the DM bot already
// makes for photos and documents.
//
// Every chat is checked against the calling Telegram user's id before any
// read or write — there's no way to touch a chat that isn't yours, even if
// you guess its id.

import { eq, and, asc } from "drizzle-orm";
import { put } from "@vercel/blob";
import { db } from "../../db/client.js";
import { chats, messages } from "../../db/schema.js";
import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { getConversationReply } from "../../lib/ai.js";
import { searchWeb, condenseSearchOutcomeForCache, SEARCH_CACHE_FRESHNESS_MS } from "../../lib/search.js";
import { analyzeAttachments } from "../../lib/attachments.js";
import { generateImage, extractImageGenMarker } from "../../lib/imagegen.js";
import { isMemoryEnabled, listMemories, saveMemory, extractMemoryMarker, MEMORY_LIMIT } from "../../lib/memory.js";
import {
  checkMessageLimit,
  recordMessageUsage,
  recordFileUsage,
  checkImageGenLimit,
  recordImageUsage,
  checkImageCountLimit,
  checkChatAttachmentLimit,
  checkThinkingLimit,
  recordThinkingUsage,
  checkSearchLimit,
  recordSearchUsage,
} from "../../lib/limits.js";

async function loadOwnedChat(chatId, telegramUserId) {
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.telegramUserId, telegramUserId)));
  return chat || null;
}

// Shared by both the explicit "/image" path and the natural-language
// marker path below. Generates via Pollinations, re-uploads to our own
// Blob store (not left pointing at Pollinations' URL) so it stays
// reliably viewable in this chat's history later, and saves the result as
// the assistant's message. Responds on res itself and returns nothing —
// callers just call it and return.
async function generateAndSaveImage(res, chat, userId, prompt) {
  const imageLimitCheck = await checkImageGenLimit(userId);
  if (!imageLimitCheck.allowed) {
    res.status(429).json({ error: "rate_limited", message: imageLimitCheck.reason });
    return;
  }

  let assistantContent;
  let attachment = null;
  try {
    const { buffer, mimeType } = await generateImage(prompt);
    const blob = await put(`generated-images/${chat.id}-${Date.now()}.jpg`, buffer, {
      access: "public",
      contentType: mimeType,
    });
    assistantContent = `Generated: ${prompt}`;
    attachment = { url: blob.url, name: `${prompt.slice(0, 40)}.jpg`, type: mimeType };
  } catch (err) {
    assistantContent = `⚠️ Couldn't generate that image: ${err.message}`;
  }

  await recordMessageUsage(userId, null); // still counts toward messages/hour, no tokens involved
  if (attachment) await recordImageUsage(userId); // don't penalize the monthly cap for a failed attempt

  const [assistantMessage] = await db
    .insert(messages)
    .values({
      chatId: chat.id,
      role: "assistant",
      content: assistantContent,
      attachments: attachment ? [attachment] : null,
    })
    .returning();

  const titleFields = chat.title === "New chat"
    ? { title: prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt }
    : {};
  await db.update(chats).set({ updatedAt: new Date(), ...titleFields }).where(eq(chats.id, chat.id));

  res.status(201).json(assistantMessage);
}

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    const chatId = Number(req.query.chatId);
    if (!chatId) {
      res.status(400).json({ error: "chatId is required" });
      return;
    }
    const chat = await loadOwnedChat(chatId, user.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt));
    res.status(200).json(rows);
    return;
  }

  if (req.method === "POST") {
    const { chatId, content, attachments: rawAttachments, thinking, search } = req.body || {};
    const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
    const hasAttachment = attachments.length > 0;
    const trimmedContent = (content || "").trim();
    const wantsThinking = !!thinking && !hasAttachment; // thinking mode is text-only, same as the DM bot's /think
    const wantsSearch = !!search && !hasAttachment; // search mode is text-only too — an attachment already goes through its own vision/document path below, unrelated to web search

    if (!chatId || (!trimmedContent && !hasAttachment)) {
      res.status(400).json({ error: "chatId and content (or at least one attachment) are required" });
      return;
    }

    // Neither of these needs the other's result, so run them concurrently
    // instead of paying for two sequential round trips.
    const [chat, limitCheck] = await Promise.all([
      loadOwnedChat(Number(chatId), user.id),
      checkMessageLimit(user.id),
    ]);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    if (!limitCheck.allowed) {
      res.status(429).json({ error: "rate_limited", message: limitCheck.reason });
      return;
    }

    if (wantsThinking) {
      const thinkingCheck = await checkThinkingLimit(user.id);
      if (!thinkingCheck.allowed) {
        res.status(429).json({ error: "rate_limited", message: thinkingCheck.reason });
        return;
      }
    }

    if (wantsSearch) {
      const searchCheck = await checkSearchLimit(user.id);
      if (!searchCheck.allowed) {
        res.status(429).json({ error: "rate_limited", message: searchCheck.reason });
        return;
      }
    }

    // Tier-aware: how many images in this one message, and this chat's
    // running lifetime total — both checked before spending anything on
    // download/analysis.
    if (hasAttachment) {
      const allImages = attachments.every((a) => (a.type || "").startsWith("image/"));
      if (allImages) {
        const countCheck = await checkImageCountLimit(user.id, attachments.length);
        if (!countCheck.allowed) {
          res.status(429).json({ error: "rate_limited", message: countCheck.reason });
          return;
        }
      }
      const chatLimitCheck = await checkChatAttachmentLimit(user.id, chat.id, attachments.length);
      if (!chatLimitCheck.allowed) {
        res.status(429).json({ error: "rate_limited", message: chatLimitCheck.reason });
        return;
      }
    }

    const imageMatch = !hasAttachment && trimmedContent.match(/^\/(image|img)\s+([\s\S]+)/i);
    const isBareImageCommand = !hasAttachment && /^\/(image|img)$/i.test(trimmedContent);

    if (isBareImageCommand) {
      res.status(400).json({ error: "bad_command", message: "Send it like: /image a red fox in a snowy forest" });
      return;
    }

    const displayContent = trimmedContent || (hasAttachment
      ? (attachments.length > 1 ? `📎 ${attachments.length} images` : `📎 ${attachments[0].name}`)
      : "");

    await db.insert(messages).values({
      chatId: chat.id,
      role: "user",
      content: displayContent,
      attachments: hasAttachment ? attachments : null,
    });

    // --- Image generation ("/image <description>") ---
    // A completely separate path from the AI text/vision reply below —
    // Pollinations returns image bytes directly, not something that goes
    // through Gemini/Groq at all.
    if (imageMatch) {
      await generateAndSaveImage(res, chat, user.id, imageMatch[2].trim());
      return;
    }

    let rawReply, tokensUsed;
    let searchCacheFields = {}; // merged into the end-of-request chat UPDATE below, only ever set on a successful live search

    if (hasAttachment) {
      const result = await analyzeAttachments(attachments, trimmedContent);
      rawReply = result.text;
      tokensUsed = result.tokensUsed;
      const totalBytes = attachments.reduce((sum, a) => sum + (a.bytes || 0), 0);
      await recordFileUsage(user.id, totalBytes || null);
    } else {
      const history = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chat.id))
        .orderBy(asc(messages.createdAt));
      const historyForAi = history.map((m) => ({ role: m.role, content: m.content }));

      const memoryOn = await isMemoryEnabled(user.id);
      const savedMemories = memoryOn ? (await listMemories(user.id)).map((m) => m.content) : [];
      const memoryOptions = { savedMemories, allowMemorySave: memoryOn };

      // Search mode: try to get web results (or, as a last resort, a
      // fully-written grounded answer) BEFORE asking Groq/Gemini for the
      // real reply, so the results can be handed to whichever of the two
      // actually answers — see lib/search.js for the SearXNG -> Tavily ->
      // Gemini-grounding chain and what each outcome shape means.
      //
      // Search-off messages get one consolation prize instead: if this
      // chat searched recently enough (see SEARCH_CACHE_FRESHNESS_MS), reuse
      // that condensed context rather than answering fully ungrounded —
      // covers a quick "how"/"why" right after a searched reply without
      // spending another search or another full grounding call. No DB
      // write happens on this path; the cache is only ever refreshed by an
      // actual search below.
      let searchOutcome = null;
      if (wantsSearch) {
        searchOutcome = await searchWeb(trimmedContent, historyForAi, memoryOptions, user.id);
      } else if (chat.lastSearchContext && chat.lastSearchAt && Date.now() - chat.lastSearchAt.getTime() < SEARCH_CACHE_FRESHNESS_MS) {
        memoryOptions.cachedSearchContext = chat.lastSearchContext;
      }

      let result;
      if (searchOutcome?.groundedReply) {
        // Gemini already searched and wrote the final answer itself —
        // nothing left to do but use it, same shape as a normal reply.
        result = searchOutcome.groundedReply;
      } else {
        if (searchOutcome?.results) memoryOptions.searchResults = searchOutcome.results;
        result = await getConversationReply(historyForAi, memoryOptions, { thinking: wantsThinking });
      }
      rawReply = result.text;
      tokensUsed = result.tokensUsed;

      // Only overwrites the cache on an actual successful search — a
      // failed/empty one (condenseSearchOutcomeForCache returns null) or a
      // cache-reuse turn (searchOutcome stays null, nothing to condense)
      // both leave whatever's already stored untouched, rather than wiping
      // a still-good previous cache with nothing.
      if (wantsSearch) {
        const condensed = condenseSearchOutcomeForCache(searchOutcome);
        if (condensed) searchCacheFields = { lastSearchContext: condensed, lastSearchAt: new Date() };
      }
    }
    await recordMessageUsage(user.id, tokensUsed);
    if (wantsThinking) await recordThinkingUsage(user.id);
    if (wantsSearch) await recordSearchUsage(user.id);

    // Natural-language image request, detected by the model itself rather
    // than a literal /image command — e.g. "generate an image of a cat
    // wearing a hat". The AI call above already ran (its reply is just the
    // marker, discarded here) — a real trade-off of this approach: one
    // extra round of tokens gets spent versus the explicit /image path,
    // in exchange for not requiring the command at all.
    if (!hasAttachment) {
      const naturalImagePrompt = extractImageGenMarker(rawReply);
      if (naturalImagePrompt) {
        await generateAndSaveImage(res, chat, user.id, naturalImagePrompt);
        return;
      }
    }

    // If the model flagged that the user asked it to remember something,
    // save it and strip the marker out before anyone sees it. If memory's
    // already full, don't save — just say so, rather than silently
    // dropping what they asked to keep. (Attachments never trigger this —
    // analyzeAttachments doesn't pass allowMemorySave — so savedFact is
    // always null on that path.)
    let { visibleReply, savedFact } = extractMemoryMarker(rawReply);
    if (savedFact) {
      const result = await saveMemory(user.id, savedFact);
      if (!result.saved && result.reason === "limit") {
        visibleReply += `\n\n(Your memory is full — ${MEMORY_LIMIT}/${MEMORY_LIMIT} saved. Remove one in Settings to save this.)`;
      }
    }

    const [assistantMessage] = await db
      .insert(messages)
      .values({ chatId: chat.id, role: "assistant", content: visibleReply })
      .returning();

    // Bumping updatedAt keeps the chat list sorted by most-recently-active,
    // and auto-titling a brand-new chat avoids a wall of identical "New
    // chat" entries — combined into one UPDATE instead of two round trips.
    const titleFields = chat.title === "New chat"
      ? (() => {
          const titleSource = trimmedContent || (hasAttachment ? attachments[0].name : null) || "New chat";
          return { title: titleSource.length > 40 ? `${titleSource.slice(0, 40)}…` : titleSource };
        })()
      : {};
    await db.update(chats).set({ updatedAt: new Date(), ...titleFields, ...searchCacheFields }).where(eq(chats.id, chat.id));

    res.status(201).json(assistantMessage);
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
