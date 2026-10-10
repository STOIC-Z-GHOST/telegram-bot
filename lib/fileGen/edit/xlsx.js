// lib/fileGen/edit/xlsx.js
//
// Phase 2b — edit an uploaded Excel workbook.
//
// The model never re-writes the sheet. It sees a compact grid and answers with a
// short JSON list of operations (set a cell, fill a formula down a column, append a
// row…), which we validate and apply with exceljs. Everything it doesn't mention
// is left as it was.
//
// Known limits (the person is told when they matter):
//   • exceljs doesn't keep charts, pivot tables, slicers or macros, so a workbook
//     containing any of those is refused rather than quietly damaged;
//   • inserting/deleting rows doesn't rewrite formulas that point below them;
//   • formulas are calculated when the file is opened, not by us.

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { FileGenError } from "../index.js";
import { zipDeclaredSize, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from "../../attachments.js";
import { parseJsonObject, plural } from "./util.js";

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_SHEETS_SHOWN = 6;
const MAX_ROWS_SHOWN = 80;
const MAX_COLS_SHOWN = 26;
const GRID_CHAR_BUDGET = 14000;
const MAX_OPS = 150;
const MAX_CELLS_PER_OP = 5000;
const MAX_CELLS_TOTAL = 20000;

// A formula that reaches out of the workbook, or runs something, never goes in —
// the file's own text could have talked the model into writing one.
const FORBIDDEN_FORMULA = /WEBSERVICE|FILTERXML|HYPERLINK|\bCALL\s*\(|REGISTER|EXEC\s*\(|\bcmd\s*\||\bpowershell|\bmshta|DDE/i;

// ---------------------------------------------------------------------------
export function colToNum(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const ADDR = /^([A-Z]{1,3})([1-9]\d{0,6})$/;
function parseAddr(a) {
  const m = typeof a === "string" ? a.toUpperCase().match(ADDR) : null;
  return m ? { col: colToNum(m[1]), row: Number(m[2]) } : null;
}
function parseRange(r) {
  if (typeof r !== "string") return null;
  const parts = r.toUpperCase().split(":");
  if (parts.length > 2) return null;
  const a = parseAddr(parts[0]);
  const b = parseAddr(parts[1] ?? parts[0]);
  if (!a || !b) return null;
  return { c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col), r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row) };
}

// ---------------------------------------------------------------------------
// What the model sees
// ---------------------------------------------------------------------------
function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.formula !== undefined || v.sharedFormula !== undefined) {
      let f = v.formula;
      if (f === undefined) { try { f = cell.formula; } catch { f = ""; } }
      return f ? `=${f}` : "=(formula)";
    }
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.error) return String(v.error);
    return "";
  }
  return String(v);
}
const clean = (s) => s.replace(/[\t\r\n]+/g, " ").slice(0, 60);

export function describeWorkbook(wb) {
  let out = "";
  let hasFormulas = false;
  const sheets = wb.worksheets;
  for (const ws of sheets.slice(0, MAX_SHEETS_SHOWN)) {
    const rows = ws.rowCount;
    const cols = Math.min(ws.columnCount, MAX_COLS_SHOWN);
    out += `\n## Sheet "${ws.name}" — ${rows} rows × ${ws.columnCount} columns (last row: ${rows})\n`;
    if (!rows) { out += "(empty)\n"; continue; }
    out += ["row", ...Array.from({ length: cols }, (_, i) => numToCol(i + 1))].join("\t") + "\n";
    for (let r = 1; r <= Math.min(rows, MAX_ROWS_SHOWN); r++) {
      const cells = [];
      for (let c = 1; c <= cols; c++) {
        const t = cellText(ws.getCell(r, c));
        if (t.startsWith("=")) hasFormulas = true;
        cells.push(clean(t));
      }
      if (cells.every((c) => c === "")) continue;
      out += `${r}\t${cells.join("\t")}\n`;
      if (out.length > GRID_CHAR_BUDGET) { out += `…(grid cut here to save space)\n`; return { text: out, hasFormulas }; }
    }
    if (rows > MAX_ROWS_SHOWN) out += `…(rows ${MAX_ROWS_SHOWN + 1}–${rows} not shown)\n`;
  }
  if (sheets.length > MAX_SHEETS_SHOWN) out += `\n(${sheets.length - MAX_SHEETS_SHOWN} more sheets not shown)\n`;
  return { text: out, hasFormulas };
}

