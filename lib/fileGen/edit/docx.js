// lib/fileGen/edit/docx.js
//
// Phase 3 — edit an uploaded Word document IN PLACE.
//
// A .docx is a zip; the text lives in word/document.xml. We number the body
// paragraphs, show the model the numbered text, and accept a small JSON list of
// changes by paragraph number. Only the paragraphs it names are rewritten, so styles,
// images, tables, headers, footers, numbering and section settings are untouched
// (they're other files in the zip, or other XML we never edit).
//
// What an edited paragraph keeps: its paragraph properties (style, list, alignment,
// spacing) and the character formatting of its first text run. What it loses:
// formatting that changed mid-sentence (e.g. one bold word) — the new text takes the
// first run's look.
//
// Paragraphs we refuse to touch ("locked"): ones with fields (page numbers, TOC),
// links, text boxes, equations, content controls or tracked changes — rewriting them
// would break the field/link or the revision history.
//
// No XML library is used on purpose (no new dependency); the scan below counts
// <w:p> nesting properly so text-box paragraphs can't confuse it, and the result is
// re-checked (balanced tags + mammoth can still read it) before it is delivered.

import JSZip from "jszip";
import mammoth from "mammoth";
import { FileGenError } from "../index.js";
import { zipDeclaredSize, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from "../../attachments.js";
import { parseJsonObject, plural, countWords } from "./util.js";

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_XML_BYTES = 20 * 1024 * 1024;
const SHOWN_CHAR_BUDGET = 24000;
const MAX_CHANGES = 200;
const MAX_PARA_CHARS = 5000;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
// Opening/closing <w:p> and <w:tc>, skipping self-closing tags and look-alikes
// (<w:pPr>, <w:tcPr>, <w:p/>).
const TOKEN_RE = /<w:p(?:\s[^>]*)?(?<!\/)>|<\/w:p>|<w:tc(?:\s[^>]*)?(?<!\/)>|<\/w:tc>/g;
const RUN_RE = /<w:r(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/w:r>/g;
const TEXT_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;

export function scanParagraphs(xml) {
  const paras = [];
  let depth = 0;
  let tcDepth = 0;
  let cur = null;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(xml))) {
    const t = m[0];
    if (t === "</w:p>") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) { cur.end = m.index + t.length; paras.push(cur); cur = null; }
    } else if (t.startsWith("<w:p")) {
      if (depth === 0) cur = { start: m.index, inTable: tcDepth > 0, nested: false };
      else cur.nested = true;
      depth++;
    } else if (t === "</w:tc>") {
      if (depth === 0 && tcDepth > 0) tcDepth--;
    } else if (depth === 0) {
      tcDepth++;
    }
  }
  return paras;
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function esc(s) {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function paragraphText(pXml) {
  let out = "";
  TEXT_RE.lastIndex = 0;
  let m;
  while ((m = TEXT_RE.exec(pXml))) {
    if (m[1] !== undefined) out += decode(m[1]);
    else out += m[0].startsWith("<w:tab") ? "\t" : "\n";
  }
  return out;
}

function lockReason(pXml, nested) {
  if (nested) return "text box";
  if (/<w:instrText|<w:fldSimple|<w:fldChar/.test(pXml)) return "field";
  if (/<w:hyperlink[\s>]/.test(pXml)) return "link";
  if (/<mc:AlternateContent|<w:txbxContent|<w:pict[\s>]/.test(pXml)) return "text box";
  if (/<m:oMath/.test(pXml)) return "equation";
  if (/<w:sdt[\s>]/.test(pXml)) return "content control";
  if (/<w:ins[\s>]|<w:del[\s>]|<w:moveFrom|<w:moveTo|<w:pPrChange|<w:rPrChange/.test(pXml)) return "tracked changes";
  return null;
}

export function analyse(xml) {
  const spans = scanParagraphs(xml);
  return spans.map((s, i) => {
    const pXml = xml.slice(s.start, s.end);
    const style = pXml.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] || "";
    return {
      i, ...s, pXml, style,
      isList: /<w:numPr>/.test(pXml),
      text: paragraphText(pXml),
      locked: lockReason(pXml, s.nested),
    };
  });
}

// ---------------------------------------------------------------------------
// What the model sees
// ---------------------------------------------------------------------------
export function numberedText(paras) {
  let out = "";
  let shown = 0;
  let hidden = 0;
  for (const p of paras) {
    if (!p.text.trim()) continue;
    const tags = [p.style, p.isList ? "list" : "", p.inTable ? "cell" : "", p.locked ? `locked: ${p.locked}` : ""].filter(Boolean);
    const line = `[${p.i}${tags.length ? "|" + tags.join("|") : ""}] ${p.text.replace(/\n/g, " ⏎ ").replace(/\t/g, " ⇥ ")}\n`;
    if (out.length + line.length > SHOWN_CHAR_BUDGET) { hidden++; continue; }
    out += line;
    shown++;
  }
  return { text: out, shown, hidden };
}

