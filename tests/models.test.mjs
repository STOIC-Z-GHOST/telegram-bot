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
check("the '!!!!' filler Cloudflare's gpt-oss-120b returned becomes empty (-> next provider answers)", cleanModelText("!!!!!!!!!!!!!!!!!!!!!!!!") === "" && cleanModelText("  ........\n") === "");
check("short punctuation / emoji replies are real answers and untouched", cleanModelText("?") === "?" && cleanModelText("...") === "..." && cleanModelText("👍") === "👍" && cleanModelText("!!!") === "!!!");
check("filler inside a real sentence is untouched", cleanModelText("Wow!!!!!!!!!! That works.") === "Wow!!!!!!!!!! That works.");
check("empty string stays empty", cleanModelText("") === "");

// ---- model choices
const cat = providerCatalog();
const ids = cat.openAiCompatible.map((r) => r.model);
check("by default Max runs on OpenRouter's free Nemotron 3 Ultra (the Mistral key can't call Medium), and Mistral Max is NOT in the chain", cat.openAiCompatible.filter((r) => r.tier === "max").length === 1 && cat.openAiCompatible.some((r) => r.tier === "max" && r.name === "OpenRouter Max" && r.model === "nvidia/nemotron-3-ultra-550b-a55b:free") && !cat.openAiCompatible.some((r) => r.name === "Mistral Max"));
check("the Max model has no dollar budget (it is free); the daily Max caps are its guard", cat.openAiCompatible.find((r) => r.tier === "max").budget === null);
check("no retired model ids remain", !ids.includes("llama-3.1-8b-instant") && !ids.includes("openai/gpt-oss-120b:free") && !ids.includes("qwen/qwen2.5-vl-32b-instruct:free"), ids.join(" | "));
const flash = cat.openAiCompatible.find((r) => r.tier === "flash" && /groq/.test(r.baseUrl));
check("fast mode's Groq model is gpt-oss-20b (Groq's own replacement)", flash.model === "openai/gpt-oss-20b");
const orRows = cat.openAiCompatible.filter((r) => /openrouter/.test(r.baseUrl));
check("every OpenRouter model is a :free id", orRows.length === 2 && orRows.every((r) => r.model.endsWith(":free")), orRows.map((r) => r.model).join());
check("OpenRouter is NOT in the Standard chain by default (its shared free pool is reserved for Max); it is used for Max + vision", !orRows.some((r) => r.tier === "standard") && orRows.some((r) => r.tier === "max") && orRows.some((r) => r.tier === "vision" && r.model === "google/gemma-4-26b-a4b-it:free"));
check("Standard goes Groq -> Cloudflare -> Ministral 14B -> the small Mistral slot, and Ministral 14B comes before any OpenRouter use", (() => { const st = cat.openAiCompatible.filter((r) => r.tier === "standard").map((r) => r.name); return st.indexOf("Ministral 14B") > st.indexOf("Cloudflare") && !st.includes("OpenRouter"); })(), cat.openAiCompatible.filter((r) => r.tier === "standard").map((r) => r.name).join(" > "));
check("the Cloudflare fast default is the '-fast' id Cloudflare says stays active", cat.openAiCompatible.find((r) => r.tier === "flash" && /cloudflare/.test(r.baseUrl))?.model === "@cf/meta/llama-3.1-8b-instruct-fast" || !cat.openAiCompatible.some((r) => r.tier === "flash" && /cloudflare/.test(r.baseUrl)));

