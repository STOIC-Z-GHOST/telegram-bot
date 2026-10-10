// lib/fileGen/index.js
//
// Turns a request ("a PDF study plan", "a website for my bakery", "that as a Word
// doc") into a file. The AI only ever writes TEXT — Markdown for documents, or one
// HTML page — and the server turns that into the real file:
//
//   html           the AI writes the whole page; we tidy it (see cleanHtml)
//   docx / pdf     the AI writes Markdown -> lib/fileGen/docx.js / pdf.js
//   md / txt       the Markdown itself / a plain-text rendering of it
//
// "export" mode makes NO AI call: it converts the assistant's last reply, so
// "give me that as a PDF" is instant and costs no tokens.
//
// Always runs on the Standard model chain, whatever model tier the person has
// selected: a file is thousands of output tokens, and Flash is too weak for long
// output while Max/Extra draw on small shared quotas (see lib/providerBudget.js).

import { getConversationReply } from "../ai.js";
import { markdownToDocx } from "./docx.js";
import { markdownToPdf } from "./pdf.js";
import { parseMarkdown, runsToText, extractTitle } from "./markdown.js";

export const FILE_FORMATS = {
  html: { ext: "html", mime: "text/html", label: "web page", source: "html" },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document", source: "markdown" },
  pdf: { ext: "pdf", mime: "application/pdf", label: "PDF", source: "markdown" },
  md: { ext: "md", mime: "text/markdown", label: "Markdown file", source: "markdown" },
  txt: { ext: "txt", mime: "text/plain", label: "text file", source: "markdown" },
};

// Shown to the person as-is, so keep them plain and kind.
export class FileGenError extends Error {
  constructor(message, { retryable = true, tokensUsed = null } = {}) {
    super(message);
    this.userMessage = message;
    this.retryable = retryable;
    this.tokensUsed = tokensUsed; // spent before the failure — still counted against the person's tokens
  }
}

const MAX_OUTPUT_TOKENS = 5000; // ~3,500 words; also keeps one request under Groq's per-minute token ceiling
const CONTEXT_MESSAGES = 6;
const CONTEXT_CHARS = 2000;

// ---------------------------------------------------------------------------
// Cleaning what the model wrote
// ---------------------------------------------------------------------------
function stripOuterFence(text) {
  const t = text.trim();
  const m = t.match(/^```(?:markdown|md|html|text)?[ \t]*\n([\s\S]*)\n```[ \t]*$/i);
  return m ? m[1].trim() : t;
}