function prompt(name, numbered, hidden, instruction) {
  return (
    `Edit the Word document "${name}" as instructed. Its paragraphs are numbered below. Reply with ONE JSON object:\n` +
    `{"edits":[{"p":12,"text":"<the COMPLETE new text of paragraph 12>"}],"delete":[7],"insert_after":[{"p":12,"text":"<a new paragraph>"}]}\n` +
    `Rules:\n` +
    `- List ONLY the paragraphs that must change; every key is optional.\n` +
    `- "text" is the paragraph's whole new text, without its [number|style] label.\n` +
    `- Paragraphs marked "locked" cannot be changed. A heading stays a heading when you edit it in place. A new paragraph copies the formatting of paragraph "p".\n` +
    `- "cell" paragraphs are inside a table: edit their text, don't delete them.\n` +
    `- Keep the document's language unless asked to change it.\n` +
    (hidden ? `- ${hidden} more paragraphs exist but aren't shown; don't guess at them.\n` : "") +
    `\nInstruction: ${instruction}\n\nDocument:\n${numbered}`
  );
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------
function runContent(text) {
  let out = "";
  for (const piece of text.split(/(\n|\t)/)) {
    if (piece === "\n") out += "<w:br/>";
    else if (piece === "\t") out += "<w:tab/>";
    else if (piece) out += `<w:t xml:space="preserve">${esc(piece)}</w:t>`;
  }
  return out;
}

export function rewriteParagraph(pXml, newText) {
  const content = runContent(newText);
  let first = true;
  const out = pXml.replace(RUN_RE, (run) => {
    if (!/<w:t[\s>]/.test(run)) return run; // an image, a break…: not a text run
    if (first) {
      first = false;
      const attrs = run.match(/^<w:r((?:\s[^>]*)?)>/)?.[1] || "";
      const rPr = run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || "";
      return `<w:r${attrs}>${rPr}${content}</w:r>`;
    }
    const stripped = run
      .replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g, "")
      .replace(/<w:tab\s*\/>/g, "")
      .replace(/<w:br\s*\/>/g, "");
    const rest = stripped.replace(/^<w:r(?:\s[^>]*)?>/, "").replace(/<\/w:r>$/, "").replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, "").trim();
    return rest ? stripped : ""; // keep a run only if it still carries something (a picture…)
  });
  if (first && content) return out.replace(/<\/w:p>$/, `<w:r>${content}</w:r></w:p>`);
  return out;
}

function newParagraph(refXml, text) {
  const pPr = (refXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "").replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, "");
  let rPr = "";
  for (const run of refXml.match(RUN_RE) || []) {
    if (/<w:t[\s>]/.test(run)) { rPr = run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || ""; break; }
  }
  return `<w:p>${pPr}<w:r>${rPr}${runContent(text)}</w:r></w:p>`;
}

function canRemove(p) {
  return !p.inTable && !/<w:sectPr/.test(p.pXml) && !/<w:drawing|<w:pict|<w:object/.test(p.pXml);
}

// Validates the model's plan against the real paragraphs. Returns what to apply
// plus a list of things we skipped (and why).
export function planChanges(plan, paras) {
  const edits = new Map();
  const deletes = new Set();
  const inserts = new Map();
  const skipped = [];
  const byIndex = (p) => (Number.isInteger(p) && p >= 0 && p < paras.length ? paras[p] : null);
  const okText = (t) => typeof t === "string" && t.length <= MAX_PARA_CHARS;
  let total = 0;

  for (const e of Array.isArray(plan.edits) ? plan.edits : []) {
    if (total >= MAX_CHANGES) break;
    const p = byIndex(e?.p);
    if (!p || !okText(e.text)) { skipped.push("a change pointed at a paragraph that doesn't exist"); continue; }
    if (p.locked) { skipped.push(`paragraph ${p.i} is locked (${p.locked})`); continue; }
    if (e.text === p.text) continue;
    edits.set(p.i, e.text);
    total++;
  }
  for (const d of Array.isArray(plan.delete) ? plan.delete : []) {
    if (total >= MAX_CHANGES) break;
    const p = byIndex(d);
    if (!p) { skipped.push("a deletion pointed at a paragraph that doesn't exist"); continue; }
    if (p.locked) { skipped.push(`paragraph ${p.i} is locked (${p.locked})`); continue; }
    deletes.add(p.i);
    edits.delete(p.i);
    total++;
  }
  for (const n of Array.isArray(plan.insert_after) ? plan.insert_after : []) {
    if (total >= MAX_CHANGES) break;
    const p = byIndex(n?.p);
    if (!p || !okText(n.text) || !n.text.trim()) { skipped.push("an insertion was malformed"); continue; }
    if (p.nested) { skipped.push(`can't insert after paragraph ${p.i}`); continue; }
    if (!inserts.has(p.i)) inserts.set(p.i, []);
    inserts.get(p.i).push(n.text);
    total++;
  }
  return { edits, deletes, inserts, skipped, total };
}

