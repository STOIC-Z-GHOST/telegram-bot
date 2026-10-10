// lib/fileGen/edit/index.js
//
// "Edit this file and send it back" — the entry point for Phases 2 and 3.
//
//   text / code / HTML / Markdown / CSV / JSON  -> edit/text.js   (Phase 2)
//   Excel (.xlsx)                                -> edit/xlsx.js   (Phase 2)
//   Word (.docx), in place                       -> edit/docx.js   (Phase 3)
//   PDF / PowerPoint / images                    -> a kind explanation, no AI call
//
// Like createFile this resolves to the same shape ({ buffer, mime, ext, displayName,
// title, tokensUsed, servedBy, summary }) plus `notes` (short lines for the person),
// or throws FileGenError whose userMessage is safe to show. The model call is
// injectable (`ask`) so all of it can be tested without a network.

import { getConversationReply } from "../../ai.js";
import { classifyFile } from "../../fileTypes.js";
import { FileGenError } from "../index.js";
import { editTextFile, mimeForText } from "./text.js";
import { editXlsxFile } from "./xlsx.js";
import { editDocxFile } from "./docx.js";
import { fileStem, extOf, countWords } from "./util.js";

const MAX_OUTPUT_TOKENS = 5000; // same ceiling as file creation (~3,500 words)
const MAX_INSTRUCTION_CHARS = 1500;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const EDITABLE_SUMMARY = "text, code, HTML, Markdown, CSV and JSON files, Word (.docx) and Excel (.xlsx)";

export async function editFile({ buffer, name, mime, instruction, ask = getConversationReply }) {
  const wanted = (instruction || "").trim();
  if (!wanted) {
    throw new FileGenError("Tell me what to change, e.g. \"change the title to Spring Menu\" or \"add a Total column\".", { retryable: false });
  }
  if (wanted.length > MAX_INSTRUCTION_CHARS) {
    throw new FileGenError("That instruction is a bit long — please shorten it to the key changes.", { retryable: false });
  }

  const cls = classifyFile(name, mime);
  if (!cls) throw new FileGenError(`I can edit ${EDITABLE_SUMMARY}. \"${name}\" isn't one of those.`, { retryable: false });
  if (cls.kind === "pdf") {
    throw new FileGenError(
      "I can't edit a PDF in place. Send it to me as a Word (.docx) file and I'll edit that, or tell me what the new version should say and I'll make a fresh PDF (/file pdf …).",
      { retryable: false }
    );
  }
  if (cls.kind === "pptx") {
    throw new FileGenError("I can't edit PowerPoint files yet. I can read one and answer questions about it, or create a new document with /file.", { retryable: false });
  }
  if (cls.kind === "image") {
    throw new FileGenError("I can't edit images. Use /image to create a new one.", { retryable: false });
  }

  const instructionText = wanted;
  const callModel = async (taskKey, prompt) => {
    const result = await ask(
      [{ role: "user", content: prompt }],
      { savedMemories: [], allowMemorySave: false, allowImageMarker: false, fileTask: taskKey },
      { tier: "standard", maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 40000, totalBudgetMs: 48000 }
    );
    const text = (result?.text || "").trim();
    if (!text || text.startsWith("⚠️ All AI providers failed")) {
      throw new FileGenError("The AI service is busy right now — please try again in a minute. This didn't use any of your file allowance.", { tokensUsed: result?.tokensUsed ?? null });
    }
    return { text, tokensUsed: result?.tokensUsed ?? null, servedBy: result?.servedBy ?? null };
  };

  const stem = fileStem(name);
  let result;
  let ext;
  let outMime;
  let label;
  if (cls.kind === "xlsx") {
    result = await editXlsxFile({ buffer, name, instruction: instructionText, ask: callModel });
    ext = "xlsx"; outMime = XLSX_MIME; label = "edited spreadsheet";
  } else if (cls.kind === "docx") {
    result = await editDocxFile({ buffer, name, instruction: instructionText, ask: callModel });
    ext = "docx"; outMime = DOCX_MIME; label = "edited Word document";
  } else {
    ext = cls.ext || extOf(name) || "txt";
    result = await editTextFile({ buffer, name, ext, instruction: instructionText, ask: callModel });
    outMime = mimeForText(ext); label = "edited file";
  }

  const words = result.wordsText ? countWords(result.wordsText) : 0;
  return {
    buffer: result.buffer,
    mime: outMime,
    ext,
    displayName: `${stem}-edited.${ext}`,
    title: `${stem}-edited`,
    tokensUsed: result.tokensUsed,
    servedBy: result.servedBy,
    notes: result.notes || [],
    summary: { words, bytes: result.buffer.length, label },
  };
}
