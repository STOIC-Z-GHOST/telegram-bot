// Run from the project folder:  node --no-deprecation tests/phase23-edit.test.mjs
// (needs `npm install`; uses a mocked AI model — no network, no database)
import { editFile } from "../lib/fileGen/edit/index.js";
import { detectEditRequest } from "../lib/fileGen/editDetect.js";
import { markdownToDocx } from "../lib/fileGen/docx.js";
import { FileGenError } from "../lib/fileGen/index.js";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import fs from "fs";
import os from "os";
import path from "path";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "botfiles-")); // sample output files land here

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };
const reply = (text) => async () => ({ text, tokensUsed: 500, servedBy: "mock" });
const rejects = async (label, fn, re) => { try { await fn(); check(label, false, "(no error)"); } catch (e) { check(label, e instanceof FileGenError && (!re || re.test(e.userMessage)), e.userMessage || e.message); } };

// ---------- detection
const det = [
  ["fix the typos", [{ name: "a.txt", type: "text/plain" }], true],
  ["add a Total column", [{ name: "a.xlsx", type: "" }], true],
  ["summarize this", [{ name: "a.txt", type: "text/plain" }], false],
  ["what does this say", [{ name: "a.docx", type: "" }], false],
  ["translate this to Amharic", [{ name: "a.pdf", type: "application/pdf" }], false],
  ["fix the typos", [], false],
  ["fix this", [{ name: "a.png", type: "image/png" }], false],
  ["/file edit change the title", [{ name: "a.docx", type: "" }], true],
  ["/file edit change the title", [], true],
  ["/file pdf my cv", [], false],
];
for (const [msg, att, want] of det) { const r = detectEditRequest(msg, att); check(`detect ${JSON.stringify(msg)} [${att[0]?.name || "none"}]`, !!r === want, JSON.stringify(r && { explicit: r.explicit, att: r.attachment?.name })); }

// ---------- TEXT: full rewrite
const txt = Buffer.from("Hello wrold\r\nSecond line\r\nThird line\r\n");
let r = await editFile({ buffer: txt, name: "notes.txt", mime: "text/plain", instruction: "fix the typo", ask: reply("<<<FILE_START>>>\nHello world\nSecond line\nThird line\n<<<FILE_END>>>") });
check("text full rewrite", r.buffer.toString() === "Hello world\r\nSecond line\r\nThird line\r\n", JSON.stringify(r.buffer.toString()));
check("text name/ext", r.displayName === "notes-edited.txt" && r.ext === "txt");
// markers ignored (fenced)
r = await editFile({ buffer: Buffer.from("a = 1\nb = 2\n"), name: "x.py", mime: "", instruction: "rename a to alpha", ask: reply("```python\nalpha = 1\nb = 2\n```") });
check("text fenced fallback", r.buffer.toString() === "alpha = 1\nb = 2\n", JSON.stringify(r.buffer.toString()));
// truncated (START without END)
await rejects("text truncated rejected", () => editFile({ buffer: Buffer.from("a\nb\n"), name: "x.txt", mime: "text/plain", instruction: "fix", ask: reply("<<<FILE_START>>>\na\n") }), /cut off/);
// invalid JSON rejected
await rejects("json invalid rejected", () => editFile({ buffer: Buffer.from('{"a":1}'), name: "d.json", mime: "", instruction: "add b", ask: reply('<<<FILE_START>>>\n{"a":1,\n<<<FILE_END>>>') }), /valid/);
// shrink guard
const big = "line of text here\n".repeat(60);
await rejects("shrink guard", () => editFile({ buffer: Buffer.from(big), name: "b.txt", mime: "text/plain", instruction: "fix typos", ask: reply("<<<FILE_START>>>\nline of text here\n<<<FILE_END>>>") }), /shorter/);
r = await editFile({ buffer: Buffer.from(big), name: "b.txt", mime: "text/plain", instruction: "shorten it a lot", ask: reply("<<<FILE_START>>>\nline of text here\n<<<FILE_END>>>") });
check("shrink allowed when asked", r.buffer.toString().trim() === "line of text here");
// unchanged
await rejects("no-op rejected", () => editFile({ buffer: Buffer.from("same\n"), name: "s.txt", mime: "text/plain", instruction: "x", ask: reply("<<<FILE_START>>>\nsame\n<<<FILE_END>>>") }), /anything to change/);

