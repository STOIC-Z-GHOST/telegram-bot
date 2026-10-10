// lib/fileGen/docx.js
//
// Markdown -> a real Word document (.docx), using the `docx` package (pure JS,
// no native parts, nothing to install on the server). Headings use Word's own
// heading styles, so the Navigation pane and "Update table of contents" work;
// lists are real Word lists; tables are real Word tables.
//
// Fonts: Calibri for Latin text, with Nyala named as the complex-script font so
// Amharic/Tigrinya render properly in Word (Word falls back sensibly if a
// machine lacks it).

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  LevelFormat,
  AlignmentType,
} from "docx";
import { parseMarkdown } from "./markdown.js";

const BODY_FONT = { ascii: "Calibri", hAnsi: "Calibri", cs: "Nyala", eastAsia: "Nyala" };
const CODE_FONT = "Courier New";
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const MAX_LIST_LEVEL = 4;

function textRuns(runs, base = {}) {
  const out = [];
  for (const r of runs) {
    if (r.br) {
      out.push(new TextRun({ break: 1 }));
      continue;
    }
    const run = new TextRun({
      text: r.text,
      bold: r.bold || base.bold,
      italics: r.italic || base.italic,
      color: base.color,
      font: r.code ? CODE_FONT : undefined,
      size: r.code ? 20 : base.size,
      shading: r.code ? { type: ShadingType.CLEAR, fill: "F2F2F2" } : undefined,
    });
    out.push(
      r.href
        ? new ExternalHyperlink({ link: r.href, children: [new TextRun({ text: r.text, bold: r.bold, italics: r.italic, color: "0563C1", underline: {} })] })
        : run
    );
  }
  return out;
}

export async function markdownToDocx(markdown) {
  const blocks = parseMarkdown(markdown);
  let orderedLists = 0;
  const orderedRefs = [];

  function paragraphsFor(block, ctx = {}) {
    switch (block.type) {
      case "heading":
        return [new Paragraph({ heading: HEADINGS[block.level - 1], children: textRuns(block.runs) })];
      case "paragraph":
        return [
          new Paragraph({
            children: textRuns(block.runs, ctx.quote ? { color: "555555" } : {}),
            spacing: { after: 120, line: 276 },
            indent: ctx.quote ? { left: 720 } : undefined,
            border: ctx.quote ? { left: { style: BorderStyle.SINGLE, size: 12, color: "AAAAAA", space: 8 } } : undefined,
          }),
        ];
      case "list": {
        const level = Math.min(ctx.level ?? 0, MAX_LIST_LEVEL);
        let reference = "bullets";
        if (block.ordered) {
          reference = `numbers-${orderedLists++}`;
          orderedRefs.push({ reference, start: block.start });
        }
        const out = [];
        for (const item of block.items) {
          let first = true;
          for (const inner of item.blocks) {
            if (inner.type === "list") {
              out.push(...paragraphsFor(inner, { level: level + 1 }));
            } else if (inner.type === "paragraph") {
              out.push(
                new Paragraph({
                  children: textRuns(inner.runs),
                  numbering: first ? { reference, level } : undefined,
                  indent: first ? undefined : { left: 720 * (level + 1) },
                  spacing: { after: 60 },
                })
              );
              first = false;
            } else {
              out.push(...paragraphsFor(inner, ctx));
            }
          }
        }
        return out;
      }
      case "code":
        return block.text.split("\n").map(
          (line) =>
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: CODE_FONT, size: 20 })],
              shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
              spacing: { after: 0, line: 252 },
              indent: { left: 120, right: 120 },
            })
        ).concat(new Paragraph({ children: [], spacing: { after: 120 } }));
      case "quote":
        return block.blocks.flatMap((b) => paragraphsFor(b, { ...ctx, quote: true }));
      case "hr":
        return [new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } }, spacing: { before: 120, after: 160 } })];
      default:
        return [];
    }
  }

  function tableFor(block) {
    const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
    const cell = (runs, header) =>
      new TableCell({
        width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE },
        shading: header ? { type: ShadingType.CLEAR, fill: "E8EEF7" } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ children: textRuns(runs, header ? { bold: true } : {}), spacing: { after: 0 } })],
      });
    const pad = (row) => Array.from({ length: cols }, (_, i) => row[i] || []);
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ tableHeader: true, children: pad(block.header).map((c) => cell(c, true)) }),
        ...block.rows.map((row) => new TableRow({ children: pad(row).map((c) => cell(c, false)) })),
      ],
    });
  }

  const children = [];
  for (const block of blocks) {
    if (block.type === "table") {
      children.push(tableFor(block), new Paragraph({ children: [], spacing: { after: 120 } }));
    } else {
      children.push(...paragraphsFor(block));
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [new TextRun({ text: " " })] }));

  const levels = (format, textFor) =>
    Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
      level,
      format,
      text: textFor(level),
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    }));

  const headingStyle = (id, name, size) => ({
    id,
    name,
    basedOn: "Normal",
    next: "Normal",
    quickFormat: true,
    run: { size, bold: true, color: "1F2937" },
    paragraph: { spacing: { before: 280, after: 120 }, keepNext: true },
  });

  const doc = new Document({
    creator: "Assist AI",
    title: "Document",
    styles: {
      default: { document: { run: { font: BODY_FONT, size: 22 } } },
      paragraphStyles: [
        headingStyle("Heading1", "Heading 1", 36),
        headingStyle("Heading2", "Heading 2", 30),
        headingStyle("Heading3", "Heading 3", 26),
        headingStyle("Heading4", "Heading 4", 24),
        headingStyle("Heading5", "Heading 5", 22),
        headingStyle("Heading6", "Heading 6", 22),
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: levels(LevelFormat.BULLET, () => "•") },
        ...orderedRefs.map(({ reference, start }) => ({
          reference,
          levels: levels(LevelFormat.DECIMAL, (level) => `%${level + 1}.`).map((l, i) => (i === 0 ? { ...l, start } : l)),
        })),
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
