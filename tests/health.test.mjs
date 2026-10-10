// Run from the project folder:  node --no-deprecation tests/health.test.mjs
// Tests lib/health.js against a fake network (no real keys, no real requests).

// Fake keys, set BEFORE the app's modules are imported (they read env at import time).
const KEYS = {
  DATABASE_URL: "postgres://user:pw@localhost.invalid/db",
  TELEGRAM_BOT_TOKEN: "123456:FAKE_TELEGRAM_TOKEN_abcdef",
  TELEGRAM_WEBHOOK_SECRET: "fake-webhook-secret-xyz",
  OWNER_CHAT_ID: "424242",
  MINI_APP_URL: "https://demo.vercel.app/miniapp/index.html",
  GROQ_API_KEY: "gsk_FAKE_GROQ_KEY_000111",
  GEMINI_API_KEY: "AIzaFAKE_GEMINI_KEY_000111",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_FAKE_000111",
  CEREBRAS_API_KEY: "csk_FAKE_CEREBRAS_000111",
  OPENROUTER_API_KEY: "sk-or-FAKE_OPENROUTER_000111",
  MISTRAL_API_KEY: "FAKE_MISTRAL_KEY_000111",
  MODELSCOPE_API_KEY: "ms-FAKE_MODELSCOPE_000111",
  ZAI_API_KEY: "FAKE_ZAI_KEY_000111.abc",
  CLOUDFLARE_ACCOUNT_ID: "acct0123456789",
  CLOUDFLARE_API_TOKEN: "FAKE_CLOUDFLARE_TOKEN_000111",
  TELEGRAM_BOT_USERNAME: "chat_assistai_bot",
  VERCEL_ENV: "production",
};
Object.assign(process.env, KEYS);

const { runHealthCheck, formatReport, splitReport, summarize, makeRedactor } = await import("../lib/health.js");
const { providerCatalog } = await import("../lib/ai.js");
const catalog = providerCatalog();

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };
const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// ---- a fake internet where everything works; tests override single routes
const hostIds = (host) => catalog.openAiCompatible.filter((r) => new URL(r.baseUrl || "https://none.invalid").hostname === host).map((r) => r.model);
const cfNames = catalog.openAiCompatible.filter((r) => r.baseUrl.includes("cloudflare")).map((r) => r.model).concat("@cf/black-forest-labs/flux-1-schnell");
let calls;
function makeFetch(overrides = {}) {
  calls = [];
  return async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || "GET";
    calls.push({ url, method, headers: opts.headers || {} });
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) { const r = await handler(url, opts); if (r) return r; }
    }
    if (url.includes("api.telegram.org") && url.endsWith("/getMe")) return J({ ok: true, result: { username: "chat_assistai_bot" } });
    if (url.includes("api.telegram.org") && url.endsWith("/getWebhookInfo")) return J({ ok: true, result: { url: "https://demo.vercel.app/api/telegram-webhook", pending_update_count: 0 } });
    if (url.includes("generativelanguage.googleapis.com")) return method === "POST" ? J({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }) : J({ name: "models/x" });
    if (url.includes("openrouter.ai/api/v1/auth/key")) return J({ data: { is_free_tier: true } });
    if (url.includes("openrouter.ai/api/v1/models")) return J({ data: hostIds("openrouter.ai").map((id) => ({ id })) });
    if (url.includes("api.cloudflare.com") && url.includes("/user/tokens/verify")) return J({ success: true, result: { status: "active" } });
    if (url.includes("api.cloudflare.com") && url.includes("/tokens/verify")) return J({ success: false }, 403);
    if (url.includes("api.cloudflare.com") && url.includes("/ai/models/search")) return J({ result: cfNames.map((name) => ({ name })) });
    if (url.endsWith("/chat/completions")) return J({ choices: [{ message: { content: "OK" } }] });
    if (url.endsWith("/models")) { const host = new URL(url).hostname; const ids = hostIds(host); if (host === "api.groq.com") ids.push("whisper-large-v3-turbo"); return J({ data: ids.map((id) => ({ id })) }); }
    return J({ error: "unexpected url in test: " + url }, 500);
  };
}
const realFetch = globalThis.fetch;
const deps = { catalog, dbTables: async () => ["a", "b"], expectedTables: async () => ["a", "b"], blobList: async () => {} };
// The provider list is built from the keys present at import time, so a "key removed" scenario
// must remove it from the list too (in production env and list always agree).
const withoutKeys = (re) => ({ catalog: { ...catalog, openAiCompatible: catalog.openAiCompatible.map((r) => (re.test(r.name) ? { ...r, apiKey: undefined } : r)) } });
const run = async (opts = {}, extraDeps = {}, env = { ...process.env }) => runHealthCheck({ live: false, env, deps: { ...deps, ...extraDeps }, ...opts });
const find = (res, group, nameIncludes) => res.find((r) => r.group === group && r.name.includes(nameIncludes));
const dump = (res) => JSON.stringify(res);

