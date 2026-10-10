// lib/fileGen/detect.js
//
// Is this message asking the bot to MAKE A FILE? Deliberately a plain keyword
// check, not an instruction we hand the AI on every message: that approach
// (the [GENERATE_IMAGE] marker) let a small model misfire and spend a free user's
// image allowance on "build a simple website". A wrong guess here is expensive
// too (a file costs a daily file allowance and a few thousand tokens), so the
// rules lean toward NOT triggering; /file always works as the explicit way in.
//
// Returns null (not a file request) or
//   { format: "html" | "docx" | "pdf" | "md" | "txt",
//     mode: "create"  — ask the AI to write it
//         | "export"  — no AI call: convert the assistant's last reply,
//     request: the text to hand the AI (create mode),
//     explicit: true for /file — the person asked for a file by name, so a limit
//               is an error; a natural-language guess falls back to a normal chat reply }

const FORMAT_ALIASES = {
  html: "html", htm: "html", website: "html", webpage: "html",
  docx: "docx", word: "docx", doc: "docx",
  pdf: "pdf",
  md: "md", markdown: "md",
  txt: "txt", text: "txt",
};

// What each word in a message points to. Order matters: first match wins.
const FORMAT_WORDS = [
  ["html", /\b(html|web ?site|web ?page|landing page|portfolio site)\b/i],
  ["pdf", /\bpdf\b/i],
  ["docx", /\b(docx|word (?:doc|document|file)|ms word|microsoft word)\b/i],
  ["md", /\bmarkdown(?: file)?\b|\.md\b/i],
  ["txt", /\b(?:text|txt) file\b|\.txt\b/i],
];

const CREATE_VERB =
  /\b(make|create|build|generate|write|produce|prepare|draft|design|give me|get me|i need|i want|can you (?:make|create|build|write|generate)|could you (?:make|create|build|write|generate)|please (?:make|create|build|write|generate))\b/i;

// "How do I make a PDF in Python" is a coding question, not a file order.
const QUESTION_OPENER = /^\s*(how|what|why|which|where|when|who|is|are|does|do|did)\b/i;
const CODE_CONTEXT =
  /\b(python|php|java|node(?:\.?js)?|c#|c\+\+|ruby|golang|rust|swift|kotlin|library|package|npm|pip|api|function|script|react|next\.?js|vue|angular|svelte|flask|django|express|code (?:to|for|that))\b/i;
// A request for a picture of a website/logo/etc. belongs to image generation.
const IMAGE_WORDS = /\b(image|picture|photo|mockup|mock-up|drawing|illustration|logo|wallpaper|poster|icon)\b/i;

// "turn that into a PDF", "give me that as a Word doc", "make a PDF of it"
const EXPORT_A =
  /\b(?:convert|turn|export|save|put|make|send|give(?: me)?|download|print)\b[^.?!\n]{0,40}\b(?:this|that|it|above|previous|last (?:answer|reply|response|message)|your (?:answer|reply|response))\b[^.?!\n]{0,25}\b(pdf|docx|word(?: doc(?:ument)?)?|markdown|md|text file|txt)\b/i;
const EXPORT_B =
  /\b(?:make|create|give me|send me|get me)\b[^.?!\n]{0,15}\b(pdf|word doc(?:ument)?|docx|markdown|text file|txt)\b[^.?!\n]{0,20}\b(?:of|from|out of)\s+(?:this|that|it|the above|your (?:answer|reply|response)|our (?:chat|conversation))\b/i;

function normaliseFormat(word) {
  return FORMAT_ALIASES[(word || "").toLowerCase().replace(/[^a-z]/g, "")] || null;
}
function formatFromWords(text) {
  for (const [format, pattern] of FORMAT_WORDS) if (pattern.test(text)) return format;
  return null;
}

export function detectFileRequest(text) {
  const t = (text || "").trim();
  if (!t) return null;

  // Explicit: /file [format] <what to make>
  const cmd = t.match(/^\/file(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (cmd) {
    let rest = (cmd[1] || "").trim();
    const first = rest.split(/\s+/)[0];
    let format = normaliseFormat(first);
    if (format && FORMAT_ALIASES[first.toLowerCase().replace(/[^a-z]/g, "")]) rest = rest.slice(first.length).trim();
    else format = null;
    format = format || formatFromWords(rest) || "docx"; // Word is the editable default
    const exportsLast = !rest || /^(?:of |from |for )?(?:this|that|it|the above|above|last (?:answer|reply|response))\b/i.test(rest);
    if (exportsLast && format !== "html") return { format, mode: "export", request: "", explicit: true };
    return { format, mode: "create", request: rest, explicit: true };
  }
  if (t.startsWith("/")) return null; // some other command

  if (QUESTION_OPENER.test(t) || CODE_CONTEXT.test(t) || IMAGE_WORDS.test(t)) return null;

  const exportMatch = t.match(EXPORT_A) || t.match(EXPORT_B);
  if (exportMatch) {
    const format = formatFromWords(exportMatch[1]) || normaliseFormat(exportMatch[1].split(/\s+/)[0]);
    if (format && format !== "html") return { format, mode: "export", request: "", explicit: false };
  }

  const format = formatFromWords(t);
  if (format && CREATE_VERB.test(t)) return { format, mode: "create", request: t, explicit: false };
  return null;
}
