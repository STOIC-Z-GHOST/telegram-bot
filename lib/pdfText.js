// lib/pdfText.js
//
// Reads the text that is already inside a PDF, on our own server, with no AI service involved.
//
// Why: for people who have NOT turned Extended models on (most people), a PDF used to go to Mistral OCR, which is billed per page out of
// the same small monthly credit as chat, takes seconds, needs the Mistral key to allow OCR, and sends the whole document to another
// company. Most PDFs (exported from Word, a website, a textbook, an exam paper) already contain their text, so reading it locally is
// instant, free, private and independent of any provider. Only PDFs that are really pictures of pages (scans, photos) have no text and
// still go to OCR.
//
// Uses unpdf (the serverless build of PDF.js; no native code, no worker). Anything unusual — encrypted file, damaged file, too little
// text, text that is mostly garbage because the PDF's fonts have no mapping to characters — returns null so the caller falls back to
// OCR exactly as before. Reading never throws.

import { getDocumentProxy } from "unpdf";
import { ocrToText, MAX_OCR_CHARS } from "./ocr.js";

const MAX_LOCAL_PDF_BYTES = 25 * 1024 * 1024; // refuse to open anything bigger (memory)
const MAX_PAGES_READ = 200;                   // never walk more pages than this
const TIME_BUDGET_MS = 12000;                 // stop reading when this much of the function's time has gone
// A PDF counts as "has real text" only if it has a reasonable amount of it per page; a scan with a stray page number does not.
const MIN_TOTAL_CHARS = 60;
const MIN_AVG_CHARS_PER_PAGE = 60;

// Text from fonts without a character mapping comes out as replacement characters, private-use glyphs or control characters.
export function looksGarbled(text) {
  const visible = text.replace(/\s+/g, "");
  if (visible.length === 0) return true;
  const bad = (visible.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000E-\u001F]/g) || []).length;
  return bad / visible.length > 0.03;
}

const joinItems = (items) => items.map((it) => (typeof it.str === "string" ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");

// -> { text, pages, truncated } in the same shape as OCR, or null when the PDF has no usable text layer.
export async function pdfTextLayer(base64, { maxChars = MAX_OCR_CHARS, budgetMs = TIME_BUDGET_MS } = {}) {
  let pdf;
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_LOCAL_PDF_BYTES) return null;
    const started = Date.now();
    pdf = await getDocumentProxy(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
    const totalPages = pdf.numPages;
    const limit = Math.min(totalPages, MAX_PAGES_READ);
    let out = "";
    let pagesRead = 0;
    let truncated = totalPages > limit;
    for (let i = 1; i <= limit; i++) {
      if (Date.now() - started > budgetMs) { truncated = true; break; }
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pagesRead++;
      const text = joinItems(content.items).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text) out += `## Page ${i}\n${text}\n\n`;
      if (out.length > maxChars) { truncated = true; break; }
    }
    out = out.trim();
    const letters = out.replace(/\s+/g, "").replace(/## Page \d+/g, "").length;
    if (pagesRead === 0 || letters < MIN_TOTAL_CHARS || letters / pagesRead < MIN_AVG_CHARS_PER_PAGE || looksGarbled(out)) return null;
    return { text: out.slice(0, maxChars), pages: totalPages, truncated: truncated || out.length > maxChars };
  } catch (err) {
    console.warn("PDF text layer not readable (will try OCR):", err.message);
    return null;
  } finally {
    try { await pdf?.destroy(); } catch { /* nothing to clean up */ }
  }
}

// The PDF's own text if it has any, otherwise OCR. -> { text, pages, truncated, source: "text" | "ocr" } or null.
// An OCR error is thrown (the callers log it and move on), same as before.
export async function readPdfAsText(base64) {
  const local = await pdfTextLayer(base64);
  if (local) return { ...local, source: "text" };
  const ocr = await ocrToText(base64, "application/pdf");
  return ocr ? { ...ocr, source: "ocr" } : null;
}
