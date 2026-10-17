// Run from the project folder:  node --no-deprecation tests/providerLimits.test.mjs
// Checks lib/providerLimits.js (what each key can use) against pretend provider replies — no network, no real keys.

import { runProviderLimits, formatProviderLimits } from "../lib/providerLimits.js";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const KEYS = { groq: "gsk_SECRET_GROQ_123", mistral: "MISTRAL_SECRET_456", or: "sk-or-SECRET_789", cf: "CF_SECRET_TOKEN_000", gem: "GEM_SECRET_111", tav: "tvly-SECRET_222", zai: "ZAI_SECRET_333" };
const catalog = {
  openAiCompatible: [
    { tier: "standard", name: "Groq gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1", apiKey: KEYS.groq, model: "openai/gpt-oss-120b" },
    { tier: "flash", name: "Groq gpt-oss-20b", baseUrl: "https://api.groq.com/openai/v1", apiKey: KEYS.groq, model: "openai/gpt-oss-20b" },
    { tier: "standard", name: "Ministral 14B", baseUrl: "https://api.mistral.ai/v1", apiKey: KEYS.mistral, model: "ministral-14b-2512" },
    { tier: "standard", name: "Mistral Small", baseUrl: "https://api.mistral.ai/v1", apiKey: KEYS.mistral, model: "mistral-small-2603" },
    { tier: "max", name: "Mistral Max", baseUrl: "https://api.mistral.ai/v1", apiKey: KEYS.mistral, model: "mistral-medium-3-5" },
    { tier: "standard", name: "OpenRouter Gemma", baseUrl: "https://openrouter.ai/api/v1", apiKey: KEYS.or, model: "google/gemma-4-31b-it:free" },
    { tier: "standard", name: "Cloudflare gpt-oss", baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACC/ai/v1", apiKey: KEYS.cf, model: "@cf/openai/gpt-oss-120b" },
    { tier: "flash", name: "Cloudflare llama", baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACC/ai/v1", apiKey: KEYS.cf, model: "@cf/meta/llama-3.1-8b-instruct-fast" },
    { tier: "vision", name: "Z.ai vision", baseUrl: "https://api.z.ai/api/paas/v4", apiKey: KEYS.zai, model: "glm-4.6v-flash" },
    { tier: "standard", name: "Unconfigured", baseUrl: "", apiKey: "", model: "x" },
  ],
  gemini: { apiKey: KEYS.gem, primary: "gemini-3.6-flash", fallback: "gemini-3.5-flash-lite", extra: ["gemini-3.8-flash"] },
};
const env = { CLOUDFLARE_ACCOUNT_ID: "ACC", CLOUDFLARE_API_TOKEN: KEYS.cf, TAVILY_API_KEY: KEYS.tav };

const J = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
function makeFetch(over = {}) {
  const calls = [];
  const f = async (url, o = {}) => {
    calls.push({ url, method: o.method || "GET", body: o.body ? JSON.parse(o.body) : null, headers: o.headers });
    for (const [needle, fn] of Object.entries(over)) if (url.includes(needle)) { const r = await fn(url, o); if (r) return r; }
    // ---- defaults ----
    if (url.includes("api.groq.com") && url.endsWith("/models")) return J({ data: [
      { id: "openai/gpt-oss-120b", active: true, context_window: 131072, max_completion_tokens: 65536 },
      { id: "openai/gpt-oss-20b", active: true, context_window: 131072 },
      { id: "llama-3.3-70b-versatile", active: true, context_window: 131072 },
      { id: "whisper-large-v3-turbo", active: true },
    ] });
    if (url.includes("api.groq.com") && url.endsWith("/chat/completions")) return J({ choices: [{ message: { content: "Hi" } }] }, 200, { "x-ratelimit-limit-requests": "1000", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-requests": "999", "x-ratelimit-remaining-tokens": "7995", "x-ratelimit-reset-requests": "1m" });
    if (url.includes("api.mistral.ai") && url.endsWith("/models")) return J({ data: [
      { id: "ministral-14b-2512", aliases: ["ministral-14b-latest"], billing_model_name: "ministral-14b-2512", capabilities: { completion_chat: true, vision: true }, max_context_length: 262144 },
      { id: "ministral-14b-latest", aliases: ["ministral-14b-2512"], billing_model_name: "ministral-14b-2512", capabilities: { completion_chat: true, vision: true }, max_context_length: 262144 },
      { id: "mistral-medium-latest", aliases: ["mistral-medium-3-5", "mistral-medium"], billing_model_name: "mistral-medium-3-5", capabilities: { completion_chat: true, reasoning: true, vision: true }, max_context_length: 262144 },
      { id: "mistral-medium-3-5", aliases: ["mistral-medium-latest"], billing_model_name: "mistral-medium-3-5", capabilities: { completion_chat: true, reasoning: true }, max_context_length: 262144 },
      { id: "mistral-small-2603", aliases: [], billing_model_name: "mistral-small-2603", capabilities: { completion_chat: true, reasoning: true }, max_context_length: 262144 },
      { id: "mistral-embed", aliases: [], billing_model_name: "mistral-embed", capabilities: { completion_chat: false } },
      { id: "labs-leanstral-1-5-1", aliases: [], billing_model_name: "labs-leanstral-1-5", capabilities: { completion_chat: true } },
    ] });
    if (url.includes("api.mistral.ai") && url.endsWith("/chat/completions")) {
      const m = JSON.parse(o.body).model;
      if (m === "ministral-14b-2512") return J({ choices: [] }, 200, { "x-ratelimit-limit-req-minute": "30" });
      if (m === "labs-leanstral-1-5-1") return J({ message: "not in tier" }, 403);
      return J({ object: "error", message: "Rate limit exceeded" }, 429, { "x-ratelimit-limit-req-minute": "0" });
    }
    if (url.includes("openrouter.ai/api/v1/key")) return J({ data: { label: "my-key", usage: 0.12, limit: null, is_free_tier: true } });
    if (url.includes("openrouter.ai/api/v1/models")) return J({ data: [{ id: "google/gemma-4-31b-it:free", context_length: 131072 }, { id: "meta/llama:free", context_length: 8000 }, { id: "paid/model", context_length: 1000 }] });
    if (url.includes("/ai/models/search")) return J({ result: [{ name: "@cf/openai/gpt-oss-120b", task: { name: "Text Generation" } }, { name: "@cf/black-forest-labs/flux-1-schnell", task: { name: "Text-to-Image" } }] });
    if (url.includes("generativelanguage.googleapis.com") && url.includes("/models?")) return J({ models: [
      { name: "models/gemini-3.6-flash", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash-lite", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.7-flash", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
    ] });
    if (url.includes("generateContent")) return J({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] });
    if (url.includes("api.tavily.com/usage")) return J({ key: { usage: 150, limit: 1000 }, account: { current_plan: "Researcher", plan_usage: 150, plan_limit: 1000 } });
    if (url.includes("api.z.ai") && url.endsWith("/chat/completions")) return J({ choices: [] }, 200);
    return J({ error: "unexpected " + url }, 404);
  };
  f.calls = calls;
  return f;
}
const run = async (over = {}, opts = {}) => { const f = makeFetch(over); const sections = await runProviderLimits({ env, catalog, fetchImpl: f, ...opts }); return { sections, text: formatProviderLimits(sections), calls: f.calls }; };
const sec = (r, title) => r.sections.find((s) => s.title.includes(title));

// ===== default run =====
let r = await run();
check("one section per configured provider (the unconfigured row is skipped)", r.sections.map((s) => s.title).join("|") === "Groq|Mistral|OpenRouter|Cloudflare Workers AI|Google Gemini|Z.ai|Tavily (web search)", r.sections.map((s) => s.title).join("|"));
check("no key ever appears in the output", !Object.values(KEYS).some((k) => r.text.includes(k)));

// Groq
let g = sec(r, "Groq");
check("Groq: every active model is listed, bot models first and starred", g.models[0].bot && g.models[1].bot && g.models.length === 4);
check("Groq: limits come from the headers with plain names (requests/day, tokens/min)", /requests\/day: 1000/.test(r.text) && /tokens\/min: 8000/.test(r.text));
check("Groq: reset timers are not printed", !/reset/.test(g.models.map((m) => m.limits || "").join()));
check("Groq: only the bot's models are asked by default (2 requests), not the others or whisper", r.calls.filter((c) => c.url.includes("groq") && c.method === "POST").length === 2);
let ra = await run({}, { all: true });
check("Groq --all: every chat model is asked, whisper is not", ra.calls.filter((c) => c.url.includes("groq") && c.method === "POST").map((c) => c.body.model).sort().join() === "llama-3.3-70b-versatile,openai/gpt-oss-120b,openai/gpt-oss-20b");

// Mistral
let m = sec(r, "Mistral");
const mid = (id) => m.models.find((x) => x.id === id);
check("Mistral: embedding models are skipped and aliases of one model are shown once", !m.models.some((x) => x.id === "mistral-embed") && m.models.filter((x) => x.id.startsWith("ministral-14b")).length === 1 && m.models.filter((x) => /medium/.test(x.id)).length === 1);
check("Mistral: a model the bot uses via an alias is still starred", mid("mistral-medium-latest")?.bot === true);
check("Mistral: working model shows its allowance", mid("ministral-14b-2512")?.state === "ok" && /requests\/min: 30/.test(mid("ministral-14b-2512").limits));
check("Mistral: a 0 allowance is BLOCKED", mid("mistral-medium-latest")?.state === "blocked" && /0 requests a minute/.test(mid("mistral-medium-latest").text) && /requests\/min: 0/.test(mid("mistral-medium-latest").limits));
check("Mistral: a 403 is 'not available on your plan'", mid("labs-leanstral-1-5-1")?.state === "blocked" && /403/.test(mid("labs-leanstral-1-5-1").text));

// OpenRouter
let o = sec(r, "OpenRouter");
check("OpenRouter: shows key info and lists only the free models", /free tier: yes/.test(o.notes[0]) && /used: \$0.12/.test(o.notes[0]) && o.models.length === 2 && o.models[0].bot);
check("OpenRouter: is never probed (keeps the 50 free requests a day)", !r.calls.some((c) => c.url.includes("openrouter") && c.method === "POST"));

// Cloudflare
let c = sec(r, "Cloudflare");
check("Cloudflare: the bot's models in the catalog are 'in the catalog', missing ones are flagged", c.models.find((x) => x.id === "@cf/openai/gpt-oss-120b")?.state === "info" && c.models.find((x) => x.id === "@cf/meta/llama-3.1-8b-instruct-fast")?.state === "gone");
check("Cloudflare: says it sends no limit headers and gives the neuron note", c.notes.some((n) => /no limit headers/.test(n)) && c.notes.some((n) => /neurons/.test(n)));

// Gemini
let ge = sec(r, "Gemini");
check("Gemini: bot models marked available / missing from the key's list", ge.models.find((x) => x.id === "gemini-3.6-flash")?.state === "info" && ge.models.find((x) => x.id === "gemini-3.8-flash")?.state === "gone" && /input 1048576/.test(ge.models[0].info));
check("Gemini: by default nothing is generated (protects the small daily allowance)", !r.calls.some((x) => x.url.includes("generateContent")));
check("Gemini: key goes in a header, not the URL", r.calls.filter((x) => x.url.includes("generativelanguage")).every((x) => !x.url.includes(KEYS.gem) && x.headers["x-goog-api-key"] === KEYS.gem));
check("Gemini: says Google sends no limit headers and points to AI Studio", ge.notes.some((n) => /AI Studio/.test(n)));
let rg = await run({ "generateContent": () => J({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" }] } }, 429) }, { probeGemini: true });
const gp = sec(rg, "Gemini").models.find((x) => x.id === "gemini-3.5-flash-lite");
check("Gemini --probe-gemini: a 429 prints WHICH quota was hit and when to retry", /GenerateRequestsPerDayPerProjectPerModel-FreeTier/.test(gp.text) && /retry in 34s/.test(gp.text), gp.text);
check("Gemini --probe-gemini: exactly one request, to the lite model", rg.calls.filter((x) => x.url.includes("generateContent")).length === 1 && rg.calls.find((x) => x.url.includes("generateContent")).url.includes("gemini-3.5-flash-lite"));

// Tavily / Z.ai
let t = sec(r, "Tavily");
check("Tavily: shows credits used of the limit and the plan", /150 of 1000 credits/.test(t.notes[0]) && /Researcher/.test(t.notes[1]));
check("Z.ai: is asked once and the output says it documents no limit headers", sec(r, "Z.ai").models[0].state === "ok" && sec(r, "Z.ai").notes.some((n) => /no limit headers/.test(n)));

// failure isolation
let rf = await run({ "api.groq.com": () => J({ error: { message: "Invalid API Key" } }, 401) });
check("a failing provider shows an error line and the others still run", /Groq ==\n  ❌ couldn't list models — key rejected \(401\)/.test(rf.text) && sec(rf, "Mistral").models.length > 0);
let rn = await run({ "api.tavily.com": () => { throw new Error("boom network"); } });
check("a network failure is reported, not thrown", sec(rn, "Tavily").error && /usage lookup failed/.test(sec(rn, "Tavily").error));
const empty = await runProviderLimits({ env: {}, catalog: { openAiCompatible: [], gemini: { apiKey: "" } }, fetchImpl: makeFetch() });
check("nothing configured -> nothing asked, no crash", empty.length === 0 && formatProviderLimits(empty).startsWith("What each key can use"));
check("the printed report has the legend and uses stars", /★ = a model the bot uses/.test(r.text) && /★ ✅ ministral-14b-2512/.test(r.text));

// ===== providers run at the same time (the report has to fit inside a Telegram webhook) =====
{
  const slow = makeFetch();
  const delayed = async (url, o) => { await new Promise((r) => setTimeout(r, 80)); return slow(url, o); };
  const t0 = Date.now();
  const secs = await runProviderLimits({ env, catalog, fetchImpl: delayed });
  const took = Date.now() - t0;
  const requests = slow.calls.length;
  check("providers run in parallel: total time is far less than requests x delay", took < requests * 80 * 0.6, `${took}ms for ${requests} requests`);
  check("…and the sections still come out in the same order", secs.map((x) => x.title).join("|") === "Groq|Mistral|OpenRouter|Cloudflare Workers AI|Google Gemini|Z.ai|Tavily (web search)");
  // inside one provider the probes stay one at a time (Mistral)
  let inFlight = 0, maxInFlight = 0;
  const base = makeFetch();
  const counting = async (url, o) => { const isMistralChat = url.includes("api.mistral.ai") && url.endsWith("/chat/completions"); if (isMistralChat) { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); } await new Promise((r) => setTimeout(r, 20)); const res = await base(url, o); if (isMistralChat) inFlight--; return res; };
  await runProviderLimits({ env, catalog, fetchImpl: counting });
  check("Mistral's probes still go one after another", maxInFlight === 1, `max at once: ${maxInFlight}`);
}

// ===== the owner-only /limits command in the webhook =====
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../api/telegram-webhook.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => /const limitsMatch =/.test(l)) || "";
  check("/limits exists and is gated by isOwner BEFORE the text is even matched", /const limitsMatch = isOwner\(chatId\) && text\?\.match\(/.test(line), line.trim());
  check("/limits accepts only: (nothing), all, gemini", /\(all\|gemini\)/.test(line));
  const block = src.slice(src.indexOf("const limitsMatch"), src.indexOf('if (text === "/users"'));
  check("the /limits handler sends the formatted report (no env dump)", /formatProviderLimits\(sections\)/.test(block) && !/JSON\.stringify\(process\.env|console\.log\(process\.env/.test(block));
  check("the /limits handler passes process.env only into the module that never prints it", /runProviderLimits\(\{ env: process\.env/.test(block));
  check("/limits is documented in the command list", /\/limits \[all\|gemini\]/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
