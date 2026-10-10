// lib/fileGen/markdown.js
//
// Markdown -> a small block/run model that BOTH renderers (Word and PDF) walk, so
// the two can't disagree about what a document contains. The AI writes Markdown
// (it's what models write best); this is the only place that touches `marked`.
//
// Blocks:
//   { type: "heading", level: 1-6, runs }
//   { type: "paragraph", runs }
//   { type: "list", ordered, start, items: [ { blocks: [...] } ] }
//   { type: "code", text }
//   { type: "quote", blocks: [...] }
//   { type: "table", header: [runs], rows: [[runs]] }
//   { type: "hr" }
// Runs: { text, bold?, italic?, code?, href? } or { br: true }

import { marked } from "marked";

const TAG_PATTERN = /<[^>]+>/g;

function inlineRuns(tokens, style = {}) {
  const runs = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "text":
      case "escape":
        if (t.tokens?.length) runs.push(...inlineRuns(t.tokens, style));
        else runs.push({ text: t.text, ...style });
        break;
      case "strong":
        runs.push(...inlineRuns(t.tokens, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns(t.tokens, { ...style, italic: true }));
        break;
      case "del":
        runs.push(...inlineRuns(t.tokens, style));
        break;
      case "codespan":
        runs.push({ text: t.text, ...style, code: true });
        break;
      case "link":
        runs.push(...inlineRuns(t.tokens, { ...style, href: t.href }));
        break;
      case "image":
        if (t.text) runs.push({ text: `[${t.text}]`, ...style });
        break;
      case "br":
        runs.push({ br: true });
        break;
      case "html": {
        const plain = (t.text || "").replace(TAG_PATTERN, "");
        if (plain) runs.push({ text: plain, ...style });
        break;
      }
      default:
        if (t.text) runs.push({ text: t.text, ...style });
    }
  }
  return runs;
}

function blocksFromTokens(tokens) {
  const blocks = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "heading":
        blocks.push({ type: "heading", level: Math.min(6, t.depth), runs: inlineRuns(t.tokens) });
        break;
      case "paragraph":
        blocks.push({ type: "paragraph", runs: inlineRuns(t.tokens) });
        break;
      case "text": // a bare text token at block level (inside tight list items)
        blocks.push({ type: "paragraph", runs: t.tokens ? inlineRuns(t.tokens) : [{ text: t.text }] });
        break;
      case "list":
        blocks.push({
          type: "list",
          ordered: !!t.ordered,
          start: Number(t.start) || 1,
          items: t.items.map((item) => ({ blocks: blocksFromTokens(item.tokens) })),
        });
        break;
      case "code":
        blocks.push({ type: "code", text: t.text });
        break;
      case "blockquote":
        blocks.push({ type: "quote", blocks: blocksFromTokens(t.tokens) });
        break;
      case "table":
        blocks.push({
          type: "table",
          header: t.header.map((c) => inlineRuns(c.tokens)),
          rows: t.rows.map((row) => row.map((c) => inlineRuns(c.tokens))),
        });
        break;
      case "hr":
        blocks.push({ type: "hr" });
        break;
      case "html": {
        const plain = (t.text || "").replace(TAG_PATTERN, "").trim();
        if (plain) blocks.push({ type: "paragraph", runs: [{ text: plain }] });
        break;
      }
      default: // space, def, ...
        break;
    }
  }
  return blocks;
}

export function parseMarkdown(markdown) {
  return blocksFromTokens(marked.lexer(markdown || ""));
}

// Plain text of a run list (for titles, table-width estimates, the .txt output).
export function runsToText(runs) {
  return (runs || []).map((r) => (r.br ? "\n" : r.text)).join("");
}

// First heading's text, or the first line — used for the file name and chat message.
export function extractTitle(markdown) {
  const blocks = parseMarkdown(markdown);
  const heading = blocks.find((b) => b.type === "heading");
  const raw = heading ? runsToText(heading.runs) : (markdown || "").split("\n").find((l) => l.trim()) || "";
  return raw.replace(/[#*_`>]/g, "").trim().slice(0, 80);
}
