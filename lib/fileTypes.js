// lib/fileTypes.js
//
// One place that decides (a) what kind of file something is and (b) which
// plan is allowed to attach it. Used by the mini app (api/miniapp/messages.js
// + lib/attachments.js), the DM bot (api/telegram-webhook.js), and sent to
// the mini app frontend via /api/miniapp/usage so the picker can warn a free
// user before they waste an upload.
//
// Classification is by FILE EXTENSION first, because the MIME type a browser
// or Telegram client reports is unreliable for exactly the types we care
// about (a .csv is often "application/vnd.ms-excel" on Windows, source files
// are often "" or "application/octet-stream"). The one MIME-only fallback is
// "text/plain" with an unrecognised extension, which keeps behaving like a
// plain .txt for everyone, same as before this file existed.
//
// To change who gets what, edit the two lists below — nothing else needs to
// change. Move an extension between FREE_EXTS and PRO_EXTS to re-tier it.

// Available to every plan. The first four are the original set; .md/.csv
// are plain text, so they cost nothing extra to process.
const FREE_EXTS = {
  pdf: "pdf",
  docx: "docx",
  txt: "text",
  md: "text",
  csv: "text",
};

// Pro and Premium only. Office formats need real parsing (CPU + memory in a
// serverless function); the text-like ones are cheap but are what a heavy
// "paste my whole codebase/log/data" user sends, so they sit behind the
// paid plans to keep free-tier token spend in check.
const PRO_EXTS = {
  xlsx: "xlsx",
  pptx: "pptx",
  json: "text",
  html: "text",
  htm: "text",
  xml: "text",
  yml: "text",
  yaml: "text",
  toml: "text",
  ini: "text",
  log: "text",
  sql: "text",
  js: "text",
  mjs: "text",
  ts: "text",
  jsx: "text",
  tsx: "text",
  py: "text",
  java: "text",
  c: "text",
  h: "text",
  cpp: "text",
  cs: "text",
  go: "text",
  rs: "text",
  php: "text",
  rb: "text",
  sh: "text",
  css: "text",
};

export const PRO_ONLY_EXTS = Object.keys(PRO_EXTS);
export const FREE_EXTS_LIST = Object.keys(FREE_EXTS);

function extensionOf(name) {
  const lower = (name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot + 1);
}

// Returns { kind, ext, minPlan } or null if we can't read this file at all.
//   kind: "image" | "pdf" | "docx" | "text" | "xlsx" | "pptx"
//   minPlan: "free" | "pro"
export function classifyFile(name, mime) {
  const type = (mime || "").toLowerCase();
  if (type.startsWith("image/")) return { kind: "image", ext: extensionOf(name), minPlan: "free" };

  const ext = extensionOf(name);
  if (ext in FREE_EXTS) return { kind: FREE_EXTS[ext], ext, minPlan: "free" };
  if (ext in PRO_EXTS) return { kind: PRO_EXTS[ext], ext, minPlan: "pro" };

  // No/unknown extension: only trust the MIME type for the original
  // behaviour (PDF, .docx, plain text), never for anything new.
  if (type === "application/pdf") return { kind: "pdf", ext, minPlan: "free" };
  if (type.includes("wordprocessingml")) return { kind: "docx", ext, minPlan: "free" };
  if (type === "text/plain") return { kind: "text", ext, minPlan: "free" };
  return null;
}

// Human-readable summaries for error messages.
export const FREE_FILES_SUMMARY = "images, PDF, Word (.docx), and text/Markdown/CSV";
export const ALL_FILES_SUMMARY = "images, PDF, Word, Excel (.xlsx), PowerPoint (.pptx), and text/code/data files";
