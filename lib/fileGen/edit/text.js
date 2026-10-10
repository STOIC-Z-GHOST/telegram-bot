// lib/fileGen/edit/text.js
//
// Phase 2a — edit a text-like upload (txt, md, csv, json, html, code, config, logs…).
//
// Two ways, chosen by size, because the model can only WRITE ~5,000 tokens:
//   • small file  -> the model returns the WHOLE new file between markers
//   • larger file -> the model returns a short list of {find, replace} patches that
//                    we apply ourselves, so unchanged text is never re-typed (and so
//                    can never be silently dropped or truncated)
// Either way we check the result before delivering it (valid JSON stays valid JSON,
// a page keeps its </html>, a file can't quietly lose most of its content).

import { FileGenError } from "../index.js";
import { parseJsonObject, plural } from "./util.js";

export const FULL_REWRITE_MAX_CHARS = 8000;
export const TEXT_EDIT_MAX_CHARS = 30000;
const MAX_PATCHES = 40;
const SHRINK_WORDS = /\b(shorten|short|cut|trim|remove|delete|drop|summari[sz]e|condense|reduce|less|minify|compress|strip|clean ?up|simplify)\b/i;

const START = "<<<FILE_START>>>";
const END = "<<<FILE_END>>>";

// ---------------------------------------------------------------------------
function fullPrompt(name, text, instruction) {
  return (
    `Edit the file "${name}" as instructed. Return the COMPLETE edited file between ${START} and ${END}.\n` +
    `Keep every part the instruction doesn't touch exactly as it is.\n\n` +
    `Instruction: ${instruction}\n\n${START}\n${text}\n${END}`
  );
}

function patchPrompt(name, text, instruction) {
  return (
    `Edit the file "${name}" as instructed, by listing replacements. Reply with ONE JSON object:\n` +
    `{"edits":[{"find":"<text copied EXACTLY from the file>","replace":"<new text>"}]}\n` +
    `Rules:\n` +
    `- "find" must be copied character-for-character from the file (same spaces, indentation, punctuation) and be long enough to appear only ONCE — usually a whole line or several lines.\n` +
    `- To delete text, use "replace": "". To insert, find a nearby line and "replace" with that line plus the new text.\n` +
    `- Add "all": true to an edit only if EVERY occurrence of "find" should change.\n` +
    `- At most ${MAX_PATCHES} edits. If the instruction needs the whole file rewritten (for example translating all of it), reply {"too_big": true}.\n\n` +
    `Instruction: ${instruction}\n\n${START}\n${text}\n${END}`
  );
}

function stripFence(text) {
  const t = (text || "").trim();
  const m = t.match(/^```[\w-]*[ \t]*\n([\s\S]*)\n```[ \t]*$/);
  return m ? m[1] : t;
}

// Pulls the file out from between the markers; falls back to the whole reply
// (minus a fence) if the model ignored them. A START with no END means the reply
// was cut off — never deliver that.
function extractFile(reply) {
  const s = reply.indexOf(START);
  if (s >= 0) {
    const from = s + START.length;
    const e = reply.lastIndexOf(END);
    if (e < from) return { truncated: true, text: "" };
    return { truncated: false, text: reply.slice(from, e).replace(/^\r?\n/, "").replace(/\r?\n$/, "") };
  }
  return { truncated: false, text: stripFence(reply) };
}

// ---------------------------------------------------------------------------
// Applying patches — plain string slicing (String.replace would treat "$&" in the
// new text as a pattern).
// ---------------------------------------------------------------------------
function countOccurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

export function applyPatches(original, edits) {
  let text = original;
  let applied = 0;
  const failed = [];
  for (const e of edits) {
    const find = typeof e?.find === "string" ? e.find : "";
    const replace = typeof e?.replace === "string" ? e.replace : null;
    if (!find || replace === null) { failed.push("an edit was malformed"); continue; }
    const n = countOccurrences(text, find);
    const preview = find.replace(/\s+/g, " ").trim().slice(0, 40);
    if (n === 0) { failed.push(`couldn't find "${preview}"`); continue; }
    if (n > 1 && e.all !== true) { failed.push(`"${preview}" appears ${n} times`); continue; }
    text = e.all === true ? text.split(find).join(replace) : text.slice(0, text.indexOf(find)) + replace + text.slice(text.indexOf(find) + find.length);
    applied++;
  }
  return { text, applied, failed };
}