// ---------- TEXT: patch mode (>8000 chars)
const longText = Array.from({ length: 400 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog`).join("\n");
check("long text size", longText.length > 8000 && longText.length < 30000, String(longText.length));
const patches = JSON.stringify({ edits: [{ find: "Line 5: the quick brown fox", replace: "Line 5: the SLOW brown fox $& $1" }, { find: "Line 7: the quick brown fox jumps over the lazy dog", replace: "" }, { find: "does not exist anywhere", replace: "x" }, { find: "lazy dog", replace: "dog" }] });
r = await editFile({ buffer: Buffer.from(longText), name: "big.txt", mime: "text/plain", instruction: "tweak", ask: reply(patches) });
const out = r.buffer.toString();
check("patch applied literally ($ safe)", out.includes("Line 5: the SLOW brown fox $& $1 jumps"));
check("patch delete", !out.includes("Line 7: the quick brown fox jumps over the lazy dog"));
check("ambiguous/missing reported", r.notes.some((n) => /not applied/.test(n)), r.notes.join(" | "));
check("rest untouched", out.includes("Line 399: the quick brown fox jumps over the lazy dog"));
await rejects("patch none match", () => editFile({ buffer: Buffer.from(longText), name: "big.txt", mime: "text/plain", instruction: "t", ask: reply('{"edits":[{"find":"nope nope","replace":"x"}]}') }), /match/);
await rejects("patch too_big", () => editFile({ buffer: Buffer.from(longText), name: "big.txt", mime: "text/plain", instruction: "translate", ask: reply('{"too_big":true}') }), /too much/);
await rejects("patch garbage", () => editFile({ buffer: Buffer.from(longText), name: "big.txt", mime: "text/plain", instruction: "t", ask: reply("I cannot do that") }), /work out/);
await rejects("too long file", () => editFile({ buffer: Buffer.from("x".repeat(31000)), name: "huge.txt", mime: "text/plain", instruction: "t", ask: reply("") }), /too long/);

// ---------- unsupported kinds (no AI call)
const noAi = async () => { throw new Error("AI must not be called"); };
await rejects("pdf explained", () => editFile({ buffer: Buffer.from("%PDF"), name: "a.pdf", mime: "application/pdf", instruction: "change", ask: noAi }), /PDF/);
await rejects("pptx explained", () => editFile({ buffer: Buffer.from("x"), name: "a.pptx", mime: "", instruction: "change", ask: noAi }), /PowerPoint/);
await rejects("png explained", () => editFile({ buffer: Buffer.from("x"), name: "a.png", mime: "image/png", instruction: "change", ask: noAi }), /image/);
await rejects("empty instruction", () => editFile({ buffer: Buffer.from("x"), name: "a.txt", mime: "", instruction: "  ", ask: noAi }), /what to change/);
await rejects("provider down", () => editFile({ buffer: Buffer.from("a b\n"), name: "a.txt", mime: "", instruction: "x", ask: reply("⚠️ All AI providers failed") }), /busy/);

// ---------- XLSX
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Sales");
ws.addRow(["Item", "Qty", "Price"]); ws.addRow(["Pen", 3, 1.5]); ws.addRow(["Book", 2, 12]); ws.addRow(["Bag", 1, 30]);
ws.getRow(1).font = { bold: true };
const xbuf = Buffer.from(await wb.xlsx.writeBuffer());
const ops = { ops: [
  { op: "set", sheet: "Sales", cell: "D1", value: "Total" },
  { op: "fill", sheet: "Sales", range: "D2:D4", formula: "=B{row}*C{row}" },
  { op: "append_row", sheet: "Sales", values: ["Sum", null, null] },
  { op: "formula", sheet: "Sales", cell: "D5", formula: "=SUM(D2:D4)" },
  { op: "style", sheet: "Sales", range: "D1:D1", bold: true, fill: "FFFF00" },
  { op: "formula", sheet: "Sales", cell: "A9", formula: '=HYPERLINK("http://evil","x")' },
  { op: "set", sheet: "Nope", cell: "A1", value: 1 },
  { op: "bogus", sheet: "Sales" },
  { op: "add_sheet", name: "Summary" },
  { op: "set", sheet: "Summary", cell: "A1", value: "Hi" },
] };
r = await editFile({ buffer: xbuf, name: "sales.xlsx", mime: "", instruction: "add total column", ask: reply("```json\n" + JSON.stringify(ops) + "\n```") });
const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(r.buffer);
const s2 = wb2.getWorksheet("Sales");
check("xlsx header set", s2.getCell("D1").value === "Total");
check("xlsx fill formulas", s2.getCell("D3").value?.formula === "B3*C3" && s2.getCell("D4").value?.formula === "B4*C4", JSON.stringify(s2.getCell("D3").value));
check("xlsx append + sum", s2.getCell("A5").value === "Sum" && s2.getCell("D5").value?.formula === "SUM(D2:D4)");
check("xlsx style kept", s2.getCell("D1").font?.bold === true && s2.getCell("A1").font?.bold === true);
check("xlsx evil formula blocked", s2.getCell("A9").value === null || s2.getCell("A9").value === undefined);
check("xlsx new sheet", wb2.getWorksheet("Summary")?.getCell("A1").value === "Hi");
check("xlsx original data intact", s2.getCell("A3").value === "Book" && s2.getCell("C4").value === 30);
check("xlsx failures reported", r.notes.some((n) => /not applied/.test(n)), r.notes.join(" | "));
check("xlsx name", r.displayName === "sales-edited.xlsx" && r.mime.includes("spreadsheetml"));
fs.writeFileSync(path.join(OUT, "sales-edited.xlsx"), r.buffer);
await rejects("xlsx no ops", () => editFile({ buffer: xbuf, name: "s.xlsx", mime: "", instruction: "x", ask: reply('{"ops":[]}') }), /which cells/);
await rejects("xlsx all fail", () => editFile({ buffer: xbuf, name: "s.xlsx", mime: "", instruction: "x", ask: reply('{"ops":[{"op":"set","sheet":"Zzz","cell":"A1","value":1}]}') }), /couldn't apply/);
// workbook with a chart folder is refused
const JSZip = (await import("jszip")).default;
const z = await JSZip.loadAsync(xbuf); z.file("xl/charts/chart1.xml", "<c/>");
const withChart = await z.generateAsync({ type: "nodebuffer" });
await rejects("xlsx with chart refused", () => editFile({ buffer: withChart, name: "c.xlsx", mime: "", instruction: "x", ask: noAi }), /charts/);

// ---------- DOCX (Phase 3)
const md = `# Spring Menu\n\nWelcome to **our** café. We serve fresh bread.\n\n## Drinks\n\n- Coffee\n- Tea\n\n| Item | Price |\n|---|---|\n| Coffee | 30 |\n| Tea | 20 |\n\nThe end.\n`;
const dbuf = await markdownToDocx(md);
fs.writeFileSync(path.join(OUT, "menu-source.docx"), dbuf);
const before = (await mammoth.extractRawText({ buffer: dbuf })).value;
// find paragraph numbers by asking the engine once with a probing mock that echoes the numbered text
let seen = "";
await editFile({ buffer: dbuf, name: "menu.docx", mime: "", instruction: "probe", ask: async (msgs) => { seen = msgs[0].content; return { text: '{"edits":[]}', tokensUsed: 1 }; } }).catch(() => {});
console.log("--- numbered view the model sees:\n" + seen.split("Document:\n")[1]);
const num = (needle) => Number(seen.split("\n").find((l) => l.includes(needle))?.match(/^\[(\d+)/)?.[1]);
const pWelcome = num("Welcome"), pTitle = num("Spring Menu"), pTea = num("Tea"), pEnd = num("The end"), pCoffeeCell = num("Coffee");
const plan = { edits: [{ p: pTitle, text: "Autumn Menu" }, { p: pWelcome, text: "Welcome to our café — now open late. & <enjoy>" }], delete: [pEnd], insert_after: [{ p: pTea, text: "Juice" }] };
r = await editFile({ buffer: dbuf, name: "menu.docx", mime: "", instruction: "autumn", ask: reply(JSON.stringify(plan)) });
fs.writeFileSync(path.join(OUT, "menu-edited.docx"), r.buffer);
const after = (await mammoth.extractRawText({ buffer: r.buffer })).value;
check("docx title changed", after.includes("Autumn Menu") && !after.includes("Spring Menu"));
check("docx special chars escaped", after.includes("now open late. & <enjoy>"));
check("docx deleted para", !after.includes("The end"));
check("docx inserted para", after.includes("Juice") && after.indexOf("Juice") > after.indexOf("Tea"));
check("docx untouched kept", after.includes("Coffee") && after.includes("Drinks") && after.includes("30"));
check("docx table still a table", (await mammoth.convertToHtml({ buffer: r.buffer })).value.includes("<table>"));
const html = (await mammoth.convertToHtml({ buffer: r.buffer })).value;
check("docx heading style kept", /<h1>Autumn Menu<\/h1>/.test(html) && /<h2>Drinks<\/h2>/.test(html), html.slice(0, 160));
check("docx list kept", /<ul>[\s\S]*Coffee[\s\S]*Tea[\s\S]*Juice[\s\S]*<\/ul>/.test(html));
// deleting a table cell paragraph must blank, not remove
r = await editFile({ buffer: dbuf, name: "menu.docx", mime: "", instruction: "x", ask: reply(JSON.stringify({ delete: [pCoffeeCell] })) });
const tbl = (await mammoth.convertToHtml({ buffer: r.buffer })).value;
check("docx table cell delete keeps table valid", (tbl.match(/<td>/g) || []).length === 4, String((tbl.match(/<td>/g) || []).length) + " cells");
await rejects("docx nothing to change", () => editFile({ buffer: dbuf, name: "m.docx", mime: "", instruction: "x", ask: reply('{"edits":[{"p":9999,"text":"x"}]}') }), /couldn't change|anything/);
await rejects("docx garbage zip", () => editFile({ buffer: Buffer.from("not a zip"), name: "m.docx", mime: "", instruction: "x", ask: noAi }), /couldn't open/);

console.log(`\n${pass} passed, ${fail} failed`);
console.log("sample files in", OUT);
process.exit(fail ? 1 : 0);
