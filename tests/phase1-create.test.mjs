// Run from the project folder:  node --no-deprecation tests/phase1-create.test.mjs
// (needs `npm install`; uses a mocked AI model — no network, no database)
import { createFile, FileGenError } from "../lib/fileGen/index.js";
import { detectFileRequest } from "../lib/fileGen/detect.js";
import fs from "fs";
import os from "os";
import path from "path";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "botfiles-")); // sample output files land here

// ---- detection
const cases = [
  ["make me a pdf study plan for physics", "pdf"],
  ["create a website for my bakery", "html"],
  ["write a word document about climate change", "docx"],
  ["give me that as a PDF", "pdf"],
  ["turn that into a Word doc", "docx"],
  ["/file pdf my CV", "pdf"],
  ["how do I make a PDF in python", null],
  ["what is a website", null],
  ["generate an image of a website logo", null],
  ["hello how are you", null],
];
let dOk = 0;
for (const [msg, want] of cases) {
  const r = detectFileRequest(msg);
  const got = r ? r.format : null;
  const ok = got === want; if (ok) dOk++;
  console.log(ok ? "ok  " : "FAIL", JSON.stringify(msg), "->", got, r?.mode || "", "(want", want + ")");
}
console.log(`detection: ${dOk}/${cases.length}\n`);

// ---- creation with a mocked model
const md = `# የጥናት እቅድ — Study Plan\n\nA short **plan** with *emphasis*, \`code\` and a [link](https://example.com).\n\n## Week 1\n\n- Read chapter 1\n- Solve problems\n  - nested item\n\n1. First\n2. Second\n\n| Day | Task |\n|---|---|\n| Mon | ሰኞ ንባብ |\n| Tue | Practice |\n\n> A quote here\n\n\`\`\`js\nconsole.log("hi");\n\`\`\`\n\n---\n\nThe end. ሰላም ለዓለም።\n`;
const html = `Sure, here it is:\n\`\`\`html\n<!DOCTYPE html><html><head><title>Bakery</title></head><body><h1>Bakery</h1><p>${"Fresh bread every day. ".repeat(15)}</p></body></html>\n\`\`\``;
const mockAsk = (fmt) => async () => ({ text: fmt === "html" ? html : md, tokensUsed: 1234, servedBy: "mock" });

for (const format of ["md", "txt", "docx", "pdf", "html"]) {
  try {
    const r = await createFile({ format, mode: "create", request: "make it", history: [{ role: "user", content: "make it" }], ask: mockAsk(format) });
    fs.writeFileSync(path.join(OUT, r.displayName), r.buffer);
    console.log("OK ", format, r.displayName, r.buffer.length, "bytes", JSON.stringify(r.summary));
  } catch (e) { console.log("FAIL", format, e.message); }
}

// export mode (no AI call)
try {
  const r = await createFile({ format: "pdf", mode: "export", request: "", history: [{ role: "user", content: "hi" }, { role: "assistant", content: md }], ask: async () => { throw new Error("AI must not be called"); } });
  console.log("OK  export pdf", r.buffer.length, "tokensUsed:", r.tokensUsed);
} catch (e) { console.log("FAIL export", e.message); }

// error paths
for (const [label, ask] of [["provider down", async () => ({ text: "⚠️ All AI providers failed" })], ["empty", async () => ({ text: "" })], ["too short", async () => ({ text: "# hi" })], ["throws", async () => { throw new Error("boom"); }]]) {
  try { await createFile({ format: "pdf", mode: "create", request: "x", history: [], ask }); console.log("FAIL no error for", label); }
  catch (e) { console.log(e instanceof FileGenError ? "OK  " : "RAW ", "error path:", label, "->", e.userMessage || e.message); }
}
