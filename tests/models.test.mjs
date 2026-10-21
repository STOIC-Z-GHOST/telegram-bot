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
check("hidden reasoning between <think> tags is removed, the answer kept", cleanModelText("<think>The user wants a greeting. Be brief.</think>Hello there!") === "Hello there!");
check("multi-line / multiple <think> blocks are removed", cleanModelText("<think>a\nb</think>One <think>c</think>Two") === "One Two");
check("thinking that was cut off before the answer counts as NO text (the next provider answers)", cleanModelText("<think>The user asks about") === "");
check("an ordinary mention of the word think is untouched", cleanModelText("I think so, and <thinking> is not a tag here") === "I think so, and <thinking> is not a tag here");
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
check("by default Max = Cloudflare's DeepSeek V4 Pro (within its daily neuron slice) then Groq's Qwen 3.8 27B; Mistral Max (blocked on this key) and OpenRouter Max (logs prompts for NVIDIA) are NOT in the chain", cat.openAiCompatible.filter((r) => r.tier === "max").map((r) => r.name).join(">") === "Cloudflare Max>Groq Max" && cat.openAiCompatible.some((r) => r.tier === "max" && r.name === "Groq Max" && r.model === "qwen/qwen3.8-27b") && cat.openAiCompatible.some((r) => r.name === "Cloudflare Max" && r.model === "@cf/deepseek-ai/deepseek-v4-pro-0813") && !cat.openAiCompatible.some((r) => r.name === "Mistral Max" || r.name === "OpenRouter Max"));
check("no free NVIDIA route is used anywhere by default", !cat.openAiCompatible.some((r) => /nvidia/i.test(r.model)));
check("Cloudflare Max is guarded by the neuron pot AND its own slice; Groq Max has no budget (the daily Max caps are its guard)", cat.openAiCompatible.find((r) => r.name === "Cloudflare Max")?.subBudget === "cloudflare_max" && cat.openAiCompatible.find((r) => r.name === "Cloudflare Max").budget === "cloudflare" && cat.openAiCompatible.find((r) => r.name === "Groq Max").budget === null);
check("no retired model ids remain", !ids.includes("llama-3.1-8b-instant") && !ids.includes("openai/gpt-oss-120b:free") && !ids.includes("qwen/qwen2.5-vl-32b-instruct:free"), ids.join(" | "));
const flash = cat.openAiCompatible.find((r) => r.tier === "flash" && /groq/.test(r.baseUrl));
check("fast mode's Groq model is gpt-oss-20b (Groq's own replacement)", flash.model === "openai/gpt-oss-20b");
const orRows = cat.openAiCompatible.filter((r) => /openrouter/.test(r.baseUrl));
check("every OpenRouter model is a :free id", orRows.length === 1 && orRows.every((r) => r.model.endsWith(":free")), orRows.map((r) => r.model).join());
check("by default OpenRouter is used only as a vision fallback (not in Standard, not in Max)", orRows.length === 1 && orRows[0].tier === "vision" && orRows[0].model === "google/gemma-4-26b-a4b-it:free");
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
  maxModels: c.filter((r) => r.tier === "max").map((r) => r.model).join(">"),
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
  check("a NON-free OpenRouter id is refused (it would bill you) -> default kept for text and vision; a non-free Max id leaves OpenRouter Max OFF", b.orText === "google/gemma-4-31b-it:free" && b.orVision === "google/gemma-4-26b-a4b-it:free" && b.orMax === null, JSON.stringify(b));
  const c2 = runWith({});
  check("nothing set -> the built-in defaults (no OpenRouter in Standard; Max = Cloudflare Max then Groq Max)", c2.groqFlash === "openai/gpt-oss-20b" && c2.orText === null && c2.orMax === null && c2.maxFirst === "Cloudflare Max>Groq Max");
  const g1 = runWith({ GROQ_MAX_MODEL: "openai/gpt-oss-safeguard-20b" });
  check("GROQ_MAX_MODEL changes Groq's Max model", g1.maxModels === "@cf/deepseek-ai/deepseek-v4-pro-0813>openai/gpt-oss-safeguard-20b", g1.maxModels);
  const g2 = runWith({ GROQ_MAX_MODEL: "   " });
  check("a blank GROQ_MAX_MODEL falls back to the default", g2.maxModels === "@cf/deepseek-ai/deepseek-v4-pro-0813>qwen/qwen3.8-27b", g2.maxModels);
  const m1 = runWith({ OPENROUTER_MAX_MODEL: "meta/llama:free" });
  check("OPENROUTER_MAX_MODEL is OPT-IN: setting a :free id adds OpenRouter Max behind Groq Max", m1.orMax === "meta/llama:free" && m1.maxFirst === "Cloudflare Max>Groq Max>OpenRouter Max", m1.maxFirst);
  const m2 = runWith({ MISTRAL_MAX_ENABLED: "1" });
  check("MISTRAL_MAX_ENABLED=1 puts Mistral Max FIRST in Max's chain, with Cloudflare Max and Groq Max behind it", m2.maxFirst === "Mistral Max>Cloudflare Max>Groq Max", m2.maxFirst);
  const m3 = runWith({ MISTRAL_MAX_ENABLED: "true" });
  const m4 = runWith({ MISTRAL_MAX_ENABLED: "0" });
  check("'true' also turns it on; '0' leaves it off", m3.maxFirst === "Mistral Max>Cloudflare Max>Groq Max" && m4.maxFirst === "Cloudflare Max>Groq Max");
  check("all four together keep that order", runWith({ MISTRAL_MAX_ENABLED: "1", OPENROUTER_MAX_MODEL: "meta/llama:free" }).maxFirst === "Mistral Max>Cloudflare Max>Groq Max>OpenRouter Max");
  check("CF_MAX_MODEL=off removes Cloudflare Max (Max = Groq's Qwen alone)", runWith({ CF_MAX_MODEL: "off" }).maxFirst === "Groq Max");
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

