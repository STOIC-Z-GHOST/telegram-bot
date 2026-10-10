// lib/fileGen/editDetect.js
//
// Is this message asking the bot to EDIT a file the person uploaded? Same philosophy
// as detect.js: a plain keyword check that leans toward NOT triggering (a wrong guess
// costs a file allowance and some tokens), with an explicit way in that always works:
//
//     /file edit <what to change>     (send it as the caption of the file, or — in the
//                                      mini app — on its own to edit the file most
//                                      recently shared in this chat)
//
// Natural language ("fix the typos", "add a Total column") only counts when exactly one
// readable-and-editable file is attached, there's an edit verb, and the message isn't
// a question or a request to explain/summarise.
//
// Returns null, or { mode: "edit", instruction, explicit, attachment }
//   attachment is null only for the explicit command with nothing attached.

import { classifyFile } from "../fileTypes.js";

const EDIT_COMMAND = /^\/file(?:@\w+)?\s+edit\b[:\s]*([\s\S]*)$/i;
const BARE_EDIT_COMMAND = /^\/file(?:@\w+)?\s+edit$/i;

const EDIT_VERB =
  /\b(edit|change|fix|update|modify|rewrite|rework|revise|translate|add|insert|append|remove|delete|replace|rename|correct|proofread|reformat|format|clean ?up|shorten|expand|improve|polish|refactor|sort|fill in|calculate|capitali[sz]e|bold|highlight|colou?r|make (?:it|the|this))\b/i;
const NOT_AN_EDIT =
  /\b(explain|why|what|how|summari[sz]e|summary|describe|review|analy[sz]e|tell me|is there|are there|can you tell|list|count|compare|who|when|where)\b/i;
const QUESTION_OPENER = /^\s*(how|what|why|which|where|when|who|is|are|does|do|did|can you tell|could you tell)\b/i;

// Kinds a natural-language message may edit. (PDF/PowerPoint are only picked up by the
// explicit command, which then explains why they can't be edited — a plain "translate
// this PDF" should just be answered in chat.)
const NATURAL_KINDS = new Set(["text", "xlsx", "docx"]);

export function detectEditRequest(text, attachments = []) {
  const t = (text || "").trim();
  if (!t) return null;
  const files = (attachments || []).filter((a) => a && !(a.type || "").startsWith("image/"));

  const cmd = t.match(EDIT_COMMAND);
  if (cmd || BARE_EDIT_COMMAND.test(t)) {
    if (files.length > 1) return { mode: "edit", instruction: "", explicit: true, attachment: null, tooMany: true };
    return { mode: "edit", instruction: (cmd?.[1] || "").trim(), explicit: true, attachment: files[0] || null };
  }
  if (t.startsWith("/")) return null; // some other command

  if (files.length !== 1) return null;
  if (QUESTION_OPENER.test(t) || NOT_AN_EDIT.test(t)) return null;
  if (!EDIT_VERB.test(t)) return null;
  const cls = classifyFile(files[0].name, files[0].type);
  if (!cls || !NATURAL_KINDS.has(cls.kind)) return null;
  return { mode: "edit", instruction: t, explicit: false, attachment: files[0] };
}
