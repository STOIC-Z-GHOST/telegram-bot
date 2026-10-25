// Reads a .docx the way a person sees it: with the numbers and letters Word puts in front of list items.
//
// Why this exists: in most exam papers and forms the "1." / "A." labels are not typed text, they are Word's automatic list
// numbering. mammoth.extractRawText() drops them, so the AI received 60 unnumbered questions and, asked for "question 25", had
// to count them itself — and miscounted (it started at question 11 or 13 and then relabelled the answers "25"). This reader
// rebuilds the labels from word/numbering.xml (decimal, letters, roman numerals, nested levels, restarts, start overrides,
// numbering that comes from a paragraph style) and writes them into the text, so "question 25" is literally there.
//
// No new dependency: JSZip is already used by lib/attachments.js. Anything unexpected makes the caller fall back to mammoth.

import JSZip from "jszip";

const MAX_PART_BYTES = 25 * 1024 * 1024; // refuse to inflate a bigger XML part than this

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };

// ---- number formats
function toLetters(n, upper) { // 1 -> a, 26 -> z, 27 -> aa
  let s = ""; let x = n;
  while (x > 0) { x -= 1; s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); }
  return upper ? s.toUpperCase() : s;
}
function toRoman(n, upper) {
  const map = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = ""; let x = n;
  for (const [v, r] of map) while (x >= v) { s += r; x -= v; }
  return upper ? s.toUpperCase() : s;
}
export function formatNumber(n, fmt) {
  switch (fmt) {
    case "upperLetter": return toLetters(n, true);
    case "lowerLetter": return toLetters(n, false);
    case "upperRoman": return toRoman(n, true);
    case "lowerRoman": return toRoman(n, false);
    case "decimalZero": return String(n).padStart(2, "0");
    case "none": return "";
    default: return String(n); // decimal and every format we don't know (ordinal, cardinalText, ...)
  }
}

// ---- numbering.xml and styles.xml
function parseNumbering(xml) {
  const abstracts = new Map(); // abstractNumId -> { levels: Map(ilvl -> { start, fmt, text }) }
  const nums = new Map();      // numId -> { abstractId, overrides: Map(ilvl -> startOverride) }
  if (!xml) return { abstracts, nums };
  for (const m of xml.matchAll(/<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g)) {
    const id = attr(m[1], "w:abstractNumId");
    const levels = new Map();
    for (const lv of m[2].matchAll(/<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g)) {
      const ilvl = parseInt(attr(lv[1], "w:ilvl") ?? "0", 10);
      const start = lv[2].match(/<w:start\b[^>]*w:val="(-?\d+)"/);
      const fmt = lv[2].match(/<w:numFmt\b[^>]*w:val="([^"]+)"/);
      const text = lv[2].match(/<w:lvlText\b[^>]*w:val="([^"]*)"/);
      levels.set(ilvl, { start: start ? parseInt(start[1], 10) : 1, fmt: fmt ? fmt[1] : "decimal", text: text ? decodeXml(text[1]) : `%${ilvl + 1}.` });
    }
    abstracts.set(id, { levels });
  }
  for (const m of xml.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g)) {
    const numId = attr(m[1], "w:numId");
    const abs = m[2].match(/<w:abstractNumId\b[^>]*w:val="(\d+)"/);
    const overrides = new Map();
    for (const o of m[2].matchAll(/<w:lvlOverride\b([^>]*)>([\s\S]*?)<\/w:lvlOverride>/g)) {
      const so = o[2].match(/<w:startOverride\b[^>]*w:val="(-?\d+)"/);
      if (so) overrides.set(parseInt(attr(o[1], "w:ilvl") ?? "0", 10), parseInt(so[1], 10));
    }
    if (abs) nums.set(numId, { abstractId: abs[1], overrides });
  }
  return { abstracts, nums };
}

// Paragraph styles can carry the list too ("List Number" and similar): styleId -> { numId, ilvl }
function parseStyleNumbering(xml) {
  const byStyle = new Map(); const basedOn = new Map();
  if (!xml) return byStyle;
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[1], "w:styleId");
    const based = m[2].match(/<w:basedOn\b[^>]*w:val="([^"]+)"/);
    if (based) basedOn.set(id, based[1]);
    const numPr = m[2].match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
    if (numPr) {
      const numId = numPr[1].match(/<w:numId\b[^>]*w:val="(\d+)"/);
      const ilvl = numPr[1].match(/<w:ilvl\b[^>]*w:val="(\d+)"/);
      if (numId) byStyle.set(id, { numId: numId[1], ilvl: ilvl ? parseInt(ilvl[1], 10) : 0 });
    }
  }
  const resolve = (id, depth = 0) => (id == null || depth > 8) ? null : (byStyle.get(id) || resolve(basedOn.get(id), depth + 1));
  const out = new Map();
  for (const id of new Set([...byStyle.keys(), ...basedOn.keys()])) { const r = resolve(id); if (r) out.set(id, r); }
  return out;
}

