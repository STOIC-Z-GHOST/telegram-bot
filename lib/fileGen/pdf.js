// lib/fileGen/pdf.js
//
// Markdown -> PDF, laid out by hand with pdf-lib (pure JS: no Chrome, no
// LibreOffice, nothing native — neither runs on Vercel's serverless functions).
//
// Text is drawn with embedded Noto Sans (Latin) and Noto Sans Ethiopic, picked
// character by character, so English and Amharic/Tigrinya can share a sentence.
// Characters neither font has (Arabic, Cyrillic, Greek, CJK, emoji...) are drawn
// as "?" rather than silently vanishing — say so to the user, don't hide it.
//
// Supported: headings, paragraphs, bold/italic/inline code/links, bullet and
// numbered lists (nested), block quotes, code blocks, tables, rules, page numbers.

import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { latinRegular, latinBold, latinItalic, ethiopicRegular, ethiopicBold } from "./fontData.js";
import { parseMarkdown } from "./markdown.js";

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 56;
const BODY_SIZE = 11;
const LINE = 1.42;
const HEADING_SIZE = [22, 17, 14, 12.5, 11.5, 11];
const INK = rgb(0.12, 0.16, 0.22);
const MUTED = rgb(0.45, 0.48, 0.53);
const LINK = rgb(0.02, 0.39, 0.76);
const RULE = rgb(0.75, 0.77, 0.8);
const CODE_BG = rgb(0.95, 0.95, 0.96);
const HEAD_BG = rgb(0.91, 0.93, 0.97);

const isEthiopic = (cp) => (cp >= 0x1200 && cp <= 0x139f) || (cp >= 0x2d80 && cp <= 0x2ddf) || (cp >= 0xab00 && cp <= 0xab2f);