const PREFACE = /^(sure|here(?:'s| is| are)|certainly|okay|of course|absolutely)\b[^\n]{0,140}$/i;
export function cleanMarkdown(text) {
  let t = stripOuterFence(text || "");
  const lines = t.split("\n");
  if (PREFACE.test(lines[0].trim())) {
    const at = lines.slice(0, 6).findIndex((l) => /^#{1,6}\s/.test(l));
    if (at > 0) t = lines.slice(at).join("\n");
  }
  return t.trim();
}

export function cleanHtml(text, fallbackTitle = "Page") {
  let t = stripOuterFence(text || "");
  const doctype = t.search(/<!doctype html/i);
  const htmlTag = t.search(/<html[\s>]/i);
  const start = doctype >= 0 ? doctype : htmlTag;
  if (start < 0) {
    // A fragment, not a page: wrap it so it opens properly on its own.
    t = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>${fallbackTitle}</title>\n</head>\n<body>\n${t}\n</body>\n</html>`;
  } else {
    t = t.slice(start);
    const end = t.toLowerCase().lastIndexOf("</html>");
    if (end >= 0) t = t.slice(0, end + 7);
  }
  // A reply cut off by the token limit still opens fine if it's closed properly.
  if (!/<\/body>/i.test(t)) t += "\n</body>";
  if (!/<\/html>/i.test(t)) t += "\n</html>";
  if (!/<!doctype/i.test(t)) t = `<!DOCTYPE html>\n${t}`;
  // Without these, Amharic shows as garbage and phones render the page tiny.
  if (!/<meta[^>]+charset/i.test(t)) t = t.replace(/<head[^>]*>/i, (m) => `${m}\n<meta charset="utf-8">`);
  if (!/name=["']viewport["']/i.test(t)) t = t.replace(/<head[^>]*>/i, (m) => `${m}\n<meta name="viewport" content="width=device-width, initial-scale=1">`);
  return t.trim() + "\n";
}

function htmlTitle(html, fallback) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const raw = m ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
  return raw.slice(0, 80) || fallback;
}

// A plain-text rendering of Markdown for .txt files.
export function markdownToText(markdown) {
  const out = [];
  const walk = (blocks, indent = "") => {
    for (const b of blocks) {
      if (b.type === "heading") out.push("", runsToText(b.runs).toUpperCase(), "");
      else if (b.type === "paragraph") out.push(indent + runsToText(b.runs), "");
      else if (b.type === "list") {
        let n = b.start;
        for (const item of b.items) {
          const marker = b.ordered ? `${n++}.` : "-";
          const [first, ...rest] = item.blocks;
          out.push(`${indent}${marker} ${first?.runs ? runsToText(first.runs) : ""}`);
          walk(rest.length ? rest : [], indent + "  ");
          if (first && first.type !== "paragraph") walk([first], indent + "  ");
        }
        out.push("");
      } else if (b.type === "code") out.push(...b.text.split("\n").map((l) => indent + "    " + l), "");
      else if (b.type === "quote") {
        const before = out.length;
        walk(b.blocks, indent);
        for (let i = before; i < out.length; i++) if (out[i]) out[i] = "> " + out[i];
      } else if (b.type === "table") {
        out.push(b.header.map(runsToText).join(" | "), b.header.map(() => "---").join(" | "));
        for (const row of b.rows) out.push(row.map(runsToText).join(" | "));
        out.push("");
      } else if (b.type === "hr") out.push("-----", "");
    }
  };
  walk(parseMarkdown(markdown));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
// What the person sees and saves it as — keeps their language (Amharic titles
// stay Amharic), loses only characters operating systems reject.
function displayStem(title, fallback) {
  const cleaned = (title || "").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || fallback;
}
// Storage path component: ASCII only, so it can never be awkward in a URL.
export function asciiSlug(title) {
  const s = (title || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "file";
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------
// history: [{ role, content, attachments? }] — the chat so far, including the
//          person's latest message.
// ask:     the model call; injectable so this can be tested without a network.
// Resolves to { buffer, mime, ext, displayName, title, tokensUsed, servedBy, summary }
// or throws FileGenError (userMessage is safe to show).
export async function createFile({ format, mode, request, history, ask = getConversationReply }) {
  const spec = FILE_FORMATS[format];
  if (!spec) throw new FileGenError("I can make HTML, Word, PDF, Markdown or text files.", { retryable: false });

  let markdown = "";
  let html = "";
  let tokensUsed = null;
  let servedBy = null;

  if (mode === "export") {
    if (format === "html") throw new FileGenError("I can't convert a chat reply into a web page — ask me to create one instead.", { retryable: false });
    const source = [...(history || [])]
      .reverse()
      .find((m) => m.role === "assistant" && !m.attachments?.length && (m.content || "").trim().length >= 20 && !m.content.startsWith("⚠️"));
    if (!source) throw new FileGenError("There's nothing to convert yet — ask me a question first, then say \"give me that as a PDF\".", { retryable: false });
    markdown = cleanMarkdown(source.content);
  } else {
    const recent = (history || []).slice(-CONTEXT_MESSAGES).map((m) => ({ role: m.role, content: (m.content || "").slice(0, CONTEXT_CHARS) }));
    // The stored message may still contain "/file pdf …"; the model gets the clean request.
    if (recent.length && recent[recent.length - 1].role === "user") recent[recent.length - 1].content = request;
    else recent.push({ role: "user", content: request });

    const result = await ask(
      recent,
      { savedMemories: [], allowMemorySave: false, allowImageMarker: false, fileTask: spec.source },
      { tier: "standard", maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 40000, totalBudgetMs: 48000 }
    );
    tokensUsed = result?.tokensUsed ?? null;
    servedBy = result?.servedBy ?? null;
    const text = (result?.text || "").trim();
    if (!text || text.startsWith("⚠️ All AI providers failed")) {
      throw new FileGenError("The AI service is busy right now — please try again in a minute. This didn't use any of your file allowance.");
    }
    if (spec.source === "html") html = cleanHtml(text);
    else markdown = cleanMarkdown(text);
  }

  const bodyLength = spec.source === "html" ? html.length : markdown.length;
  if (bodyLength < (spec.source === "html" ? 200 : 40)) {
    throw new FileGenError("I couldn't write that one properly — try describing it with a bit more detail. This didn't use any of your file allowance.", { tokensUsed });
  }

  const title = spec.source === "html" ? htmlTitle(html, "Web page") : extractTitle(markdown) || "Document";
  let buffer;
  try {
    if (format === "html") buffer = Buffer.from(html, "utf8");
    else if (format === "md") buffer = Buffer.from(markdown + "\n", "utf8");
    else if (format === "txt") buffer = Buffer.from(markdownToText(markdown), "utf8");
    else if (format === "docx") buffer = await markdownToDocx(markdown);
    else buffer = await markdownToPdf(markdown, { title });
  } catch (err) {
    console.error(`Rendering ${format} failed:`, err);
    throw new FileGenError("I wrote it but couldn't build the file — please try again. This didn't use any of your file allowance.", { tokensUsed });
  }

  const stem = displayStem(title, spec.source === "html" ? "website" : "document");
  const words = (spec.source === "html" ? html.replace(/<[^>]+>/g, " ") : markdown).split(/\s+/).filter(Boolean).length;
  return {
    buffer,
    mime: spec.mime,
    ext: spec.ext,
    displayName: `${stem}.${spec.ext}`,
    title,
    tokensUsed,
    servedBy,
    summary: { words, bytes: buffer.length, label: spec.label },
  };
}