function opsPrompt(name, grid, instruction) {
  return (
    `Edit the spreadsheet "${name}" as instructed. Reply with ONE JSON object: {"ops":[ ... ]}\n` +
    `Operations (use the sheet names exactly as shown; cells like "B2"; ranges like "D2:D50"):\n` +
    `- {"op":"set","sheet":"S","cell":"B2","value":"text" | 12.5 | true | null}\n` +
    `- {"op":"formula","sheet":"S","cell":"D2","formula":"=B2*C2"}\n` +
    `- {"op":"fill","sheet":"S","range":"D2:D50","formula":"=B{row}*C{row}"}   ({row} becomes each row number)\n` +
    `- {"op":"clear","sheet":"S","range":"A5:C5"}\n` +
    `- {"op":"append_row","sheet":"S","values":["a",1,2]}   (adds after the last row)\n` +
    `- {"op":"insert_row","sheet":"S","before":5,"values":["a",1,2]}\n` +
    `- {"op":"delete_rows","sheet":"S","from":5,"count":1}\n` +
    `- {"op":"style","sheet":"S","range":"A1:D1","bold":true,"italic":false,"fill":"FFFF00","color":"FF0000","numFmt":"0.00"}  (every style key optional)\n` +
    `- {"op":"add_sheet","name":"Summary"}\n` +
    `Rules: at most ${MAX_OPS} operations; prefer "fill" over many single formulas; never invent data the person didn't give; to add a column put a header with "set", then "fill" the rest. ` +
    `Rows beyond what is shown still exist — use the "last row" number given for each sheet.\n` +
    `If nothing can be done, reply {"ops":[]}.\n\n` +
    `Instruction: ${instruction}\n\nWorkbook (tab-separated; formulas start with "="):\n${grid}`
  );
}

