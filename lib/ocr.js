// lib/ocr.js
//
// Mistral OCR (https://api.mistral.ai/v1/ocr) — turns a scanned/photographed
// PDF or image into Markdown text. Reuses the existing MISTRAL_API_KEY, so
// there is nothing new to sign up for, and it's skipped with no network call
// when that key isn't set.
//
// Used ONLY as a safety net, not on the normal path: PDFs normally go to
// Gemini, which reads them natively (including scans). When Gemini fails —
// most often its small free-tier quota running out — lib/ai.js and the DM
// bot hand the PDF here instead, then answer from the extracted text with
// the regular text models. Before this existed, a PDF that Gemini couldn't
// read had nowhere to fall back to.
//
// Cost: billed per page (about $4 per 1,000 pages when last checked — confirm
// on mistral.ai/pricing). Because it only runs when Gemini has already
// failed, real usage is a small fraction of PDF uploads. The 10MB cap below
// stops one huge file from running up the page count.
//
// Privacy: the document is sent to Mistral. If MISTRAL_API_KEY is on the free
// "Experiment" tier, Mistral may use submitted data for training (see the
// note on MISTRAL_API_KEY in lib/ai.js) — the same call you already made for
// chat text applies, and arguably matters more for whole documents.

import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { hasBudget, recordSpend } from "./providerBudget.js";

// Mistral OCR is billed per page (about $4 per 1,000 pages on the current
// rate card) out of the SAME $10/month credit as chat, so it is tracked in
// lib/providerBudget.js and refused once that shared budget is spent.
const OCR_MICROUSD_PER_PAGE = 4000;

const MAX_OCR_BYTES = 10 * 1024 * 1024;
export const MAX_OCR_CHARS = 30000;

export function ocrAvailable() {
  return !!process.env.MISTRAL_API_KEY;
}

// Returns { text, pages, truncated } or null when OCR can't/shouldn't run
// (no key, file too big, nothing extracted). Throws on an API error so the
// caller can log it and move on.
export async function ocrToText(base64, mimeType) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return null;
  if (Math.floor((base64.length * 3) / 4) > MAX_OCR_BYTES) return null;
  if (!(await hasBudget("mistral"))) return null; // shared Mistral credit is spent

  const document =
    mimeType === "application/pdf"
      ? { type: "document_url", document_url: `data:application/pdf;base64,${base64}` }
      : { type: "image_url", image_url: `data:${mimeType};base64,${base64}` };

  const resp = await fetchWithTimeout(
    "https://api.mistral.ai/v1/ocr",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "mistral-ocr-latest", document }),
    },
    20000
  );
  if (!resp.ok) throw new Error(`Mistral OCR ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  const data = await resp.json();
  const pages = Array.isArray(data.pages) ? data.pages : [];
  await recordSpend("mistral", Math.max(1, pages.length) * OCR_MICROUSD_PER_PAGE);
  let out = "";
  let truncated = false;
  for (let i = 0; i < pages.length; i++) {
    const md = (pages[i].markdown || "").trim();
    if (!md) continue;
    out += `## Page ${i + 1}\n${md}\n\n`;
    if (out.length > MAX_OCR_CHARS) {
      truncated = true;
      break;
    }
  }
  out = out.trim();
  if (!out) return null;
  return { text: out.slice(0, MAX_OCR_CHARS), pages: pages.length, truncated: truncated || out.length > MAX_OCR_CHARS };
}

export function buildOcrPrompt(question, ocr) {
  const note = ocr.truncated ? "\n\n[Note: the document was longer than this — only the beginning is shown above.]" : "";
  return `${question}\n\n--- Document text (extracted by OCR) ---\n${ocr.text}${note}`;
}
