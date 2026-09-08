// lib/attachments.js
//
// Turns uploaded file(s) (already sitting in Vercel Blob by the time this
// runs — see api/miniapp/blob-upload.js) into an AI reply. Mirrors the
// same file-type handling api/telegram-webhook.js already does for DM
// photos/documents, just fed from Blob URLs instead of a Telegram file
// download — with one addition the DM bot doesn't have: up to 5 images
// can be sent together in one message, since Gemini accepts multiple
// images in a single request. Non-image files (PDF/.docx/.txt) still work
// one at a time, same as before.

import mammoth from "mammoth";
import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { getVisionReply, getConversationReply } from "./ai.js";
import { resizeImageIfNeeded } from "./imageResize.js";

// Absolute hard ceiling regardless of tier — defense in depth in case this
// function is ever called from somewhere that skipped the real, tier-aware
// check (checkImageCountLimit in lib/limits.js, applied in messages.js
// before this runs). Matches Premium's own per-message cap.
export const MAX_IMAGES = 20;

const DEFAULT_QUESTION =
  "Look at this file. If it contains a question, problem, or text to solve, " +
  "answer it directly. Otherwise, describe or summarize what's in it.";

const DEFAULT_MULTI_IMAGE_QUESTION =
  "Look at these images together. If they contain a question, problem, or " +
  "text to solve, answer it directly. Otherwise, describe or summarize what's in them.";

// attachments: [{ url, name, type }, ...] — either 1-5 images together, or
// exactly one PDF/.docx/.txt. Mixed-type or multi-non-image batches are
// rejected defensively even though the frontend shouldn't allow them to
// be built in the first place. Returns { text, tokensUsed }.
export async function analyzeAttachments(attachments, caption) {
  if (!attachments || attachments.length === 0) {
    return { text: "⚠️ No file was actually attached.", tokensUsed: null };
  }

  const allImages = attachments.every((a) => (a.type || "").startsWith("image/"));

  if (allImages) {
    if (attachments.length > MAX_IMAGES) {
      return {
        text: `⚠️ Up to ${MAX_IMAGES} images at a time — that was ${attachments.length}.`,
        tokensUsed: null,
      };
    }
    const question =
      (caption || "").trim() || (attachments.length > 1 ? DEFAULT_MULTI_IMAGE_QUESTION : DEFAULT_QUESTION);

    // Download + resize all of them in parallel — independent of each
    // other, no reason to do this one at a time.
    const fileParts = await Promise.all(
      attachments.map(async (a) => {
        const resp = await fetchWithTimeout(a.url, {}, 15000);
        const arrayBuffer = await resp.arrayBuffer();
        const { buffer, mimeType } = await resizeImageIfNeeded(Buffer.from(arrayBuffer), a.type || "image/jpeg");
        return { base64: buffer.toString("base64"), mimeType };
      })
    );
    return await getVisionReply(question, fileParts);
  }

  if (attachments.length > 1) {
    return {
      text: `⚠️ Only one PDF or document at a time — up to ${MAX_IMAGES} images can go together instead.`,
      tokensUsed: null,
    };
  }

  const { url: attachmentUrl, name: attachmentName, type: attachmentType } = attachments[0];
  const question = (caption || "").trim() || DEFAULT_QUESTION;
  const lowerName = (attachmentName || "").toLowerCase();
  const mimeType = attachmentType || "";

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    const resp = await fetchWithTimeout(attachmentUrl, {}, 15000);
    const arrayBuffer = await resp.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return await getVisionReply(question, [{ base64, mimeType: "application/pdf" }]);
  }

  if (mimeType.includes("wordprocessingml") || lowerName.endsWith(".docx")) {
    const resp = await fetchWithTimeout(attachmentUrl, {}, 15000);
    const arrayBuffer = await resp.arrayBuffer();
    const { value: docText } = await mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    if (!docText.trim()) {
      return { text: "⚠️ Couldn't find any text in that .docx file.", tokensUsed: null };
    }
    const prompt = `${question}\n\n--- Document text ---\n${docText.slice(0, 30000)}`;
    return await getConversationReply([{ role: "user", content: prompt }]);
  }

  if (mimeType.startsWith("text/") || lowerName.endsWith(".txt")) {
    const resp = await fetchWithTimeout(attachmentUrl, {}, 15000);
    const docText = await resp.text();
    const prompt = `${question}\n\n--- Document text ---\n${docText.slice(0, 30000)}`;
    return await getConversationReply([{ role: "user", content: prompt }]);
  }

  return {
    text: `I can only read images, PDFs, .docx, and plain text files right now — "${attachmentName}" isn't one of those.`,
    tokensUsed: null,
  };
}