// ---------------------------------------------------------------------------
// Applying the operations
// ---------------------------------------------------------------------------
const sheetNameBad = /[\[\]:*?/\\]/;
const NUMFMT_OK = /^[\w\s#0.,%$€£¥/\-:;"()@*[\]]{1,40}$/;
const isHex = (s) => typeof s === "string" && /^[0-9a-fA-F]{6}$/.test(s);
const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

export function applyOps(wb, ops) {
  let applied = 0;
  let cellsTouched = 0;
  let shifted = false;
  const failed = [];
  const fail = (i, why) => failed.push(`#${i + 1}: ${why}`);

  const findSheet = (name) => {
    if (typeof name !== "string") return null;
    return wb.getWorksheet(name) || wb.worksheets.find((w) => w.name.toLowerCase() === name.trim().toLowerCase()) || null;
  };

  ops.forEach((op, i) => {
    try {
      if (!op || typeof op !== "object") return fail(i, "malformed");
      if (op.op === "add_sheet") {
        const name = typeof op.name === "string" ? op.name.trim() : "";
        if (!name || name.length > 31 || sheetNameBad.test(name)) return fail(i, "bad sheet name");
        if (findSheet(name)) return fail(i, `sheet "${name}" already exists`);
        wb.addWorksheet(name);
        applied++;
        return;
      }
      const ws = findSheet(op.sheet);
      if (!ws) return fail(i, `no sheet called "${op.sheet}"`);

      if (op.op === "set") {
        const a = parseAddr(op.cell);
        if (!a || !isPrimitive(op.value ?? null)) return fail(i, "bad cell or value");
        if (typeof op.value === "string" && op.value.length > 5000) return fail(i, "text too long");
        ws.getCell(a.row, a.col).value = op.value ?? null;
        cellsTouched++;
      } else if (op.op === "formula") {
        const a = parseAddr(op.cell);
        const f = typeof op.formula === "string" ? op.formula.trim() : "";
        if (!a || !f.startsWith("=") || f.length > 300 || FORBIDDEN_FORMULA.test(f)) return fail(i, "bad or disallowed formula");
        ws.getCell(a.row, a.col).value = { formula: f.slice(1) };
        cellsTouched++;
      } else if (op.op === "fill") {
        const r = parseRange(op.range);
        const f = typeof op.formula === "string" ? op.formula.trim() : "";
        if (!r || !f.startsWith("=") || f.length > 300 || FORBIDDEN_FORMULA.test(f)) return fail(i, "bad range or formula");
        const n = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
        if (n > MAX_CELLS_PER_OP || cellsTouched + n > MAX_CELLS_TOTAL) return fail(i, "too many cells");
        for (let row = r.r1; row <= r.r2; row++) {
          const text = f.replaceAll("{row}", String(row)).slice(1);
          for (let c = r.c1; c <= r.c2; c++) ws.getCell(row, c).value = { formula: text };
        }
        cellsTouched += n;
      } else if (op.op === "clear") {
        const r = parseRange(op.range);
        if (!r) return fail(i, "bad range");
        const n = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
        if (n > MAX_CELLS_PER_OP) return fail(i, "too many cells");
        for (let row = r.r1; row <= r.r2; row++) for (let c = r.c1; c <= r.c2; c++) ws.getCell(row, c).value = null;
        cellsTouched += n;
      } else if (op.op === "append_row" || op.op === "insert_row") {
        const values = Array.isArray(op.values) ? op.values : null;
        if (!values || values.length > 50 || !values.every(isPrimitive)) return fail(i, "bad row values");
        const safe = values.map((v) => (typeof v === "string" && v.length > 5000 ? v.slice(0, 5000) : v));
        if (op.op === "append_row") ws.addRow(safe);
        else {
          const before = Number(op.before);
          if (!Number.isInteger(before) || before < 1 || before > ws.rowCount + 1) return fail(i, "bad row number");
          ws.spliceRows(before, 0, safe);
          shifted = true;
        }
        cellsTouched += values.length;
      } else if (op.op === "delete_rows") {
        const from = Number(op.from);
        const count = op.count === undefined ? 1 : Number(op.count);
        if (!Number.isInteger(from) || !Number.isInteger(count) || from < 1 || count < 1 || count > 100 || from > ws.rowCount) return fail(i, "bad rows");
        ws.spliceRows(from, count);
        shifted = true;
      } else if (op.op === "style") {
        const r = parseRange(op.range);
        if (!r) return fail(i, "bad range");
        const n = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
        if (n > MAX_CELLS_PER_OP) return fail(i, "too many cells");
        if (op.fill !== undefined && !isHex(op.fill)) return fail(i, "bad fill colour");
        if (op.color !== undefined && !isHex(op.color)) return fail(i, "bad text colour");
        if (op.numFmt !== undefined && !(typeof op.numFmt === "string" && NUMFMT_OK.test(op.numFmt))) return fail(i, "bad number format");
        for (let row = r.r1; row <= r.r2; row++) {
          for (let c = r.c1; c <= r.c2; c++) {
            const cell = ws.getCell(row, c);
            const font = { ...(cell.font || {}) };
            if (typeof op.bold === "boolean") font.bold = op.bold;
            if (typeof op.italic === "boolean") font.italic = op.italic;
            if (op.color !== undefined) font.color = { argb: `FF${op.color.toUpperCase()}` };
            cell.font = font;
            if (op.fill !== undefined) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${op.fill.toUpperCase()}` } };
            if (op.numFmt !== undefined) cell.numFmt = op.numFmt;
          }
        }
      } else {
        return fail(i, `unknown operation "${String(op.op).slice(0, 20)}"`);
      }
      applied++;
    } catch (err) {
      fail(i, err.message.slice(0, 60));
    }
  });
  return { applied, failed, shifted };
}

// ---------------------------------------------------------------------------
export async function editXlsxFile({ buffer, name, instruction, ask }) {
  if (buffer.length > MAX_BYTES) {
    throw new FileGenError(`That spreadsheet is too large for me to edit (limit ${MAX_BYTES / (1024 * 1024)}MB).`, { retryable: false });
  }
  const zipInfo = zipDeclaredSize(buffer);
  if (zipInfo && (zipInfo.total > MAX_UNCOMPRESSED_BYTES.xlsx || zipInfo.entries > MAX_ZIP_ENTRIES)) {
    throw new FileGenError("That spreadsheet expands to far more data than I can safely edit.", { retryable: false });
  }
  try {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);
    const unsafe = names.find((n) => /^xl\/(charts|pivotTables|pivotCache|slicers|slicerCaches)\//.test(n) || n === "xl/vbaProject.bin");
    if (unsafe) {
      throw new FileGenError(
        "This workbook has charts, pivot tables or macros, and editing it here would remove them. I can still read it and answer questions about it — or send me a copy without those parts to edit.",
        { retryable: false }
      );
    }
  } catch (err) {
    if (err instanceof FileGenError) throw err;
    throw new FileGenError("I couldn't open that spreadsheet — it may be corrupted or password-protected.", { retryable: false });
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new FileGenError("I couldn't open that spreadsheet — it may be corrupted or password-protected.", { retryable: false });
  }
  if (!wb.worksheets.length) throw new FileGenError("That workbook has no sheets to edit.", { retryable: false });

  const { text: grid, hasFormulas } = describeWorkbook(wb);
  const reply = await ask("edit_xlsx", opsPrompt(name, grid, instruction));
  const plan = parseJsonObject(reply.text, reply.tokensUsed);
  const ops = Array.isArray(plan.ops) ? plan.ops.slice(0, MAX_OPS) : [];
  if (!ops.length) {
    throw new FileGenError("I couldn't work out which cells to change — tell me the sheet, column or cells and what they should become. This didn't use any of your file allowance.", { tokensUsed: reply.tokensUsed });
  }

  const result = applyOps(wb, ops);
  if (!result.applied) {
    throw new FileGenError(`I couldn't apply that to your sheet (${result.failed.slice(0, 2).join("; ")}). This didn't use any of your file allowance.`, { tokensUsed: reply.tokensUsed });
  }

  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  let out;
  try {
    out = Buffer.from(await wb.xlsx.writeBuffer());
    await new ExcelJS.Workbook().xlsx.load(out); // it must open again, or we don't send it
  } catch (err) {
    console.error("xlsx edit write/verify failed:", err);
    throw new FileGenError("I made the changes but couldn't save the spreadsheet cleanly, so I didn't send it. This didn't use any of your file allowance.", { tokensUsed: reply.tokensUsed });
  }

  const notes = [`✅ ${plural(result.applied, "change")} applied.`, "Formulas calculate when you open the file."];
  if (result.shifted && hasFormulas) notes.push("⚠️ Rows were inserted or deleted — please check that formulas below them still point at the right cells.");
  if (result.failed.length) notes.push(`⚠️ ${plural(result.failed.length, "change")} not applied (${result.failed.slice(0, 3).join("; ")}).`);
  return { buffer: out, notes, tokensUsed: reply.tokensUsed, servedBy: reply.servedBy };
}
