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
import { fetchOwnBlob, AttachmentFetchError } from "./safeUrl.js";
import { classifyFile, ALL_FILES_SUMMARY } from "./fileTypes.js";
import { getVisionReply, getConversationReply } from "./ai.js";
import { resizeImageIfNeeded } from "./imageResize.js";

// Absolute hard ceiling regardless of tier — defense in depth in case this
// function is ever called from somewhere that skipped the real, tier-aware
// check (checkImageCountLimit in lib/limits.js, applied in messages.js
// before this runs). Matches Premium's own per-message cap.
export const MAX_IMAGES = 20;
// Download ceilings (the plan upload limits go higher, but a function can't usefully hold
// more in memory, and Gemini's inline-file limit is about 20MB anyway).
const MAX_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_DOC_DOWNLOAD_BYTES = 30 * 1024 * 1024;

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
async function analyzeAttachmentsUnsafe(attachments, caption) {
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
        const raw = await fetchOwnBlob(a.url, { timeoutMs: 15000, maxBytes: MAX_IMAGE_DOWNLOAD_BYTES });
        const { buffer, mimeType } = await resizeImageIfNeeded(raw, a.type || "image/jpeg");
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
    const pdf = await fetchOwnBlob(attachmentUrl, { timeoutMs: 15000, maxBytes: MAX_DOC_DOWNLOAD_BYTES });
    const base64 = pdf.toString("base64");
    return await getVisionReply(question, [{ base64, mimeType: "application/pdf" }]);
  }

  if (cls && cls.kind !== "image") {
    const buffer = await fetchOwnBlob(attachmentUrl, { timeoutMs: 20000, maxBytes: MAX_DOC_DOWNLOAD_BYTES });
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

// .docx/.xlsx/.pptx are zip files, and the parsers below (mammoth, exceljs,
// JSZip) inflate the WHOLE archive into memory. A small upload can claim to
// expand enormously (a "zip bomb"), so before parsing anything we read the
// zip's table of contents — a few KB at the end of the file, no inflating —
// and refuse files whose declared uncompressed size is unreasonable.
//
// Limits: an honest Office file is a few MB uncompressed; these leave room
// for big ones while staying well inside a serverless function's memory
// (exceljs in particular turns each cell into a JS object, so it gets the
// smallest budget).
export const MAX_UNCOMPRESSED_BYTES = { docx: 50 * 1024 * 1024, pptx: 50 * 1024 * 1024, xlsx: 30 * 1024 * 1024 };
export const MAX_ZIP_ENTRIES = 5000;

// Returns { total, entries } from the central directory, total = Infinity for
// Zip64 (never produced by Office for files this small, so treated as too
// big); or null if this doesn't look like a zip at all (the parser will then
// report it as corrupted in its own words).
export function zipDeclaredSize(buffer) {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  const searchFrom = buffer.length - 22;
  const searchTo = Math.max(0, searchFrom - 65535);
  let eocd = -1;
  for (let i = searchFrom; i >= searchTo; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const entries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) return { total: Infinity, entries };
  let p = cdOffset;
  let total = 0;
  for (let seen = 0; seen < entries; seen++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CEN_SIG) return null;
    const size = buffer.readUInt32LE(p + 24);
    if (size === 0xffffffff) return { total: Infinity, entries };
    total += size;
    p += 46 + buffer.readUInt16LE(p + 28) + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }
  return { total, entries };
}

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
    if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
      const zip = zipDeclaredSize(buffer);
      if (zip && (zip.total > MAX_UNCOMPRESSED_BYTES[kind] || zip.entries > MAX_ZIP_ENTRIES)) {
        return { error: `⚠️ "${name}" expands to far more data than I can safely read — try saving a smaller copy or exporting just the part you need.` };
      }
    }
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

// A download that is refused (not our Blob host, too big, 404…) becomes a normal
// "⚠️ …" reply instead of an error.
export async function analyzeAttachments(attachments, caption) {
  try {
    return await analyzeAttachmentsUnsafe(attachments, caption);
  } catch (err) {
    if (err instanceof AttachmentFetchError) return { text: `⚠️ ${err.message}`, tokensUsed: null };
    throw err;
  }
}
