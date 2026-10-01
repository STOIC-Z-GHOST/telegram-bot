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
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { classifyFile, ALL_FILES_SUMMARY } from "./fileTypes.js";
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
  const cls = classifyFile(attachmentName, attachmentType);

  if (cls?.kind === "pdf") {
    const resp = await fetchWithTimeout(attachmentUrl, {}, 15000);
    const arrayBuffer = await resp.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return await getVisionReply(question, [{ base64, mimeType: "application/pdf" }]);
  }

  if (cls && cls.kind !== "image") {
    const resp = await fetchWithTimeout(attachmentUrl, {}, 20000);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const extracted = await extractDocumentText(buffer, cls.kind, attachmentName);
    if (extracted.error) return { text: extracted.error, tokensUsed: null };
    return await getConversationReply([
      { role: "user", content: buildDocumentPrompt(question, extracted.text, extracted.truncated) },
    ]);
  }

  return {
    text: `I can read ${ALL_FILES_SUMMARY} — "${attachmentName}" isn't one of those.`,
    tokensUsed: null,
  };
}

// ---------------------------------------------------------------------------
// Text extraction — shared by the mini app (above) and the DM bot
// (api/telegram-webhook.js), so both surfaces read every format identically.
// ---------------------------------------------------------------------------

// Only the first chunk of a document ever reaches the model (see
// buildDocumentPrompt), so there's no point parsing past it.
export const MAX_DOC_CHARS = 30000;

// Office files are parsed fully in memory inside a serverless function, so
// they get a parse-size ceiling well below the plan's upload cap (Pro allows
// 200MB uploads — fine for a PDF Gemini reads directly, not for exceljs).
const MAX_OFFICE_PARSE_BYTES = 15 * 1024 * 1024;

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if ("result" in value && value.result !== undefined) return cellToString(value.result); // formula -> its computed value
    if ("formula" in value) return `=${value.formula}`; // never calculated (file wasn't saved by Excel) — show the formula itself
    if ("text" in value) return cellToString(value.text); // hyperlink
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

async function extractXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  let out = "";
  let truncated = false;
  for (const sheet of workbook.worksheets) {
    out += `## Sheet: ${sheet.name}\n`;
    for (let r = 1; r <= sheet.rowCount; r++) {
      const values = sheet.getRow(r).values; // 1-based, may have holes
      const cells = [];
      for (let c = 1; c < values.length; c++) cells.push(cellToString(values[c]));
      if (cells.every((c) => c === "")) continue;
      out += cells.join("\t") + "\n";
      if (out.length > MAX_DOC_CHARS) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return { text: out, truncated };
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  let out = "";
  let truncated = false;
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i]).async("string");
    const paragraphs = xml
      .split("</a:p>")
      .map((para) => [...para.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1])).join(""))
      .filter((line) => line.trim() !== "");
    out += `## Slide ${i + 1}\n${paragraphs.join("\n")}\n\n`;
    if (out.length > MAX_DOC_CHARS) {
      truncated = true;
      break;
    }
  }
  return { text: out, truncated };
}

// kind comes from classifyFile(). Returns { text, truncated } on success or
// { error } (already user-facing wording) on failure.
export async function extractDocumentText(buffer, kind, name = "that file") {
  try {
    let result;
    if (kind === "docx") {
      const { value } = await mammoth.extractRawText({ buffer });
      result = { text: value, truncated: value.length > MAX_DOC_CHARS };
    } else if (kind === "xlsx" || kind === "pptx") {
      if (buffer.length > MAX_OFFICE_PARSE_BYTES) {
        return { error: `⚠️ "${name}" is too large for me to read as a spreadsheet/presentation (limit ${MAX_OFFICE_PARSE_BYTES / (1024 * 1024)}MB) — try exporting just the part you need.` };
      }
      result = kind === "xlsx" ? await extractXlsx(buffer) : await extractPptx(buffer);
    } else if (kind === "text") {
      if (buffer.includes(0)) {
        return { error: `⚠️ "${name}" looks like a binary file, not text — I can't read it.` };
      }
      const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
      result = { text, truncated: text.length > MAX_DOC_CHARS };
    } else {
      return { error: `⚠️ I can't read that kind of file.` };
    }
    if (!result.text.trim()) {
      return { error: `⚠️ Couldn't find any text in "${name}".` };
    }
    return result;
  } catch (err) {
    console.error(`extractDocumentText(${kind}) failed:`, err.message);
    return { error: `⚠️ Couldn't read "${name}" — it may be corrupted or password-protected.` };
  }
}

export function buildDocumentPrompt(question, docText, truncated) {
  const body = docText.slice(0, MAX_DOC_CHARS);
  const note = truncated || docText.length > MAX_DOC_CHARS
    ? "\n\n[Note: the file was longer than this — only the beginning is shown above.]"
    : "";
  return `${question}\n\n--- Document text ---\n${body}${note}`;
}