// ---------------------------------------------------------------------------
function validate(ext, before, after, instruction, tokensUsed) {
  const bad = (msg) => new FileGenError(`${msg} I didn't send a broken file, and this didn't use any of your file allowance.`, { tokensUsed });
  if (!after.trim()) throw bad("The edit came back empty.");
  if (ext === "json") {
    let wasValid = true;
    try { JSON.parse(before); } catch { wasValid = false; }
    if (wasValid) {
      try { JSON.parse(after); } catch { throw bad("The edited JSON wasn't valid."); }
    }
  }
  if ((ext === "html" || ext === "htm") && /<\/html>/i.test(before) && !/<\/html>/i.test(after)) {
    throw bad("The edited page was cut off before the end.");
  }
  if (before.length > 500 && after.length < before.length * 0.35 && !SHRINK_WORDS.test(instruction)) {
    throw bad("The edited file came back far shorter than the original, so it was probably cut off.");
  }
}

const MIME = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html",
  xml: "application/xml", yml: "text/yaml", yaml: "text/yaml", css: "text/css", js: "text/javascript", mjs: "text/javascript",
};
export function mimeForText(ext) { return MIME[ext] || "text/plain"; }

// ask: (taskKey, prompt) -> { text, tokensUsed, servedBy }
export async function editTextFile({ buffer, name, ext, instruction, ask }) {
  if (buffer.includes(0)) throw new FileGenError("That looks like a binary file, not text, so I can't edit it.", { retryable: false });
  let original = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!original.trim()) throw new FileGenError("That file is empty — there's nothing to edit.", { retryable: false });
  if (original.length > TEXT_EDIT_MAX_CHARS) {
    throw new FileGenError(
      `That file is too long for me to edit safely (about ${TEXT_EDIT_MAX_CHARS.toLocaleString("en-US")} characters is my limit). Send just the part you want changed, or split the file.`,
      { retryable: false }
    );
  }
  const crlf = original.includes("\r\n");
  if (crlf) original = original.replace(/\r\n/g, "\n"); // the model sees LF; we put CRLF back at the end

  const full = original.length <= FULL_REWRITE_MAX_CHARS;
  const reply = await ask(full ? "edit_full" : "edit_patch", (full ? fullPrompt : patchPrompt)(name, original, instruction));
  const notes = [];
  let edited;

  if (full) {
    const got = extractFile(reply.text);
    if (got.truncated) {
      throw new FileGenError("The edited file was cut off before the end, so I didn't send it. Try a smaller change or a shorter file. This didn't use any of your file allowance.", { tokensUsed: reply.tokensUsed });
    }
    // Models are inconsistent about the final newline; keep whatever the original had.
    edited = got.text.replace(/\n+$/, "");
    if (original.endsWith("\n")) edited += "\n";
    if (edited === original) {
      throw new FileGenError("I couldn't find anything to change — tell me exactly what to edit. This didn't use any of your file allowance.", { tokensUsed: reply.tokensUsed });
    }
    notes.push("✅ Edited the whole file; everything you didn't mention was kept as it was.");
  } else {
    const plan = parseJsonObject(reply.text, reply.tokensUsed);
    if (plan.too_big) {
      throw new FileGenError("That change touches too much of a long file for me to do in one go. Try asking for one section or one kind of change at a time. This didn't use any of your file allowance.", { retryable: false, tokensUsed: reply.tokensUsed });
    }
    const edits = Array.isArray(plan.edits) ? plan.edits.slice(0, MAX_PATCHES) : [];
    if (!edits.length) {
      throw new FileGenError("I couldn't find anything to change — tell me exactly what to edit. This didn't use any of your file allowance.", { tokensUsed: reply.tokensUsed });
    }
    const result = applyPatches(original, edits);
    if (!result.applied) {
      throw new FileGenError("I couldn't match the text to change in your file — try quoting the exact line you want changed. This didn't use any of your file allowance.", { tokensUsed: reply.tokensUsed });
    }
    edited = result.text;
    notes.push(`✅ ${plural(result.applied, "change")} applied.`);
    if (result.failed.length) notes.push(`⚠️ ${plural(result.failed.length, "change")} not applied (${result.failed.slice(0, 3).join("; ")}).`);
  }

  validate(ext, original, edited, instruction, reply.tokensUsed);
  if (crlf) edited = edited.replace(/\n/g, "\r\n");
  return { buffer: Buffer.from(edited, "utf8"), notes, tokensUsed: reply.tokensUsed, servedBy: reply.servedBy, wordsText: edited };
}
