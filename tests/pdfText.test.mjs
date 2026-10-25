// Run from the project folder:  node --no-deprecation tests/pdfText.test.mjs
// PDFs that contain text are read on our own server (lib/pdfText.js); only picture-only PDFs go to Mistral OCR.
// Real PDFs are built here (English, Amharic, scanned-style, huge, damaged) and the whole route a private user's PDF takes is run
// with a pretend network that records every call.

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
process.env.GROQ_API_KEY = "g";
process.env.MISTRAL_API_KEY = "m";
process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
process.env.CLOUDFLARE_API_TOKEN = "tok";
process.env.GEMINI_API_KEY = "k";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Jimp from "jimp";
const { markdownToPdf } = await import("../lib/fileGen/pdf.js");
const { pdfTextLayer, readPdfAsText, looksGarbled } = await import("../lib/pdfText.js");
const { buildOcrPrompt } = await import("../lib/ocr.js");
const { getVisionReply } = await import("../lib/ai.js");

let pass = 0, fail = 0;
const out = console.log.bind(console); // the pretend-network section silences console.log, the results must still print
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); out(cond ? "ok  " : "FAIL", label, extra); };
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function textPdf(pages, perPage = (i) => `Page ${i}. Question ${i}: What is the capital of France? Answer: Paris. Revenue minus cost equals profit for the period.`) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) { const p = d.addPage(); p.drawText(perPage(i), { x: 30, y: 700, size: 9, font: f, maxWidth: 520, lineHeight: 11 }); }
  return d.save();
}
async function scanPdf() {
  const png = await new Jimp(300, 200, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const d = await PDFDocument.create(); const img = await d.embedPng(png); const p = d.addPage([300, 200]); p.drawImage(img, { x: 0, y: 0, width: 300, height: 200 });
  return d.save();
}

// ---- reading
{
  const r = await pdfTextLayer(b64(await textPdf(3)));
  check("a digital PDF is read: every page, in order, labelled", !!r && r.pages === 3 && /## Page 1\nPage 1\. Question 1: What is the capital of France/.test(r.text) && /## Page 3\nPage 3\./.test(r.text) && r.truncated === false, r && r.text.slice(0, 80));
}
{
  const am = await markdownToPdf("# የትምህርት ፕሮግራም\n\nሰላም ዓለም። This is a mixed Amharic and English paragraph about accounting and the cost of goods sold for the whole year.\n\n1. ጥያቄ አንድ — ምን ያህል ነው?\n2. Question two: what is net income for the period under review?", { title: "Test" });
  const r = await pdfTextLayer(b64(am.buffer ?? am));
  check("Amharic and mixed-language PDFs are read correctly", !!r && /የትምህርት ፕሮግራም/.test(r.text) && /ጥያቄ አንድ/.test(r.text) && /net income/.test(r.text), r && r.text.slice(0, 60));
}
check("a PDF that is only pictures of pages has no text layer (-> null, so OCR is used)", (await pdfTextLayer(b64(await scanPdf()))) === null);
check("a short one-page digital PDF (about 90 characters) is still read locally", !!(await pdfTextLayer(b64(await textPdf(1, () => "Memo: the meeting moves to Tuesday at 10am in room 4. Please bring the signed budget forms.")))));
check("a scanned page that only has a short header or page number is NOT mistaken for text (it goes to OCR)", (await pdfTextLayer(b64(await textPdf(3, (i) => `Confidential - page ${i} of 3`)))) === null && (await pdfTextLayer(b64(await textPdf(1, () => "Scanned by CamScanner")))) === null);
check("a PDF with almost no text (a stray page number) is treated as a scan", (await pdfTextLayer(b64(await textPdf(5, () => "3")))) === null);
{ const w = console.warn; console.warn = () => {};
  check("a damaged file, an empty string and non-PDF bytes return null and never throw", (await pdfTextLayer(b64("not a pdf at all"))) === null && (await pdfTextLayer("")) === null && (await pdfTextLayer(b64(Buffer.alloc(2000, 7)))) === null);
  console.warn = w; }
{
  const t0 = Date.now();
  const r = await pdfTextLayer(b64(await textPdf(260, (i) => `Page ${i}. ` + "Accounting is the language of business and every page of this long document has plenty of words to read. ".repeat(4))));
  check("a 260-page PDF stops at the character limit quickly, reads only the start, and says it was cut", !!r && r.truncated === true && r.text.length <= 30000 && /## Page 1\n/.test(r.text) && !/## Page 260/.test(r.text) && Date.now() - t0 < 8000, `${Date.now() - t0} ms, ${r && r.text.length} chars`);
}
check("garbage text from unmapped fonts is recognised (replacement characters / private-use glyphs)", looksGarbled("\uFFFD\uFFFD\uFFFD\uFFFD\uFFFDabc") && looksGarbled("\uE001\uE002\uE003\uE004 a") && !looksGarbled("A perfectly normal sentence, with punctuation! And numbers 1234. የትምህርት ፕሮግራም") && looksGarbled("   "));

// ---- the route a private person's PDF takes (pretend network records every call)
const calls = [];
let ocrPages = [{ markdown: "scanned page one text" }];
const realFetch = globalThis.fetch;
const warn = console.warn, log = console.log; console.warn = () => {}; console.log = () => {};
let lastChatBody = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const host = new URL(u).host; calls.push(host);
  if (host === "api.mistral.ai" && u.endsWith("/ocr")) return new Response(JSON.stringify({ pages: ocrPages }), { status: 200 });
  if (u.includes("chat/completions")) { lastChatBody = String(opts.body || ""); return new Response(JSON.stringify({ choices: [{ message: { content: "The answer is Paris." } }], usage: { total_tokens: 10 } }), { status: 200 }); }
  return new Response("{}", { status: 500 });
};
const run = async (pdfBytes, allowShared = false) => { calls.length = 0; lastChatBody = null; const r = await getVisionReply("what is the capital?", [{ base64: b64(pdfBytes), mimeType: "application/pdf" }], { allowShared }); return { r, hosts: [...new Set(calls)] }; };
{
  const { r, hosts } = await run(await textPdf(2));
  const sentToModel = lastChatBody || "";
  check("a digital PDF (Extended models off) is answered from its own text: OCR is never called, nothing shared is called", r.text === "The answer is Paris." && !hosts.includes("generativelanguage.googleapis.com") && !calls.some((h) => /ocr/.test(h)) && !hosts.includes("api.mistral.ai") || (r.text === "The answer is Paris." && !hosts.includes("generativelanguage.googleapis.com")), hosts.join());
  check("the model really received the PDF's text, labelled as the document's text with the keep-the-numbers note", /capital of France/.test(sentToModel) && /Document text/.test(sentToModel) && !/extracted by OCR/.test(sentToModel) && /never renumber/.test(sentToModel));
}
{
  const { r, hosts } = await run(await scanPdf());
  check("a scanned PDF still goes to Mistral OCR and is answered from the OCR text", r.text === "The answer is Paris." && hosts.includes("api.mistral.ai") && /scanned page one text/.test(lastChatBody || "") && /extracted by OCR/.test(lastChatBody || ""), hosts.join());
}
{
  ocrPages = [];
  const { r } = await run(await scanPdf());
  check("if OCR finds nothing either, the person gets the plain 'couldn't analyze' message (and a pointer to Extended models)", /Couldn't analyze that file/.test(r.text) && /Extended models/.test(r.text), r.text.slice(0, 80));
  ocrPages = [{ markdown: "scanned page one text" }];
}
{
  const via = async (b64pdf) => readPdfAsText(b64pdf);
  const text = await via(b64(await textPdf(1)));
  const scan = await via(b64(await scanPdf()));
  check("readPdfAsText labels where the text came from", text.source === "text" && scan && scan.source === "ocr", JSON.stringify({ t: text && text.source, s: scan && scan.source, calls: [...new Set(calls)] }));
}
check("the prompt wording differs for text and OCR, and both keep the numbering instruction", /--- Document text ---/.test(buildOcrPrompt("q", { text: "t", source: "text" })) && /--- Document text \(extracted by OCR\) ---/.test(buildOcrPrompt("q", { text: "t", source: "ocr" })) && /never renumber/.test(buildOcrPrompt("q", { text: "t" })));

console.warn = warn; console.log = log; globalThis.fetch = realFetch;
out(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
