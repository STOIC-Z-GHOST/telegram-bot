// api/miniapp/memories.js
//
// GET            -> { memories: [...], limit: MEMORY_LIMIT }
// POST   { content }        -> add a memory manually (fails at the cap)
// PATCH  { id, content }    -> edit an existing memory
// DELETE { id }             -> remove one
//
// Every memory is scoped to the calling Telegram user — lib/memory.js
// checks ownership on every update/delete, so an id from someone else's
// account is simply a 404, never a way to touch their data.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { listMemories, saveMemory, updateMemory, deleteMemory, MEMORY_LIMIT } from "../../lib/memory.js";

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    const memories = await listMemories(user.id);
    res.status(200).json({ memories, limit: MEMORY_LIMIT });
    return;
  }

  if (req.method === "POST") {
    const { content } = req.body || {};
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    const result = await saveMemory(user.id, content);
    if (!result.saved) {
      res.status(409).json({ error: result.reason === "limit" ? "Memory is full" : "Invalid content" });
      return;
    }
    res.status(201).json(result.memory);
    return;
  }

  if (req.method === "PATCH") {
    const { id, content } = req.body || {};
    if (!id || typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "id and content are required" });
      return;
    }
    const memory = await updateMemory(user.id, Number(id), content);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.status(200).json(memory);
    return;
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const deleted = await deleteMemory(user.id, Number(id));
    if (!deleted) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.status(204).end();
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