// ===== 1. everything works =====
globalThis.fetch = makeFetch();
let res = await run();
let c = summarize(res);
check("all good: no problems", c.fail === 0, JSON.stringify(c));
check("all good: Groq key + every model line ok", find(res, "Groq", "openai/gpt-oss-120b")?.status === "ok" && find(res, "Groq", "llama-3.1-8b-instant")?.status === "ok" && find(res, "Groq", "whisper")?.status === "ok");
check("all good: all 6 Gemini ids checked", res.filter((r) => r.group === "Gemini").length === 6);
check("all good: Cloudflare token + image model", find(res, "Cloudflare Workers AI", "API token")?.status === "ok" && find(res, "Cloudflare Workers AI", "flux-1-schnell")?.status === "ok");
check("all good: telegram + webhook + db + blob", find(res, "Telegram", "Bot token")?.status === "ok" && find(res, "Telegram", "Webhook")?.status === "ok" && find(res, "Database", "Neon")?.status === "ok" && find(res, "Storage", "Blob")?.status === "ok");
check("quick mode makes NO generation calls", !calls.some((x) => x.method === "POST"), `${calls.filter((x) => x.method === "POST").length} POSTs`);
check("quick mode: Gemini key sent in a header, not the URL", calls.filter((x) => x.url.includes("generativelanguage")).every((x) => !x.url.includes("key=") && x.headers["x-goog-api-key"]));

// ===== 2. no secret ever appears in the output =====
const text = formatReport(res);
const leaks = Object.entries(KEYS).filter(([k, v]) => /KEY|TOKEN|SECRET|DATABASE/.test(k) && text.includes(v));
check("report contains no secret values", leaks.length === 0, leaks.map(([k]) => k).join());
check("report summary + tailored hint", /Everything checked is connected/.test(text) && /\/health live/.test(text));

// ===== 3. a rejected key =====
globalThis.fetch = makeFetch({ "api.groq.com/openai/v1/models": () => J({ error: { message: "Invalid API Key gsk_FAKE_GROQ_KEY_000111" } }, 401) });
res = await run();
check("bad Groq key -> fail", find(res, "Groq", "API key")?.status === "fail" && /rejected/.test(find(res, "Groq", "API key").detail));
check("bad Groq key -> models not blamed", find(res, "Groq", "openai/gpt-oss-120b")?.status === "skip");
check("provider message echoing a key is scrubbed", !dump(res).includes("gsk_FAKE_GROQ_KEY_000111"));

// ===== 4. retired / mistyped model =====
globalThis.fetch = makeFetch({
  "api.mistral.ai/v1/models": () => J({ data: [{ id: "mistral-small-2603" }, { id: "ministral-8b-2512" }, { id: "mistral-large-2512" }] }),
});
res = await run();
const gone = find(res, "Mistral", "ministral-14b-2512");
check("model missing from list -> fail naming the model", gone?.status === "fail" && /retired or mistyped/.test(gone.detail), gone?.detail);
check("other Mistral models still ok", find(res, "Mistral", "mistral-small-2603")?.status === "ok");

// ===== 5. Gemini ids =====
globalThis.fetch = makeFetch({
  "models/gemini-3.6-flash": (u, o) => (o.method || "GET") === "GET" ? J({ error: { message: "not found" } }, 404) : null,
  "models/gemini-3.8-flash": (u, o) => (o.method || "GET") === "GET" ? J({ error: { message: "not found" } }, 404) : null,
});
res = await run();
check("main Gemini id missing -> fail", find(res, "Gemini", "gemini-3.6-flash")?.status === "fail");
check("Extra-tier Gemini id missing -> warn only", find(res, "Gemini", "gemini-3.8-flash")?.status === "warn");
globalThis.fetch = makeFetch({ "generativelanguage.googleapis.com": () => J({ error: { message: "API key not valid. Please pass a valid API key." } }, 400) });
res = await run();
check("invalid Gemini key (HTTP 400) -> fail", res.filter((r) => r.group === "Gemini").every((r) => r.status === "fail" && /not valid/.test(r.detail)));
globalThis.fetch = makeFetch({ "generativelanguage.googleapis.com": () => J({ error: { message: "quota" } }, 429) });
res = await run();
check("Gemini 429 -> warn, not fail (key works)", res.filter((r) => r.group === "Gemini").every((r) => r.status === "warn"));