// ---- one paragraph's visible text
function paragraphText(inner) {
  let out = "";
  // Deleted tracked changes carry <w:delText>, which we never read; inserted text is ordinary <w:t>.
  for (const m of inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:noBreakHyphen\s*\/>|<w:cr\s*\/>/g)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0].startsWith("<w:tab")) out += "\t";
    else if (m[0].startsWith("<w:noBreakHyphen")) out += "-";
    else out += "\n";
  }
  return out;
}

class Counters {
  constructor(numbering) { this.n = numbering; this.byAbstract = new Map(); this.seen = new Set(); }
  // Returns the label for a paragraph on list numId at level ilvl, advancing the counters like Word does.
  next(numId, ilvl) {
    const num = this.n.nums.get(numId);
    if (!num) return null;
    const abs = this.n.abstracts.get(num.abstractId);
    if (!abs) return null;
    const lvl = abs.levels.get(ilvl) || { start: 1, fmt: "decimal", text: `%${ilvl + 1}.` };
    let c = this.byAbstract.get(num.abstractId);
    if (!c) { c = new Array(9).fill(null); this.byAbstract.set(num.abstractId, c); }
    // The first time a list instance is used, its start overrides restart those levels.
    if (!this.seen.has(numId)) {
      this.seen.add(numId);
      for (const [l, v] of num.overrides) c[l] = v - 1;
    }
    const startOf = (l) => (abs.levels.get(l)?.start ?? 1);
    c[ilvl] = (c[ilvl] == null ? startOf(ilvl) - 1 : c[ilvl]) + 1;
    for (let l = ilvl + 1; l < 9; l++) c[l] = null; // a new item at one level restarts every deeper level
    if (lvl.fmt === "bullet") return "-";
    const label = lvl.text.replace(/%([1-9])/g, (_, d) => {
      const l = parseInt(d, 10) - 1;
      const v = c[l] == null ? startOf(l) : c[l];
      return formatNumber(v, abs.levels.get(l)?.fmt || "decimal");
    });
    return label.trim();
  }
}

// ---- the whole document, in reading order (paragraphs, and tables as " | " rows)
export async function extractDocxNumbered(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name) => {
    const f = zip.file(name);
    if (!f) return null;
    const bytes = await f.async("nodebuffer");
    if (bytes.length > MAX_PART_BYTES) throw new Error(`${name} is too large`);
    return bytes.toString("utf8");
  };
  const documentXml = await read("word/document.xml");
  if (!documentXml) throw new Error("no word/document.xml");
  const numbering = parseNumbering(await read("word/numbering.xml"));
  const styleNum = parseStyleNumbering(await read("word/styles.xml"));
  const counters = new Counters(numbering);

  const body = (documentXml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/) || [null, documentXml])[1];
  const lines = [];
  let labelled = 0;

  const renderParagraph = (pXml) => {
    const text = paragraphText(pXml);
    const pPr = (pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [null, ""])[1];
    let numId = null, ilvl = 0;
    const direct = pPr.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
    if (direct) {
      const nid = direct[1].match(/<w:numId\b[^>]*w:val="(\d+)"/);
      const lv = direct[1].match(/<w:ilvl\b[^>]*w:val="(\d+)"/);
      if (nid) numId = nid[1];
      if (lv) ilvl = parseInt(lv[1], 10);
    }
    if (numId == null) {
      const st = pPr.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/);
      const fromStyle = st && styleNum.get(st[1]);
      if (fromStyle) { numId = fromStyle.numId; ilvl = fromStyle.ilvl; }
    }
    if (numId === "0") numId = null; // numId 0 means "no list"
    let label = null;
    if (numId != null) label = counters.next(numId, ilvl);
    if (label != null && label !== "") labelled++;
    return { text, label };
  };

  // Walk the body with a small tag scanner so tables keep their shape and paragraphs stay in order.
  const tag = /<(\/?)w:(tbl|tr|tc|p)(?=[\s>\/])([^>]*?)(\/?)>/g;
  let m; let row = null; let cell = null; let tableDepth = 0;
  const emit = (line) => { if (cell) cell.push(line.trim()); else lines.push(line); };
  while ((m = tag.exec(body)) !== null) {
    const closing = m[1] === "/"; const name = m[2]; const selfClosed = m[4] === "/";
    if (name === "tbl") { if (!closing) tableDepth++; else tableDepth = Math.max(0, tableDepth - 1); continue; }
    if (name === "tr") { if (!closing) row = []; else { if (row && row.length) lines.push(row.join(" | ")); row = null; } continue; }
    if (name === "tc") { if (!closing) cell = []; else { if (row && cell) row.push(cell.filter(Boolean).join(" ")); cell = null; } continue; }
    if (name === "p" && !closing && !selfClosed) {
      const end = body.indexOf("</w:p>", tag.lastIndex);
      if (end === -1) break;
      const { text, label } = renderParagraph(body.slice(tag.lastIndex, end));
      tag.lastIndex = end + "</w:p>".length;
      const t = text.replace(/[ \t]+$/g, "");
      if (!t.trim() && !label) { if (!cell && lines.length && lines[lines.length - 1] !== "") lines.push(""); continue; }
      // No indentation: a list's depth does not say what a line is (this exam used level 4 for its questions), the labels do.
      emit(label ? `${label} ${t.trim()}` : t.trim());
    }
  }
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, labelled };
}