export function applyChanges(xml, paras, { edits, deletes, inserts }) {
  let out = "";
  let pos = 0;
  for (const p of paras) {
    out += xml.slice(pos, p.start);
    let pXml = p.pXml;
    if (deletes.has(p.i)) pXml = canRemove(p) ? "" : rewriteParagraph(pXml, "");
    else if (edits.has(p.i)) pXml = rewriteParagraph(pXml, edits.get(p.i));
    out += pXml;
    for (const text of inserts.get(p.i) || []) out += newParagraph(p.pXml, text);
    pos = p.end;
  }
  return out + xml.slice(pos);
}

function tagsBalanced(xml) {
  let open = 0;
  let close = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(xml))) {
    if (m[0] === "</w:p>") close++;
    else if (m[0].startsWith("<w:p")) open++;
  }
  return open === close;
}

// ---------------------------------------------------------------------------
export async function editDocxFile({ buffer, name, instruction, ask }) {
  const cantOpen = () => new FileGenError("I couldn't open that Word file — it may be corrupted, password-protected, or an old .doc.", { retryable: false });
  if (buffer.length > MAX_BYTES) throw new FileGenError(`That document is too large for me to edit (limit ${MAX_BYTES / (1024 * 1024)}MB).`, { retryable: false });
  const zipInfo = zipDeclaredSize(buffer);
  if (zipInfo && (zipInfo.total > MAX_UNCOMPRESSED_BYTES.docx || zipInfo.entries > MAX_ZIP_ENTRIES)) {
    throw new FileGenError("That document expands to far more data than I can safely edit.", { retryable: false });
  }
  let zip;
  let xml;
  try {
    zip = await JSZip.loadAsync(buffer);
    const f = zip.file("word/document.xml");
    if (!f) throw cantOpen();
    xml = await f.async("string");
  } catch (err) {
    throw err instanceof FileGenError ? err : cantOpen();
  }
  if (xml.length > MAX_XML_BYTES) throw new FileGenError("That document is too large for me to edit safely.", { retryable: false });

  const paras = analyse(xml);
  const { text: numbered, shown, hidden } = numberedText(paras);
  if (!shown) throw new FileGenError("I couldn't find any text in that document to edit.", { retryable: false });

  const reply = await ask("edit_docx", prompt(name, numbered, hidden, instruction));
  const plan = parseJsonObject(reply.text, reply.tokensUsed);
  const changes = planChanges(plan, paras);
  if (!changes.total) {
    throw new FileGenError(
      changes.skipped.length
        ? `I couldn't change that part of the document (${changes.skipped.slice(0, 2).join("; ")}). This didn't use any of your file allowance.`
        : "I couldn't find anything to change — tell me which paragraph or text to edit. This didn't use any of your file allowance.",
      { tokensUsed: reply.tokensUsed }
    );
  }

  const newXml = applyChanges(xml, paras, changes);
  let out;
  try {
    if (!tagsBalanced(newXml)) throw new Error("unbalanced paragraph tags");
    zip.file("word/document.xml", newXml);
    out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await mammoth.extractRawText({ buffer: out }); // must still open, or we don't send it
  } catch (err) {
    console.error("docx edit write/verify failed:", err);
    throw new FileGenError("I made the changes but couldn't save the document cleanly, so I didn't send it. This didn't use any of your file allowance.", { tokensUsed: reply.tokensUsed });
  }

  const n = changes.edits.size + changes.deletes.size + [...changes.inserts.values()].reduce((a, l) => a + l.length, 0);
  const notes = [`✅ ${plural(n, "paragraph change")} applied in place — styles, images, tables, headers and footers are untouched.`];
  if (changes.edits.size) notes.push("Changed paragraphs keep their style but take the formatting of their first words (e.g. one bold word inside them won't stay bold).");
  if (changes.skipped.length) notes.push(`⚠️ Skipped: ${changes.skipped.slice(0, 3).join("; ")}.`);
  if (hidden) notes.push(`⚠️ The document is long, so ${plural(hidden, "paragraph")} near the end weren't visible to me.`);
  return { buffer: out, notes, tokensUsed: reply.tokensUsed, servedBy: reply.servedBy, wordsText: numbered, wordCount: countWords(numbered) };
}