// ===== 6. Telegram =====
globalThis.fetch = makeFetch({ "getWebhookInfo": () => J({ ok: true, result: { url: "", pending_update_count: 0 } }) });
res = await run();
check("empty webhook -> fail with the fix", find(res, "Telegram", "Webhook")?.status === "fail" && /setWebhook/.test(find(res, "Telegram", "Webhook").detail));
globalThis.fetch = makeFetch({ "getWebhookInfo": () => J({ ok: true, result: { url: "https://demo.vercel.app/api/telegram-webhook", pending_update_count: 57, last_error_date: Math.floor(Date.now() / 1000) - 60, last_error_message: "Wrong response from the webhook: 401 Unauthorized" } }) });
res = await run();
const w = find(res, "Telegram", "Webhook");
check("recent delivery error + backlog -> warn showing both", w?.status === "warn" && /401 Unauthorized/.test(w.detail) && /57 updates/.test(w.detail), w?.detail);
globalThis.fetch = makeFetch({ "getMe": () => J({ ok: false, description: "Unauthorized" }, 401) });
res = await run();
check("bad bot token -> fail", find(res, "Telegram", "Bot token")?.status === "fail");
globalThis.fetch = makeFetch({ "getMe": () => J({ ok: true, result: { username: "some_other_bot" } }) });
res = await run();
check("username mismatch -> warn", find(res, "Telegram", "Bot token")?.status === "warn");

// ===== 7. database / migrations =====
globalThis.fetch = makeFetch();
res = await run({}, { dbTables: async () => ["a"], expectedTables: async () => ["a", "plan_trials"] });
const d = find(res, "Database", "Neon");
check("missing table -> fail naming the migration file", d?.status === "fail" && /plan_trials → run db\/migrate_plan_trials_v15\.sql/.test(d.detail), d?.detail);
res = await run({}, { dbTables: async () => { throw new Error("password authentication failed for user postgres://user:pw@localhost.invalid/db"); } });
check("database down -> fail, connection string scrubbed", find(res, "Database", "Neon")?.status === "fail" && !dump(res).includes("postgres://user:pw"));
res = await run({}, { blobList: async () => { throw new Error("Vercel Blob: Access denied"); } });
check("bad Blob token -> fail", find(res, "Storage", "Blob")?.status === "fail");

// ===== 8. settings =====
const bare = { ...process.env }; delete bare.GROQ_API_KEY; delete bare.TELEGRAM_WEBHOOK_SECRET; delete bare.CLOUDFLARE_API_TOKEN; bare.OWNER_CHAT_ID = "@nahom"; delete bare.VERCEL_ENV;
globalThis.fetch = makeFetch();
res = await run({}, withoutKeys(/^(Groq|Cloudflare)/), bare);
check("missing required vars -> fail each", find(res, "Settings", "GROQ_API_KEY")?.status === "fail" && find(res, "Settings", "TELEGRAM_WEBHOOK_SECRET")?.status === "fail");
check("non-numeric OWNER_CHAT_ID flagged", res.some((r) => r.group === "Settings" && r.name === "OWNER_CHAT_ID" && r.status === "fail" && /number/.test(r.detail)));
check("half a Cloudflare pair -> warn", res.some((r) => r.name === "Cloudflare keys" && r.status === "warn"));
check("Groq with no key -> fail (required), not 'optional'", find(res, "Groq", "Groq")?.status === "fail");
check("Cloudflare half-set is skipped, not crashed", find(res, "Cloudflare Workers AI", "Cloudflare")?.status === "skip");
check("missing VERCEL_ENV is explained, not an error", res.some((r) => r.name === "Environment" && r.status === "skip" && /harmless/.test(r.detail)));
check("tunables listed as using defaults", res.some((r) => r.name === "Using built-in defaults" && /FILE_SITE_DAILY_CAP/.test(r.detail) && /CF_IMAGE_STEPS/.test(r.detail)));
const noOpt = { ...process.env }; for (const k of ["CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "MODELSCOPE_API_KEY", "ZAI_API_KEY"]) delete noOpt[k];
res = await run({}, withoutKeys(/^(Cerebras|OpenRouter|Ministral|Mistral|ModelScope|Z\.ai)/), noOpt);
check("unconfigured optional providers -> skip, no failures from them", find(res, "Mistral", "Mistral")?.status === "skip" && find(res, "Cerebras", "Cerebras")?.status === "skip" && summarize(res).fail === 0);

// ===== 9. timeouts / network =====
globalThis.fetch = makeFetch({ "api.cerebras.ai": async () => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); } });
res = await run();
check("timeout -> fail with a plain reason", find(res, "Cerebras", "API key")?.status === "fail" && /no answer within/.test(find(res, "Cerebras", "API key").detail));
globalThis.fetch = makeFetch({ "api.mistral.ai": () => J({ error: "boom" }, 503) });
res = await run();
check("provider 5xx -> warn (their problem, not your key)", find(res, "Mistral", "API key")?.status === "warn");