// ---- env overrides, run in a fresh process (ai.js reads env at import time)
const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), "_probe_models.mjs");
import fs from "fs";
fs.writeFileSync(probe, `
process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { providerCatalog } = await import("../lib/ai.js");
const c = providerCatalog().openAiCompatible;
console.log(JSON.stringify({
  groqFlash: c.find((r) => r.tier === "flash" && /groq/.test(r.baseUrl)).model,
  orText: c.find((r) => r.tier === "standard" && /openrouter/.test(r.baseUrl))?.model ?? null,
  orMax: c.find((r) => r.tier === "max" && /openrouter/.test(r.baseUrl))?.model ?? null,
  maxFirst: c.filter((r) => r.tier === "max").map((r) => r.name).join(">"),
  stdOrder: c.filter((r) => r.tier === "standard").map((r) => r.name).join(">"),
  orVision: c.find((r) => r.tier === "vision" && /openrouter/.test(r.baseUrl)).model,
}));
`);
const runWith = (env) => {
  const out = execFileSync(process.execPath, ["--no-deprecation", probe], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
};
try {
  const a = runWith({ OPENROUTER_IN_STANDARD: "1", GROQ_FLASH_MODEL: "qwen/qwen3.6-27b", OPENROUTER_MODEL: "nvidia/nemotron-3-super-120b-a12b:free", OPENROUTER_VISION_MODEL: "google/gemma-4-31b-it:free" });
  check("GROQ_FLASH_MODEL env var overrides the fast-mode model", a.groqFlash === "qwen/qwen3.6-27b");
  check("OPENROUTER_MODEL / OPENROUTER_VISION_MODEL accept :free ids", a.orText === "nvidia/nemotron-3-super-120b-a12b:free" && a.orVision === "google/gemma-4-31b-it:free");
  const b = runWith({ OPENROUTER_IN_STANDARD: "1", OPENROUTER_MODEL: "openai/gpt-oss-120b", OPENROUTER_VISION_MODEL: "anthropic/claude-sonnet-4.5", OPENROUTER_MAX_MODEL: "anthropic/claude-opus-4" });
  check("a NON-free OpenRouter id is refused (it would bill you) -> default kept, for text, vision AND Max", b.orText === "google/gemma-4-31b-it:free" && b.orVision === "google/gemma-4-26b-a4b-it:free" && b.orMax === "nvidia/nemotron-3-ultra-550b-a55b:free", JSON.stringify(b));
  const c2 = runWith({});
  check("nothing set -> the built-in defaults (no OpenRouter in Standard; Max = OpenRouter free)", c2.groqFlash === "openai/gpt-oss-20b" && c2.orText === null && c2.orMax === "nvidia/nemotron-3-ultra-550b-a55b:free");
  const m1 = runWith({ OPENROUTER_MAX_MODEL: "nvidia/nemotron-3-super-120b-a12b:free" });
  check("OPENROUTER_MAX_MODEL accepts another :free id", m1.orMax === "nvidia/nemotron-3-super-120b-a12b:free");
  const m2 = runWith({ MISTRAL_MAX_ENABLED: "1" });
  check("MISTRAL_MAX_ENABLED=1 puts Mistral Max FIRST in Max's chain, with OpenRouter's free model behind it", m2.maxFirst === "Mistral Max>OpenRouter Max", m2.maxFirst);
  const m3 = runWith({ MISTRAL_MAX_ENABLED: "true" });
  const m4 = runWith({ MISTRAL_MAX_ENABLED: "0" });
  check("'true' also turns it on; '0' leaves it off", m3.maxFirst === "Mistral Max>OpenRouter Max" && m4.maxFirst === "OpenRouter Max");
  const m5 = runWith({ OPENROUTER_IN_STANDARD: "1" });
  check("OPENROUTER_IN_STANDARD=1 brings OpenRouter back into Standard, after Cloudflare and before Ministral 14B", /Cloudflare>OpenRouter>Ministral 14B/.test(m5.stdOrder), m5.stdOrder);
} finally {
  fs.rmSync(probe, { force: true });
}

// ---- the Max model's price feeds the monthly-budget guard: it must follow the model
{
  const probe2 = path.join(path.dirname(fileURLToPath(import.meta.url)), "_probe_price.mjs");
  fs.writeFileSync(probe2, `
process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { providerCatalog } = await import("../lib/ai.js");
const m = providerCatalog().openAiCompatible.find((r) => r.name === "Mistral Max");
console.log(JSON.stringify({ model: m.model, cost: m.cost.usdPerM }));
`);
  const priceFor = (env) => JSON.parse(execFileSync(process.execPath, ["--no-deprecation", probe2], { env: { PATH: process.env.PATH, MISTRAL_MAX_ENABLED: "1", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
  try {
    const dflt = priceFor({});
    check("when enabled, Mistral Max defaults to Medium 3.5 (Large 403s on a free key), priced per the Mistral console ($2.70 / $8.10)", dflt.model === "mistral-medium-3-5" && dflt.cost.in === 2.7 && dflt.cost.out === 8.1, JSON.stringify(dflt));
    const l3 = priceFor({ MISTRAL_LARGE_MODEL: "mistral-large-2512" });
    check("Large 3 keeps its own price if someone sets it ($0.50 / $1.50)", l3.cost.in === 0.5 && l3.cost.out === 1.5);
    const l4 = priceFor({ MISTRAL_LARGE_MODEL: "mistral-large-4" });
    check("switching to mistral-large-4 switches the budget guard to its LIST price ($1.36 / $4.18)", l4.cost.in === 1.36 && l4.cost.out === 4.18, JSON.stringify(l4));
    const med = priceFor({ MISTRAL_LARGE_MODEL: "mistral-medium-latest" });
    check("the -latest alias gets the Medium price too", med.cost.in === 2.7 && med.cost.out === 8.1, JSON.stringify(med));
    const unk = priceFor({ MISTRAL_LARGE_MODEL: "some-future-model" });
    check("an unknown id gets the dearest price in the lineup, not a cheaper one", unk.cost.in >= 2.7 && unk.cost.out >= 8.1, JSON.stringify(unk));
    check("Medium is dearer than Large 4 on both counts (so 'unknown = Medium' really is the safe side)", dflt.cost.in > l4.cost.in && dflt.cost.out > l4.cost.out);
  } finally {
    fs.rmSync(probe2, { force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