export async function markdownToPdf(markdown, { title = "" } = {}) {
  const blocks = parseMarkdown(markdown);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const load = (b64) => pdf.embedFont(Buffer.from(b64, "base64"), { subset: true });
  const F = {
    lr: await load(latinRegular),
    lb: await load(latinBold),
    li: await load(latinItalic),
    er: await load(ethiopicRegular),
    eb: await load(ethiopicBold),
  };
  const latinSet = new Set(F.lr.getCharacterSet());
  const ethiopicSet = new Set(F.er.getCharacterSet());

  let page;
  let y;
  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (h) => {
    if (y - h < MARGIN) newPage();
  };
  newPage();

  // --- text measurement and per-character font choice -------------------------
  function fontFor(cp, style) {
    if (isEthiopic(cp) && ethiopicSet.has(cp)) return style.bold ? F.eb : F.er;
    if (latinSet.has(cp)) return style.bold ? F.lb : style.italic ? F.li : F.lr;
    if (ethiopicSet.has(cp)) return style.bold ? F.eb : F.er;
    return null;
  }
  function segmentsFor(text, style) {
    const segs = [];
    for (const ch of text) {
      let font = fontFor(ch.codePointAt(0), style);
      let c = ch;
      if (!font) {
        font = style.bold ? F.lb : F.lr;
        c = "?";
      }
      const last = segs[segs.length - 1];
      if (last && last.font === font) last.text += c;
      else segs.push({ text: c, font });
    }
    return segs;
  }
  const widthOf = (segs, size) => segs.reduce((w, s) => w + s.font.widthOfTextAtSize(s.text, size), 0);

  function makeAtom(text, style, size, space) {
    const s = style.code ? size * 0.92 : size;
    const segs = segmentsFor(text, style);
    return { space, segs, size: s, width: widthOf(segs, s), style };
  }

  function atomsFromRuns(runs, base, size) {
    const atoms = [];
    for (const r of runs) {
      if (r.br) {
        atoms.push({ br: true });
        continue;
      }
      const style = { bold: r.bold || base.bold, italic: r.italic || base.italic, code: r.code, href: r.href };
      for (const part of r.text.split(/(\s+)/)) {
        if (!part) continue;
        const space = /^\s+$/.test(part);
        atoms.push(makeAtom(space ? " " : part, style, size, space));
      }
    }
    return atoms;
  }

  // A word wider than the line (a long URL) is cut at character boundaries.
  function splitAtom(atom, maxWidth) {
    const pieces = [];
    let cur = [];
    let curW = 0;
    for (const seg of atom.segs) {
      for (const ch of seg.text) {
        const w = seg.font.widthOfTextAtSize(ch, atom.size);
        if (curW + w > maxWidth && cur.length) {
          pieces.push({ ...atom, segs: cur, width: curW });
          cur = [];
          curW = 0;
        }
        const last = cur[cur.length - 1];
        if (last && last.font === seg.font) last.text += ch;
        else cur.push({ text: ch, font: seg.font });
        curW += w;
      }
    }
    if (cur.length) pieces.push({ ...atom, segs: cur, width: curW });
    return pieces;
  }

  function breakLines(atoms, width) {
    const lines = [];
    let cur = { atoms: [], width: 0 };
    const push = () => {
      while (cur.atoms.length && cur.atoms[cur.atoms.length - 1].space) cur.width -= cur.atoms.pop().width;
      lines.push(cur);
      cur = { atoms: [], width: 0 };
    };
    const place = (atom) => {
      if (cur.atoms.length && cur.width + atom.width > width) push();
      cur.atoms.push(atom);
      cur.width += atom.width;
    };
    for (const atom of atoms) {
      if (atom.br) push();
      else if (atom.space) {
        if (cur.atoms.length) {
          cur.atoms.push(atom);
          cur.width += atom.width;
        }
      } else if (atom.width > width) splitAtom(atom, width).forEach(place);
      else place(atom);
    }
    if (cur.atoms.length || !lines.length) push();
    return lines;
  }

  // Draws one wrapped line with its top at the current y and moves y down.
  function drawLine(line, x, size, { bar = false, barX = 0 } = {}) {
    const lh = size * LINE;
    ensure(lh);
    if (bar) page.drawRectangle({ x: barX, y: y - lh + 2, width: 2.5, height: lh, color: RULE });
    let cx = x;
    for (const atom of line.atoms) {
      for (const seg of atom.segs) {
        const w = seg.font.widthOfTextAtSize(seg.text, atom.size);
        if (atom.style.code && !atom.space) {
          page.drawRectangle({ x: cx - 1, y: y - atom.size - 2, width: w + 2, height: atom.size + 4, color: CODE_BG });
        }
        if (!atom.space || atom.style.code) {
          page.drawText(seg.text, { x: cx, y: y - atom.size, size: atom.size, font: seg.font, color: atom.style.href ? LINK : INK });
        }
        if (atom.style.href && !atom.space) {
          page.drawLine({ start: { x: cx, y: y - atom.size - 1.5 }, end: { x: cx + w, y: y - atom.size - 1.5 }, thickness: 0.5, color: LINK });
        }
        cx += w;
      }
    }
    y -= lh;
  }

  function drawRuns(runs, x, width, size, base = {}, opts = {}) {
    const lines = breakLines(atomsFromRuns(runs, base, size), width);
    for (const line of lines) drawLine(line, x, size, opts);
    return lines.length;
  }

  // --- blocks ----------------------------------------------------------------
  function drawBlocks(list, x, width, ctx = {}) {
    for (const block of list) drawBlock(block, x, width, ctx);
  }

  function drawBlock(block, x, width, ctx) {
    const barOpts = ctx.quote ? { bar: true, barX: ctx.quoteX } : {};
    switch (block.type) {
      case "heading": {
        const size = HEADING_SIZE[block.level - 1];
        if (y < PAGE_H - MARGIN - 1) y -= block.level <= 2 ? 10 : 6; // not at the very top of a page
        ensure(size * LINE * 3); // keep a heading with at least a couple of lines after it
        drawRuns(block.runs, x, width, size, { bold: true }, barOpts);
        y -= 4;
        break;
      }
      case "paragraph":
        drawRuns(block.runs, x, width, BODY_SIZE, {}, barOpts);
        y -= 6;
        break;
      case "list": {
        let n = block.start;
        for (const item of block.items) {
          const marker = block.ordered ? `${n++}.` : "•";
          const indent = 18;
          let first = true;
          for (const inner of item.blocks) {
            if (inner.type === "paragraph" && first) {
              ensure(BODY_SIZE * LINE); // marker and first line of text must share a page
              page.drawText(marker, { x: x + (block.ordered ? 0 : 4), y: y - BODY_SIZE, size: BODY_SIZE, font: F.lr, color: INK });
              drawRuns(inner.runs, x + indent, width - indent, BODY_SIZE, {}, barOpts);
              y -= 2;
              first = false;
            } else if (inner.type === "list") {
              drawBlock(inner, x + indent, width - indent, ctx);
            } else {
              drawBlock(inner, x + indent, width - indent, ctx);
            }
          }
        }
        y -= 4;
        break;
      }
      case "code": {
        const size = 9.5;
        const lh = size * 1.35;
        y -= 2;
        for (const raw of block.text.split("\n")) {
          const atoms = [makeAtom(raw.replace(/\t/g, "    ") || " ", {}, size, false)];
          for (const line of breakLines(atoms, width - 12)) {
            ensure(lh);
            page.drawRectangle({ x, y: y - lh + 2, width, height: lh, color: CODE_BG });
            let cx = x + 6;
            for (const atom of line.atoms) {
              for (const seg of atom.segs) {
                page.drawText(seg.text, { x: cx, y: y - size, size, font: seg.font, color: INK });
                cx += seg.font.widthOfTextAtSize(seg.text, size);
              }
            }
            y -= lh;
          }
        }
        y -= 8;
        break;
      }
      case "quote":
        drawBlocks(block.blocks, x + 14, width - 14, { ...ctx, quote: true, quoteX: x + 3 });
        break;
      case "hr":
        y -= 4;
        ensure(8);
        page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.8, color: RULE });
        y -= 10;
        break;
      case "table":
        drawTable(block, x, width);
        break;
      default:
        break;
    }
  }

  function drawTable(block, x, width) {
    const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
    const pad = 5;
    const size = 10;
    const colW = width / cols;
    const rows = [{ cells: block.header, header: true }, ...block.rows.map((cells) => ({ cells, header: false }))];
    for (const row of rows) {
      const laid = Array.from({ length: cols }, (_, i) => breakLines(atomsFromRuns(row.cells[i] || [], { bold: row.header }, size), colW - pad * 2));
      const lh = size * LINE;
      const h = Math.max(...laid.map((l) => l.length)) * lh + pad * 2 - 2;
      ensure(h + 2);
      const top = y;
      for (let c = 0; c < cols; c++) {
        const cx = x + c * colW;
        page.drawRectangle({
          x: cx,
          y: top - h,
          width: colW,
          height: h,
          color: row.header ? HEAD_BG : undefined,
          borderColor: RULE,
          borderWidth: 0.6,
        });
        y = top - pad + 1;
        for (const line of laid[c]) drawLine(line, cx + pad, size);
      }
      y = top - h;
    }
    y -= 10;
  }

  drawBlocks(blocks, MARGIN, PAGE_W - MARGIN * 2);

  // Page numbers, now that the page count is known.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const w = F.lr.widthOfTextAtSize(label, 9);
    p.drawText(label, { x: (PAGE_W - w) / 2, y: 28, size: 9, font: F.lr, color: MUTED });
  });

  pdf.setTitle(title || "Document");
  pdf.setProducer("Assist AI");
  pdf.setCreator("Assist AI");
  return Buffer.from(await pdf.save());
}
