// Run from the project folder:  node --no-deprecation tests/docxText.test.mjs
// The bug: an exam .docx whose "1." / "A." labels are Word's automatic list numbering reached the AI without any numbers, so
// "answer from question 25" made it count questions itself (it started at 11 or 13). These tests build small .docx files and
// check that lib/docxText.js writes the real labels, and that lib/attachments.js keeps the old behaviour when there are none.

import JSZip from "jszip";

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { extractDocxNumbered, formatNumber } = await import("../lib/docxText.js");
const { extractDocumentText, buildDocumentPrompt } = await import("../lib/attachments.js");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const p = (text, { num, lvl = 0, style } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${num !== undefined ? `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${num}"/></w:numPr>` : ""}</w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const lvl = (i, fmt, text, start = 1) => `<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
const abstract = (id, levels) => `<w:abstractNum w:abstractNumId="${id}">${levels.join("")}</w:abstractNum>`;
const num = (id, abs, overrides = {}) => `<w:num w:numId="${id}"><w:abstractNumId w:val="${abs}"/>${Object.entries(overrides).map(([l, v]) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="${v}"/></w:lvlOverride>`).join("")}</w:num>`;

async function docx({ body, numbering, styles }) {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${numbering ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : ""}${styles ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : ""}</Types>`);
  z.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${numbering ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' : ""}${styles ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : ""}</Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  if (numbering) z.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering ${W}>${numbering}</w:numbering>`);
  if (styles) z.file("word/styles.xml", `<?xml version="1.0"?><w:styles ${W}>${styles}</w:styles>`);
  return z.generateAsync({ type: "nodebuffer" });
}
const lines = (t) => t.split("\n");

// ---- number formats
check("formats: letters, roman numerals, zero-padded", formatNumber(1, "upperLetter") === "A" && formatNumber(4, "lowerLetter") === "d" && formatNumber(27, "lowerLetter") === "aa" && formatNumber(4, "upperRoman") === "IV" && formatNumber(9, "lowerRoman") === "ix" && formatNumber(7, "decimalZero") === "07" && formatNumber(3, "somethingNew") === "3");

// ---- a normal exam: questions 1., choices A. B. C. that restart under every question
{
  const numbering = abstract(0, [lvl(0, "decimal", "%1."), lvl(1, "upperLetter", "%2.")]) + num(1, 0);
  const body = [1, 2, 3].map((q) => p(`Question ${q}?`, { num: 1, lvl: 0 }) + ["x", "y", "z"].map((c) => p(`choice ${q}${c}`, { num: 1, lvl: 1 })).join("")).join("");
  const r = await extractDocxNumbered(await docx({ body, numbering }));
  const L = lines(r.text);
  check("questions are numbered 1. 2. 3. and choices lettered A. B. C.", L[0] === "1. Question 1?" && L[1] === "A. choice 1x" && L[3] === "C. choice 1z" && L[4] === "2. Question 2?" && L[8] === "3. Question 3?", JSON.stringify(L.slice(0, 5)));
  check("the choices restart at A. under every new question", L[5] === "A. choice 2x" && L[9] === "A. choice 3x");
}

// ---- the real bug: question 25 has to be findable without counting
{
  const numbering = abstract(0, [lvl(0, "decimal", "%1."), lvl(1, "upperLetter", "%2.")]) + num(1, 0);
  const body = Array.from({ length: 50 }, (_, i) => p(`Q-text-${i + 1}`, { num: 1, lvl: 0 }) + ["a", "b", "c", "d"].map((c) => p(`opt-${i + 1}${c}`, { num: 1, lvl: 1 })).join("")).join("");
  const r = await extractDocxNumbered(await docx({ body, numbering }));
  const L = lines(r.text);
  const at = L.findIndex((x) => x.startsWith("25. "));
  check("a 50-question paper: the line for question 25 says 25 and is the 25th question", L[at] === "25. Q-text-25" && L.filter((x) => /^\d+\. /.test(x)).length === 50);
  check("the question before it is 24 and the one after is 26, no gaps anywhere", L[at - 5] === "24. Q-text-24" && L[at + 5] === "26. Q-text-26" && [...r.text.matchAll(/^(\d+)\. /gm)].every((m, i) => +m[1] === i + 1));
}

// ---- like the real exam: questions 1-25 in one list, the rest in another list that carries on from 26 (start override, deeper
// level), with each question's choices in their own lists
{
  const numbering = abstract(0, [lvl(0, "decimal", "%1."), lvl(1, "upperLetter", "%2.")]) +
    abstract(1, [lvl(0, "upperLetter", "%1."), lvl(1, "lowerLetter", "%2."), lvl(2, "lowerRoman", "%3."), lvl(3, "decimal", "%4.")]) +
    abstract(2, [lvl(0, "upperLetter", "%1.")]) + num(1, 0) + num(2, 1, { 3: 26 }) + num(3, 2) + num(4, 2, { 0: 1 });
  const first = Array.from({ length: 25 }, (_, i) => p(`First-${i + 1}`, { num: 1, lvl: 0 })).join("");
  const rest = p("Later-0", { num: 2, lvl: 3 }) + p("c1", { num: 3 }) + p("c2", { num: 3 }) + p("Later-1", { num: 2, lvl: 3 }) + p("c1", { num: 4 }) + p("c2", { num: 4 });
  const r = await extractDocxNumbered(await docx({ body: first + rest, numbering }));
  const L = lines(r.text);
  check("a start override continues the numbering (25. then 26. 27.) and each question's choices start again at A.", L.slice(24).join("|") === "25. First-25|26. Later-0|A. c1|B. c2|27. Later-1|A. c1|B. c2", L.slice(24).join("|"));
}

// ---- Word keeps counting across list instances that share one definition
{
  const numbering = abstract(0, [lvl(0, "decimal", "%1.")]) + num(1, 0) + num(2, 0);
  const r = await extractDocxNumbered(await docx({ body: p("a", { num: 1 }) + p("b", { num: 1 }) + p("heading, not a list") + p("c", { num: 2 }), numbering }));
  check("two lists on one definition keep counting (1. 2. then 3.), and unnumbered text in between stays unnumbered", lines(r.text).join("|") === "1. a|2. b|heading, not a list|3. c", r.text);
}

// ---- numbering that comes from a paragraph style
{
  const numbering = abstract(0, [lvl(0, "decimal", "%1.")]) + num(7, 0);
  const styles = `<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="MyList"><w:basedOn w:val="ListNumber"/></w:style>`;
  const r = await extractDocxNumbered(await docx({ body: p("one", { style: "ListNumber" }) + p("two", { style: "MyList" }), numbering, styles }));
  check("numbering taken from a style (and from a style based on it) is found", lines(r.text).join("|") === "1. one|2. two", r.text);
}

// ---- other kinds of lists
{
  const numbering = abstract(0, [lvl(0, "lowerLetter", "(%1)"), lvl(1, "lowerRoman", "%2)")]) + abstract(1, [lvl(0, "bullet", "•")]) + abstract(2, [lvl(0, "decimal", "%1."), lvl(1, "decimal", "%1.%2")]) + num(1, 0) + num(2, 1) + num(3, 2);
  const body = p("alpha", { num: 1 }) + p("sub", { num: 1, lvl: 1 }) + p("sub2", { num: 1, lvl: 1 }) + p("beta", { num: 1 }) + p("dot", { num: 2 }) + p("sec", { num: 3 }) + p("sec-a", { num: 3, lvl: 1 }) + p("sec-b", { num: 3, lvl: 1 }) + p("not a list", { num: 0 });
  const r = await extractDocxNumbered(await docx({ body, numbering }));
  check("labels with brackets, roman numerals and multi-level text (1.1) are built from the template", lines(r.text).join("|") === "(a) alpha|i) sub|ii) sub2|(b) beta|- dot|1. sec|1.1 sec-a|1.2 sec-b|not a list", r.text);
}

// ---- text that is typed, tables, tracked changes
{
  const numbering = abstract(0, [lvl(0, "decimal", "%1.")]) + num(1, 0);
  const table = `<w:tbl><w:tr><w:tc>${p("Item")}</w:tc><w:tc>${p("Price")}</w:tc></w:tr><w:tr><w:tc>${p("Pen")}</w:tc><w:tc>${p("Birr 5")}</w:tc></w:tr></w:tbl>`;
  const tracked = `<w:p><w:r><w:t>kept </w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>`;
  const body = p("26. typed by hand") + p("Question", { num: 1 }) + table + tracked + p("a &amp; b &lt; c".replace(/&amp;/g, "&").replace(/&lt;/g, "<"));
  const r = await extractDocxNumbered(await docx({ body, numbering }));
  check("numbers typed by hand are left exactly as typed", lines(r.text)[0] === "26. typed by hand");
  check("a table keeps its rows (cells joined with ' | ')", lines(r.text).includes("Item | Price") && lines(r.text).includes("Pen | Birr 5"), r.text);
  check("deleted tracked text is not read, inserted text is", lines(r.text).includes("kept added") && !/removed/.test(r.text), r.text);
  check("XML entities come out as normal characters", lines(r.text).includes("a & b < c"), r.text);
}

// ---- how the bot uses it
{
  const numbering = abstract(0, [lvl(0, "decimal", "%1.")]) + num(1, 0);
  const withNumbers = await docx({ body: p("First", { num: 1 }) + p("Second", { num: 1 }), numbering });
  const r = await extractDocumentText(withNumbers, "docx", "exam.docx");
  check("extractDocumentText returns the numbered text with a one-line note that the numbers are the document's own", !r.error && /^\[The numbers and letters below are the document's own numbering\.\]/.test(r.text) && /\n1\. First\n2\. Second$/.test(r.text.trim()), r.text);

  const plain = await docx({ body: p("Just a paragraph.") + p("And another one.") });
  const r2 = await extractDocumentText(plain, "docx", "memo.docx");
  check("a document with no lists is read exactly as before (no note, same text)", !r2.error && !/own numbering/.test(r2.text) && /Just a paragraph\.\s+And another one\./.test(r2.text), r2.text);

  const brokenNumbering = await docx({ body: p("x", { num: 1 }) + p("kept text here"), numbering: "<w:abstractNum oops" });
  const r3 = await extractDocumentText(brokenNumbering, "docx", "broken.docx");
  check("a damaged numbering part never loses the document (falls back to plain text)", !r3.error && /kept text here/.test(r3.text), r3.text);

  const prompt = buildDocumentPrompt("answer from 25", r.text, false);
  check("the prompt tells the AI to keep the document's numbers and never renumber", /never renumber/i.test(prompt) && /start at the item numbered N/.test(prompt) && prompt.includes("--- Document text ---") && prompt.startsWith("answer from 25"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