// ---- Max end to end: an upstream failure returned as HTTP 200 is named in the log, and the user still gets an answer
{
  const fs2 = await import("fs");
  const probe3 = path.join(path.dirname(fileURLToPath(import.meta.url)), "_probe_max_flow.mjs");
  fs2.writeFileSync(probe3, `
    const warns = [];
    console.warn = (...a) => warns.push(a.join(" "));
    console.log = () => {};
    const scenario = process.env.SCENARIO;
    const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 12 } }), { status: 200 });
    globalThis.fetch = async (url, o) => {
      let model; try { model = JSON.parse(o.body).model; } catch { model = undefined; }
      if (model === "@cf/deepseek-ai/deepseek-v4-pro-0813") {
        if (scenario === "cf429") return new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded" }] }), { status: 429 });
        return reply("CF Max answer.");
      }
      if (model === "qwen/qwen3.8-27b") {
        if (scenario === "error200") return new Response(JSON.stringify({ error: { code: 502, message: "Upstream error from Nvidia: Service temporarily overloaded" } }), { status: 200 });
        if (scenario === "think") return reply("<think>planning the answer</think>Max answer.");
        if (scenario === "cutoff") return reply("<think>still thinking about");
        return reply("Max answer.");
      }
      return reply("Standard answer.");
    };
    const { getConversationReply } = await import("../lib/ai.js");
    const r = await getConversationReply([{ role: "user", content: "hi" }], {}, { tier: "max", thinking: scenario === "cfthink" });
    process.stdout.write("\\n" + JSON.stringify({ text: r.text, servedBy: r.servedBy, warns }));
  `);
  try {
    const flow = (scenario) => JSON.parse(execFileSync(process.execPath, ["--no-deprecation", probe3], { env: { PATH: process.env.PATH, SCENARIO: scenario, DATABASE_URL: "postgres://u:p@localhost.invalid/db", GROQ_API_KEY: "g", MISTRAL_API_KEY: "m", OPENROUTER_API_KEY: "o", GEMINI_API_KEY: "x", ...(/^cf/.test(scenario) ? { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" } : {}) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
    const ok = flow("ok");
    check("Max answered by Groq's Qwen counts as a Max reply (servedBy is the Max model)", ok.text === "Max answer." && ok.servedBy === "qwen/qwen3.8-27b", JSON.stringify(ok));
    const e = flow("error200");
    check("an HTTP-200 upstream error: the log names the real reason (not just 'returned no text')", e.warns.some((w) => /Groq Max/.test(w) && /Upstream error from Nvidia: Service temporarily overloaded/.test(w) && !/returned no text/.test(w)), JSON.stringify(e.warns));
    check("…and the user still gets a Standard answer (servedBy is NOT a Max model, so it is not counted as a Max reply)", e.text === "Standard answer." && e.servedBy === "openai/gpt-oss-120b", JSON.stringify(e));
    const t = flow("think");
    check("a Max reply with hidden <think> reasoning is delivered without it", t.text === "Max answer." && t.servedBy === "qwen/qwen3.8-27b", JSON.stringify(t));
    const cfOk = flow("cfok");
    check("with Cloudflare configured, Max is answered by Cloudflare's big model FIRST (and counts as a Max reply)", cfOk.text === "CF Max answer." && cfOk.servedBy === "@cf/deepseek-ai/deepseek-v4-pro-0813", JSON.stringify(cfOk));
    const cf429 = flow("cf429");
    check("when Cloudflare Max is rate-limited, Max falls to Groq's Qwen (still a Max reply), not straight to Standard", cf429.text === "Max answer." && cf429.servedBy === "qwen/qwen3.8-27b", JSON.stringify(cf429));
    const cfThink = flow("cfthink");
    check("in think mode Cloudflare Max is skipped (reasoning tokens would eat the slice) and Groq's Qwen answers", cfThink.text === "Max answer." && cfThink.servedBy === "qwen/qwen3.8-27b", JSON.stringify(cfThink));
    const c = flow("cutoff");
    check("a Max reply that is only cut-off thinking falls back to Standard", c.text === "Standard answer." && c.servedBy === "openai/gpt-oss-120b", JSON.stringify(c));
  } finally { fs2.rmSync(probe3, { force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
