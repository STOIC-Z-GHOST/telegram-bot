// lib/fileGen/edit/util.js — small helpers shared by the edit modules.

import { FileGenError } from "../index.js";

// The model is told to reply with ONE JSON object, but small models still wrap it
// in a fence or add a sentence. Take everything from the first "{" to the last "}".
export function parseJsonObject(text, tokensUsed = null) {
  const raw = (text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new FileGenError("I couldn't work out the changes to make — please say it a bit more specifically and try again. This didn't use any of your file allowance.", { tokensUsed });
  }
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new FileGenError("I couldn't work out the changes to make — please say it a bit more specifically and try again. This didn't use any of your file allowance.", { tokensUsed });
  }
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function countWords(text) {
  return (text || "").split(/\s+/).filter(Boolean).length;
}

// "report.final.docx" -> "report.final"
export function fileStem(name) {
  const base = (name || "file").replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "file";
}

export function extOf(name) {
  const lower = (name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot + 1).replace(/[^a-z0-9]/g, "");
}
