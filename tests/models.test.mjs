// Run from the project folder:  node --no-deprecation tests/models.test.mjs
// Checks the model choices and reply cleanup in lib/ai.js (no network).

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { cleanModelText, providerCatalog } = await import("../lib/ai.js");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

// ---- cleanModelText: what a person must never be shown
check("plain text is untouched", cleanModelText("Hello, world.") === "Hello, world.");
check("markdown/code with angle brackets is untouched", cleanModelText("Use `<div>` and a < b | c > d") === "Use `<div>` and a < b | c > d");
check("the literal reply seen from Cloudflare's gpt-oss-120b becomes empty (-> next provider answers)", cleanModelText("<|start|>assistant") === "");
check("control tokens around real text are stripped", cleanModelText("<|start|>assistant<|channel|>final<|message|>The answer is 4.<|end|>") === "The answer is 4.");
check("only what follows the LAST 'final' marker is kept (analysis channel dropped)", cleanModelText("<|channel|>analysis<|message|>thinking...<|end|><|start|>assistant<|channel|>final<|message|>Done.") === "Done.");
check("stray tokens mid-text are removed", cleanModelText("A<|return|> B") === "A B");
check("whitespace trimmed", cleanModelText("  hi \n") === "hi");
check("non-strings pass through (so '!text' still means no reply)", cleanModelText(null) === null && cleanModelText(undefined) === undefined);
check("empty string stays empty", cleanModelText("") === "");

// ---- model choices
const cat = providerCatalog();
const ids = cat.openAiCompatible.map((r) => r.model);
check("no retired model ids remain", !ids.includes("llama-3.1-8b-instant") && !ids.includes("openai/gpt-oss-120b:free") && !ids.includes("qwen/qwen2.5-vl-32b-instruct:free"), ids.join(" | "));
const flash = cat.openAiCompatible.find((r) => r.tier === "flash" && /groq/.test(r.baseUrl));
check("fast mode's Groq model is gpt-oss-20b (Groq's own replacement)", flash.model === "openai/gpt-oss-20b");
const orRows = cat.openAiCompatible.filter((r) => /openrouter/.test(r.baseUrl));
check("every OpenRouter model is a :free id", orRows.length === 2 && orRows.every((r) => r.model.endsWith(":free")), orRows.map((r) => r.model).join());
check("OpenRouter text + vision use the Gemma 4 free models", orRows.some((r) => r.tier === "standard" && r.model === "google/gemma-4-31b-it:free") && orRows.some((r) => r.tier === "vision" && r.model === "google/gemma-4-26b-a4b-it:free"));

// ---- env overrides, run in a fresh process (ai.js reads env at import time)
const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), "_probe_models.mjs");
import fs from "fs";
fs.writeFileSync(probe, `
process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { providerCatalog } = await import("../lib/ai.js");
const c = providerCatalog().openAiCompatible;
console.log(JSON.stringify({
  groqFlash: c.find((r) => r.tier === "flash" && /groq/.test(r.baseUrl)).model,
  orText: c.find((r) => r.tier === "standard" && /openrouter/.test(r.baseUrl)).model,
  orVision: c.find((r) => r.tier === "vision" && /openrouter/.test(r.baseUrl)).model,
}));
`);
const runWith = (env) => {
  const out = execFileSync(process.execPath, ["--no-deprecation", probe], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
};
try {
  const a = runWith({ GROQ_FLASH_MODEL: "qwen/qwen3.6-27b", OPENROUTER_MODEL: "nvidia/nemotron-3-super-120b-a12b:free", OPENROUTER_VISION_MODEL: "google/gemma-4-31b-it:free" });
  check("GROQ_FLASH_MODEL env var overrides the fast-mode model", a.groqFlash === "qwen/qwen3.6-27b");
  check("OPENROUTER_MODEL / OPENROUTER_VISION_MODEL accept :free ids", a.orText === "nvidia/nemotron-3-super-120b-a12b:free" && a.orVision === "google/gemma-4-31b-it:free");
  const b = runWith({ OPENROUTER_MODEL: "openai/gpt-oss-120b", OPENROUTER_VISION_MODEL: "anthropic/claude-sonnet-4.5" });
  check("a NON-free OpenRouter id is refused (it would bill you) -> default kept", b.orText === "google/gemma-4-31b-it:free" && b.orVision === "google/gemma-4-26b-a4b-it:free", JSON.stringify(b));
  const c2 = runWith({});
  check("nothing set -> the built-in defaults", c2.groqFlash === "openai/gpt-oss-20b" && c2.orText === "google/gemma-4-31b-it:free");
} finally {
  fs.rmSync(probe, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