// ===== 10. Cloudflare =====
globalThis.fetch = makeFetch({ "/tokens/verify": () => J({ success: false, errors: [{ message: "Invalid API Token" }] }, 401) });
res = await run();
check("bad Cloudflare token -> fail, models skipped", find(res, "Cloudflare Workers AI", "API token")?.status === "fail" && !res.some((r) => r.group === "Cloudflare Workers AI" && r.name.startsWith("@cf")));
globalThis.fetch = makeFetch({ "/ai/models/search": () => J({ result: [{ name: "@cf/some/other-model" }] }) });
res = await run();
check("retired Cloudflare model -> fail", find(res, "Cloudflare Workers AI", "flux-1-schnell")?.status === "fail" && /not in Cloudflare's catalog/.test(find(res, "Cloudflare Workers AI", "flux-1-schnell").detail));

// ===== 11. live mode =====
globalThis.fetch = makeFetch();
res = await run({ live: true });
const posts = calls.filter((x) => x.method === "POST");
check("live: Groq's two chat models answer", res.filter((r) => r.group === "Groq" && r.name.endsWith("— live") && r.status === "ok").length === 2);
check("live: Gemini live test uses ONLY the roomy lite model", posts.filter((p) => p.url.includes("generateContent")).length === 1 && posts.find((p) => p.url.includes("generateContent")).url.includes("gemini-3.5-flash-lite"), posts.filter((p) => p.url.includes("generateContent")).map((p) => p.url.split("/models/")[1]).join());
check("live: never calls the 20/day primary Gemini model", !posts.some((p) => p.url.includes("gemini-3.6-flash")));
check("live: Mistral tests only the cheapest model", posts.filter((p) => p.url.includes("api.mistral.ai")).length === 1);
check("live: OpenRouter spends exactly 1 of its 50/day", posts.filter((p) => p.url.includes("openrouter.ai")).length === 1);
check("live: Cloudflare text + flash + vision answer", res.filter((r) => r.group === "Cloudflare Workers AI" && r.name.endsWith("— live") && r.status === "ok").length === 3);
check("live: no image is generated (no CF /ai/run call)", !posts.some((p) => /\/ai\/run\//.test(p.url)));
check("live report says so", /each model was asked/.test(formatReport(res, { live: true })));
globalThis.fetch = makeFetch({ "api.groq.com/openai/v1/chat/completions": () => J({ error: { message: "rate limit reached" } }, 429) });
res = await run({ live: true });
check("live 429 -> warn", res.some((r) => r.group === "Groq" && r.name.endsWith("— live") && r.status === "warn" && /rate-limited/.test(r.detail)));

// ===== 12. SearXNG / Tavily =====
const withSearch = { ...process.env, SEARXNG_URL: "https://s.example.org/", TAVILY_API_KEY: "tvly-FAKE_000111222" };
globalThis.fetch = makeFetch({ "s.example.org": () => J({ results: [{ title: "t" }] }), "api.tavily.com/usage": () => J({ ok: 1 }) });
res = await run({}, {}, withSearch);
check("SearXNG + Tavily ok", find(res, "Search", "SearXNG")?.status === "ok" && find(res, "Search", "Tavily")?.status === "ok");
globalThis.fetch = makeFetch({ "s.example.org": () => new Response("forbidden", { status: 403 }) });
res = await run({}, {}, withSearch);
check("SearXNG JSON disabled -> helpful warn", find(res, "Search", "SearXNG")?.status === "warn" && /json/i.test(find(res, "Search", "SearXNG").detail));
globalThis.fetch = makeFetch();
res = await run();
check("no search configured -> explains the fallback", find(res, "Search", "Web search")?.status === "skip" && /Gemini/.test(find(res, "Search", "Web search").detail));

// ===== 13. a check that crashes can't take the report down =====
res = await run({}, { dbTables: () => { throw new TypeError("kaboom"); } });
check("one crashing check is contained", find(res, "Database", "Neon")?.status === "fail" && find(res, "Gemini", "gemini-3.6-flash"));

// ===== 14. formatting =====
globalThis.fetch = makeFetch();
const big = formatReport(await run({ live: true }), { live: true });
const parts = splitReport(big, 1500);
check("splitReport: every part under the limit", parts.every((p) => p.length <= 1500), parts.map((p) => p.length).join());
check("splitReport: nothing lost", parts.join("\n\n") === big);
check("full live report fits in a few Telegram messages", splitReport(big).length <= 3, `${big.length} chars -> ${splitReport(big).length} message(s)`);
check("redactor ignores short/non-secret values", makeRedactor({ BOT_NAME: "Assist AI", X_KEY: "short" })("Assist AI short") === "Assist AI short");

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
