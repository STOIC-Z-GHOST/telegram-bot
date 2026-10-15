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
const maxModel = catalog.openAiCompatible.find((r) => r.tier === "max").model; // Mistral Medium 3.5 by default (Large 403s on a free key)
// A copy of the provider list with a different Max model (to replay what happened when Large was configured).
const withMaxModel = (id) => ({ catalog: { ...catalog, openAiCompatible: catalog.openAiCompatible.map((r) => (r.tier === "max" ? { ...r, model: id } : r)) } });

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };
const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// ---- a fake internet where everything works; tests override single routes
const hostIds = (host) => catalog.openAiCompatible.filter((r) => new URL(r.baseUrl || "https://none.invalid").hostname === host).map((r) => r.model);
const cfNames = catalog.openAiCompatible.filter((r) => r.baseUrl.includes("cloudflare")).map((r) => r.model).concat("@cf/black-forest-labs/flux-1-schnell");
const PUBLIC_LIST_HOSTS = new Set(["api-inference.modelscope.cn", "api.z.ai"]); // their model lists need no key
let calls;
function makeFetch(overrides = {}) {
  calls = [];
  return async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || "GET";
    calls.push({ url, method, headers: opts.headers || {}, body: opts.body });
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) { const r = await handler(url, opts); if (r) return r; }
    }
    if (url.includes("api.telegram.org") && url.endsWith("/getMe")) return J({ ok: true, result: { username: "chat_assistai_bot" } });
    if (url.includes("api.telegram.org") && url.endsWith("/getWebhookInfo")) return J({ ok: true, result: { url: "https://demo.vercel.app/api/telegram-webhook", pending_update_count: 0 } });
    if (url.includes("generativelanguage.googleapis.com")) return method === "POST" ? J({ candidates: [{ content: { parts: [{ text: /inline_data/.test(opts.body || "") ? "Red" : "OK" }] } }] }) : J({ name: "models/x" });
    if (url.includes("openrouter.ai/api/v1/auth/key")) return J({ data: { is_free_tier: true } });
    if (url.includes("openrouter.ai/api/v1/models")) return J({ data: hostIds("openrouter.ai").map((id) => ({ id })) });
    if (url.includes("api.cloudflare.com") && url.includes("/user/tokens/verify")) return J({ success: true, result: { status: "active" } });
    if (url.includes("api.cloudflare.com") && url.includes("/tokens/verify")) return J({ success: false }, 403);
    if (url.includes("api.cloudflare.com") && url.includes("/ai/models/search")) return J({ result: cfNames.map((name) => ({ name })) });
    if (url.endsWith("/chat/completions")) return J({ choices: [{ message: { content: /image_url/.test(opts.body || "") ? "Red." : "OK" } }] });
    {
      const u = new URL(url);
      const idsFor = (host) => { const ids = hostIds(host); if (host === "api.groq.com") ids.push("whisper-large-v3-turbo"); return ids; };
      if (/\/models$/.test(u.pathname)) {
        const authed = !!(opts.headers && opts.headers.Authorization);
        if (!authed && !PUBLIC_LIST_HOSTS.has(u.hostname)) return J({ error: { message: "Missing API key" } }, 401);
        return J({ data: idsFor(u.hostname).map((id) => ({ id })) });
      }
      if (/\/models\/.+/.test(u.pathname) && method === "GET") {
        const id = decodeURIComponent(u.pathname.split("/models/")[1]);
        return idsFor(u.hostname).includes(id) ? J({ id }) : J({ error: { message: `The model \`${id}\` does not exist` } }, 404);
      }
    }
    return J({ error: "unexpected url in test: " + url }, 500);
  };
}
const realFetch = globalThis.fetch;
const budgets = (m = 1_200_000, mx = 400_000, cf = 2_000) => async () => ({ mistral: { spent: m, cap: 8_500_000 }, mistral_max: { spent: mx, cap: 5_000_000 }, cloudflare: { spent: cf, cap: 9_000 } });
const deps = { catalog, dbTables: async () => ["a", "b"], expectedTables: async () => ["a", "b"], blobList: async () => {}, budgetStatus: budgets() };
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
check("all good: Groq key + every model line ok", find(res, "Groq", "openai/gpt-oss-120b")?.status === "ok" && find(res, "Groq", "openai/gpt-oss-20b")?.status === "ok" && find(res, "Groq", "whisper")?.status === "ok");
check("fast mode now uses Groq's gpt-oss-20b (llama-3.1-8b-instant was shut down)", !res.some((r) => r.name === "llama-3.1-8b-instant") && !!find(res, "Groq", "openai/gpt-oss-20b"));
check("OpenRouter now checks free models that exist", find(res, "OpenRouter", "gemma-4-31b-it:free")?.status === "ok" && find(res, "OpenRouter", "gemma-4-26b-a4b-it:free")?.status === "ok");
check("public-list providers are NOT reported as key-verified in quick mode", find(res, "ModelScope", "API key")?.status === "warn" && /public/.test(find(res, "ModelScope", "API key").detail) && find(res, "Z.ai", "API key")?.status === "warn");
check("authenticated-list providers ARE key-verified", find(res, "Groq", "API key")?.status === "ok" && find(res, "Mistral", "API key")?.status === "ok");
check("all good: all 6 Gemini ids checked", res.filter((r) => r.group === "Gemini").length === 6);
check("all good: Cloudflare token + image model", find(res, "Cloudflare Workers AI", "API token")?.status === "ok" && find(res, "Cloudflare Workers AI", "flux-1-schnell")?.status === "ok");
check("all good: telegram + webhook + db + blob", find(res, "Telegram", "Bot token")?.status === "ok" && find(res, "Telegram", "Webhook")?.status === "ok" && find(res, "Database", "Neon")?.status === "ok" && find(res, "Storage", "Blob")?.status === "ok");
check("quick mode makes NO generation calls", !calls.some((x) => x.method === "POST"), `${calls.filter((x) => x.method === "POST").length} POSTs`);
check("quick mode: Gemini key sent in a header, not the URL", calls.filter((x) => x.url.includes("generativelanguage")).every((x) => !x.url.includes("key=") && x.headers["x-goog-api-key"]));

// ===== 2. no secret ever appears in the output =====
const text = formatReport(res);
const leaks = Object.entries(KEYS).filter(([k, v]) => /KEY|TOKEN|SECRET|DATABASE/.test(k) && text.includes(v));
check("report contains no secret values", leaks.length === 0, leaks.map(([k]) => k).join());
check("report summary + tailored hint", /Working, with warnings|Everything checked is connected/.test(text) && /\/health live/.test(text));
check("CLI report names its own live command", /npm run check:live/.test(formatReport(res, { liveHint: "Run `npm run check:live`" })));

// ===== 3. a rejected key =====
globalThis.fetch = makeFetch({ "api.groq.com/openai/v1/models": () => J({ error: { message: "Invalid API Key gsk_FAKE_GROQ_KEY_000111" } }, 401) });
res = await run();
check("bad Groq key -> fail", find(res, "Groq", "API key")?.status === "fail" && /rejected/.test(find(res, "Groq", "API key").detail));
check("bad Groq key -> models not blamed", find(res, "Groq", "openai/gpt-oss-120b")?.status === "skip");
check("provider message echoing a key is scrubbed", !dump(res).includes("gsk_FAKE_GROQ_KEY_000111"));

// ===== 4. retired / mistyped model =====
globalThis.fetch = makeFetch({
  "api.mistral.ai/v1/models/ministral-14b-2512": () => J({ error: { message: "Invalid model" } }, 404),
  "api.mistral.ai/v1/models": (u) => (u.endsWith("/models") ? J({ data: [{ id: "mistral-small-2603" }, { id: "ministral-8b-2512" }, { id: "mistral-large-2512" }] }) : null),
});
res = await run();
const gone = find(res, "Mistral", "ministral-14b-2512");
check("model missing from list AND from its own address -> fail naming the model", gone?.status === "fail" && /retired or mistyped/.test(gone.detail), gone?.detail);
check("...and suggests what IS available", /Available now, for example: .*ministral-8b-2512/.test(gone.detail), gone?.detail);
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
check("Cloudflare model absent from the catalog search -> warn (search can miss), not fail", find(res, "Cloudflare Workers AI", "flux-1-schnell")?.status === "warn" && /live test/.test(find(res, "Cloudflare Workers AI", "flux-1-schnell").detail));

// ===== 11. live mode =====
globalThis.fetch = makeFetch();
res = await run({ live: true });
const posts = calls.filter((x) => x.method === "POST");
check("live: Groq's two chat models answer (merged into their model lines)", res.filter((r) => r.group === "Groq" && /answered in/.test(r.detail) && r.status === "ok").length === 2);
check("live: no separate '— live' lines any more", !res.some((r) => r.name.endsWith("— live")));
check("live: Gemini live test uses ONLY the roomy lite model", posts.filter((p) => p.url.includes("generateContent")).length === 1 && posts.find((p) => p.url.includes("generateContent")).url.includes("gemini-3.5-flash-lite"), posts.filter((p) => p.url.includes("generateContent")).map((p) => p.url.split("/models/")[1]).join());
check("live: never calls the 20/day primary Gemini model", !posts.some((p) => p.url.includes("gemini-3.6-flash")));
check("live: Mistral gets exactly 2 requests (its free plan allows ~2/minute), not 4", posts.filter((p) => p.url.includes("api.mistral.ai")).length === 2);
check("live: those 2 are the Max model and the cheapest", (() => { const m = posts.filter((p) => p.url.includes("api.mistral.ai")).map((p) => JSON.parse(p.body).model).sort(); return m.join() === ["ministral-8b-2512", maxModel].sort().join(); })());
check("the default Max model is Medium 3.5", maxModel === "mistral-medium-3-5", maxModel);
check("live: the other Mistral models say why they weren't asked", find(res, "Mistral", "mistral-small-2603")?.status === "ok" && /not live-tested: Mistral's free plan/.test(find(res, "Mistral", "mistral-small-2603").detail), find(res, "Mistral", "mistral-small-2603")?.detail);
check("live: OpenRouter's image model says it was spared (50/day)", /not live-tested: to save/.test(find(res, "OpenRouter", "gemma-4-26b-a4b-it:free")?.detail || ""));
check("live: OpenRouter spends exactly 1 of its 50/day", posts.filter((p) => p.url.includes("openrouter.ai")).length === 1);
check("live: Cloudflare text + flash + vision answer", res.filter((r) => r.group === "Cloudflare Workers AI" && /(answered|read the test image) in/.test(r.detail) && r.status === "ok").length === 3);
check("live: no image is generated (no CF /ai/run call)", !posts.some((p) => /\/ai\/run\//.test(p.url)));
check("live report says so", /Live test: chat models were asked to reply "OK"; image models were shown a small red picture/.test(formatReport(res, { live: true })));
globalThis.fetch = makeFetch({ "api.groq.com/openai/v1/chat/completions": () => J({ error: { message: "rate limit reached" } }, 429) });
res = await run({ live: true });
check("live 429 -> warn", res.some((r) => r.group === "Groq" && r.name.startsWith("openai/gpt-oss") && r.status === "warn" && /rate-limited/.test(r.detail)));

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


// ===== 13b. regressions from the first real /health live run =====
const hostModels = (host) => catalog.openAiCompatible.filter((r) => new URL(r.baseUrl || "https://none.invalid").hostname === host).map((r) => r.model);
const groqFlash = catalog.openAiCompatible.find((r) => r.tier === "flash" && /groq/.test(r.baseUrl)).model;

// Groq retires a model: gone from the list, from its own address, and chat returns 404
globalThis.fetch = makeFetch({
  [`api.groq.com/openai/v1/models/${groqFlash}`]: () => J({ error: { message: `The model \`${groqFlash}\` does not exist or you do not have access to it.` } }, 404),
  "api.groq.com/openai/v1/models": (u) => (u.endsWith("/models") ? J({ data: [{ id: "openai/gpt-oss-120b" }, { id: "qwen/qwen3.6-27b" }, { id: "whisper-large-v3-turbo" }, { id: "meta-llama/llama-guard-4-12b" }] }) : null),
  "api.groq.com/openai/v1/chat/completions": (u, o) => (JSON.parse(o.body).model === groqFlash ? J({ error: { message: `The model \`${groqFlash}\` does not exist or you do not have access to it.` } }, 404) : null),
});
res = await run({ live: true });
const goneGroq = find(res, "Groq", groqFlash);
check("retired Groq model (live): ONE line, fail, says it doesn't exist", res.filter((r) => r.name === groqFlash).length === 1 && goneGroq?.status === "fail" && /doesn't exist/.test(goneGroq.detail), goneGroq?.detail);
check("...with a 'did you mean' that skips audio/guard models", /Available now, for example: .*qwen\/qwen3\.6-27b/.test(goneGroq.detail) && !/llama-guard/.test(goneGroq.detail) && !/whisper/.test(goneGroq.detail), goneGroq?.detail);

// Cloudflare: gone from the catalog search but it still answers -> deprecated warning, not a failure
const cf8b = catalog.openAiCompatible.find((r) => r.tier === "flash" && /cloudflare/.test(r.baseUrl)).model;
globalThis.fetch = makeFetch({ "/ai/models/search": () => J({ result: cfNames.filter((n) => n !== cf8b).map((name) => ({ name })) }) });
res = await run({ live: true });
const dep = find(res, "Cloudflare Workers AI", cf8b);
check("CF model missing from catalog but answering live -> warn 'probably deprecated'", dep?.status === "warn" && /still answers/.test(dep.detail) && /deprecated/.test(dep.detail), dep?.detail);
check("(that is the 8B model from the first real run)", /llama-3\.1-8b/.test(cf8b));

// ModelScope-style: public list, key actually rejected -> quick says "unverified", live says rejected WITH the provider's message
const msChat = (u, o) => (u.endsWith("/chat/completions") ? J({ error: { message: "Authentication failed, please make sure that a valid ModelScope token is supplied." } }, 401) : null);
globalThis.fetch = makeFetch({ "api-inference.modelscope.cn": msChat });
res = await run();
check("ModelScope quick: key NOT reported as valid", find(res, "ModelScope", "API key")?.status === "warn");
res = await run({ live: true });
const msKey = find(res, "ModelScope", "API key");
check("ModelScope live: invalid token -> key fail, with ModelScope's own (real) message", msKey?.status === "fail" && /key rejected \(HTTP 401\): Authentication failed.*valid ModelScope token/.test(msKey.detail) && !/real-name/.test(msKey.detail), msKey?.detail);
check("...and the model line carries the failure too", find(res, "ModelScope", "Qwen/")?.status === "fail");

// Z.ai-style: partial public list (model absent) but it answers -> ok, noted; quick -> warn only
globalThis.fetch = makeFetch({ "api.z.ai": (u, o) => (/\/models$/.test(u) ? J({ data: [{ id: "glm-4.5" }] }) : /\/models\/.+/.test(u) ? J({ error: { message: "not found" } }, 404) : null) });
res = await run();
const zq = res.find((r) => r.group === "Z.ai" && r.name === "glm-4.6v-flash");
check("Z.ai quick: absent from a public list -> warn (list may be incomplete)", zq?.status === "warn" && /incomplete/.test(zq.detail), zq?.detail);
res = await run({ live: true });
const zl = res.find((r) => r.group === "Z.ai" && r.name === "glm-4.6v-flash");
check("Z.ai live: it answers -> ok, noting the list gap", zl?.status === "ok" && /missing from the provider's list, but it works/.test(zl.detail), zl?.detail);
check("Z.ai live: the key is then proved by the answer", find(res, "Z.ai", "API key")?.status === "ok");

// Mistral: id not in the list but its own address works (aliases) -> ok
globalThis.fetch = makeFetch({ "api.mistral.ai/v1/models": (u) => (u.endsWith("/models") ? J({ data: [{ id: "mistral-small-2603" }] }) : null) });
res = await run();
check("Mistral: not in list but retrievable by id -> ok (aliases / access rules)", find(res, "Mistral", maxModel)?.status === "ok");

// OpenRouter: the free model is withdrawn ("unavailable for free")
const orText = catalog.openAiCompatible.find((r) => r.tier === "standard" && /openrouter/.test(r.baseUrl)).model;
globalThis.fetch = makeFetch({
  "openrouter.ai/api/v1/models": () => J({ data: [{ id: "google/gemma-4-26b-a4b-it:free" }, { id: "nvidia/nemotron-3-super-120b-a12b:free" }] }),
  "openrouter.ai/api/v1/chat/completions": () => J({ error: { message: "This model is unavailable for free. The paid version is available now - use this slug instead" } }, 404),
});
res = await run({ live: true });
const orGone = find(res, "OpenRouter", orText);
check("OpenRouter free model withdrawn -> ONE fail line, suggests current free ones", orGone?.status === "fail" && /nemotron-3-super/.test(orGone.detail), orGone?.detail);

// Reasoning-model oddities seen live: control tokens / empty text
const cfStd = catalog.openAiCompatible.find((r) => r.tier === "standard" && /cloudflare/.test(r.baseUrl)).model;
const chatReply = (content) => (u, o) => (u.includes("api.cloudflare.com") && u.endsWith("/chat/completions") && JSON.parse(o.body).model === cfStd ? J({ choices: [{ message: { content } }] }) : null);
globalThis.fetch = makeFetch({ "api.cloudflare.com": chatReply("<|start|>assistant") });
res = await run({ live: true });
check("reply that is ONLY control tokens (<|start|>assistant) -> warn, not a green tick", find(res, "Cloudflare Workers AI", cfStd)?.status === "warn" && /control tokens/.test(find(res, "Cloudflare Workers AI", cfStd).detail), find(res, "Cloudflare Workers AI", cfStd)?.detail);
globalThis.fetch = makeFetch({ "api.cloudflare.com": chatReply("<|channel|>final<|message|>OK") });
res = await run({ live: true });
check("control tokens around real text -> warn that the bot strips them", find(res, "Cloudflare Workers AI", cfStd)?.status === "warn" && /bot strips/.test(find(res, "Cloudflare Workers AI", cfStd).detail));
globalThis.fetch = makeFetch({ "api.cloudflare.com": chatReply("") });
res = await run({ live: true });
check("empty reply -> warn (reasoning model used the small budget)", find(res, "Cloudflare Workers AI", cfStd)?.status === "warn" && /no text/.test(find(res, "Cloudflare Workers AI", cfStd).detail));

// The report ends with a short "Needs attention" list
globalThis.fetch = makeFetch({ "getMe": () => J({ ok: false }, 401) });
res = await run();
const att = formatReport(res);
check("'Needs attention' lists failures first", /Needs attention\n❌ Telegram: Bot token/.test(att), att.slice(att.indexOf("Needs attention"), att.indexOf("Needs attention") + 120));
globalThis.fetch = makeFetch();


// ===== 13c. regressions from the SECOND real /health live run =====
// Mistral probed strictly one at a time (it allows ~2 requests a minute)
{
  let inFlight = 0, maxInFlight = 0;
  globalThis.fetch = makeFetch({
    "api.mistral.ai/v1/chat/completions": async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight--; return null; },
  });
  await run({ live: true });
  check("Mistral live requests never overlap", maxInFlight === 1, `max in flight: ${maxInFlight}`);
}

// 403 "not available in your subscription tier" -> fail naming what the key CAN use (the list = what the plan offers)
globalThis.fetch = makeFetch({
  "api.mistral.ai/v1/models/mistral-large-4": () => J({ error: { message: "not found" } }, 404),
  "api.mistral.ai/v1/models": (u) => (u.endsWith("/models") ? J({ data: [{ id: "ministral-14b-2512" }, { id: "ministral-8b-2512" }, { id: "mistral-small-2603" }, { id: "mistral-medium-3-5" }] }) : null),
  "api.mistral.ai/v1/chat/completions": (u, o) => (JSON.parse(o.body).model === "mistral-large-4" ? J({ message: "This model is not available in your subscription tier" }, 403) : null),
});
res = await run({ live: true }, withMaxModel("mistral-large-4"));
const ml = find(res, "Mistral", "mistral-large-4");
check("Mistral Large 4 configured -> 403 -> fail saying the PLAN blocks it (not 'key rejected')", ml?.status === "fail" && /not allowed on your plan \(HTTP 403\): .*subscription tier/.test(ml.detail) && !/key rejected/.test(ml.detail), ml?.detail);
check("...and lists what the plan CAN use, bigger models first", /Models your key can list, for example: mistral-medium-3-5/.test(ml.detail), ml?.detail);
check("...and does not blame the key as a whole", find(res, "Mistral", "API key")?.status === "ok" && find(res, "Mistral", "ministral-8b-2512")?.status === "ok");

// Third real run: Medium 3.5 answered 429 "Rate limit exceeded" -> accessible (a plan block would be 403), just busy
globalThis.fetch = makeFetch({ "api.mistral.ai/v1/chat/completions": (u, o) => (JSON.parse(o.body).model === maxModel ? J({ message: "Rate limit exceeded" }, 429) : null) });
res = await run({ live: true });
const med429 = find(res, "Mistral", maxModel);
check("Max model 429 -> WARN that the key works (it can call the model), not a plan failure", med429?.status === "warn" && /rate-limited right now/.test(med429.detail) && /Rate limit exceeded/.test(med429.detail) && !/plan/.test(med429.detail), med429?.detail);
check("...and the cheap model is still tested and fine", find(res, "Mistral", "ministral-8b-2512")?.status === "ok");

// 429 now carries the provider's own words so you can tell "daily cap" from "busy upstream"
globalThis.fetch = makeFetch({ "openrouter.ai/api/v1/chat/completions": () => J({ error: { message: "Provider returned error: google/gemma-4-31b-it:free is temporarily rate-limited upstream" } }, 429) });
res = await run({ live: true });
const or429 = find(res, "OpenRouter", "gemma-4-31b-it:free");
check("429 -> warn that includes the provider's message", or429?.status === "warn" && /temporarily rate-limited upstream/.test(or429.detail) && /key itself works/.test(or429.detail), or429?.detail);

// a sleeping SearXNG
const sx = { ...process.env, SEARXNG_URL: "https://s.example.org" };
globalThis.fetch = makeFetch({ "s.example.org": async () => { throw Object.assign(new Error("Request timed out after 12000ms"), { name: "AbortError" }); } });
res = await run({}, {}, sx);
const sxl = find(res, "Search", "SearXNG");
check("SearXNG timeout -> fail that explains the cost and the fix", sxl?.status === "fail" && /probably asleep/.test(sxl.detail) && /up to 9s/.test(sxl.detail) && /unset SEARXNG_URL/.test(sxl.detail), sxl?.detail);
globalThis.fetch = makeFetch();


// ModelScope's other 401: valid token, but the Alibaba Cloud account isn't bound / real-name verified
globalThis.fetch = makeFetch({ "api-inference.modelscope.cn": (u) => (u.endsWith("/chat/completions") ? J({ error: { message: "401 please bind your alibaba cloud account before use" } }, 401) : null) });
res = await run({ live: true });
const msBind = find(res, "ModelScope", "API key");
check("ModelScope 'bind your alibaba cloud account' -> plain-English fix, incl. the way out", msBind?.status === "fail" && /bound and real-name verified/.test(msBind.detail) && /remove MODELSCOPE_API_KEY/.test(msBind.detail), msBind?.detail);
check("...and it is told apart from a plainly invalid token", !/real-name/.test(find(res, "Mistral", "API key")?.detail || ""));
globalThis.fetch = makeFetch();

// ===== 13d. spend budgets (can one heavy user drain the shared Mistral credit?) =====
globalThis.fetch = makeFetch();
res = await run();
const bm = find(res, "Budgets", "Mistral credit"), bx = find(res, "Budgets", "Max mode's slice"), bc = find(res, "Budgets", "Cloudflare");
check("budgets: healthy -> ok lines with dollars", bm?.status === "ok" && /\$1\.20 of \$8\.50 \(14%\)/.test(bm.detail) && bx?.status === "ok" && /\$0\.40 of \$5\.00 \(8%\)/.test(bx.detail), `${bm?.detail} | ${bx?.detail}`);
check("budgets: Cloudflare shown in neurons", bc?.status === "ok" && /2,000 neurons of 9,000 neurons/.test(bc.detail), bc?.detail);
res = await run({}, { budgetStatus: budgets(1_200_000, 3_800_000) });
check("budgets: Max slice at 76% -> warn 'getting close'", find(res, "Budgets", "Max mode's slice")?.status === "warn" && /getting close/.test(find(res, "Budgets", "Max mode's slice").detail));
res = await run({}, { budgetStatus: budgets(1_200_000, 5_000_000) });
const spentMax = find(res, "Budgets", "Max mode's slice");
check("budgets: Max slice used up -> warn that says what happens (Max -> Standard, cheap models unaffected)", spentMax?.status === "warn" && /used up/.test(spentMax.detail) && /Standard chain/.test(spentMax.detail) && /unaffected/.test(spentMax.detail), spentMax?.detail);
check("...while the pot itself is still fine", find(res, "Budgets", "Mistral credit")?.status === "ok");
res = await run({}, { budgetStatus: budgets(8_500_000, 5_000_000) });
check("budgets: whole credit used up -> says all Mistral models are off until next month", /switched off until next month/.test(find(res, "Budgets", "Mistral credit").detail));
res = await run({}, { budgetStatus: async () => { throw new Error("connection to postgres://user:pw@localhost.invalid/db refused"); } });
check("budgets: a read failure is a warning (scrubbed), never a crash", find(res, "Budgets", "Spend guards")?.status === "warn" && !JSON.stringify(res).includes("postgres://user:pw"));
const noDb = { ...process.env }; delete noDb.DATABASE_URL;
res = await run({}, {}, noDb);
check("budgets: no database configured -> skipped, not an error", find(res, "Budgets", "Spend guards")?.status === "skip");
res = await run({}, { budgetStatus: async () => ({ mistral: { spent: null, cap: 8_500_000 } }) });
check("budgets: an unreadable value is flagged, not shown as $0", find(res, "Budgets", "Mistral credit")?.status === "warn" && /couldn't be read/.test(find(res, "Budgets", "Mistral credit").detail));
globalThis.fetch = makeFetch();

// ===== 14. formatting =====
globalThis.fetch = makeFetch();
const big = formatReport(await run({ live: true }), { live: true });
const parts = splitReport(big, 1500);
check("splitReport: every part under the limit", parts.every((p) => p.length <= 1500), parts.map((p) => p.length).join());
check("splitReport: nothing lost", parts.join("\n\n") === big);
check("full live report fits in a few Telegram messages", splitReport(big).length <= 4, `${big.length} chars -> ${splitReport(big).length} message(s)`);
check("redactor ignores short/non-secret values", makeRedactor({ BOT_NAME: "Assist AI", X_KEY: "short" })("Assist AI short") === "Assist AI short");

// ===== 15. regressions from the THIRD real /health live run (a reply that was not OK) =====
{
  const { judgeProbeReply } = await import("../lib/health.js");
  check("judgeProbeReply: OK / OK. / **OK** / Okay are recognised", ["OK", "OK.", "**OK**", " ok\n", "Okay!"].every((t) => judgeProbeReply(t) === "ok"));
  check("judgeProbeReply: filler is garbled", ["!!!!!!!!!!!!!!!!!!!!!!!!", "......", "-- -- -- --", "aaaaaaa"].every((t) => judgeProbeReply(t) === "garbled"));
  check("judgeProbeReply: a chatty or off-topic reply is unexpected", judgeProbeReply("Hello! How can I help you today?") === "unexpected" && judgeProbeReply("The user wants me to reply OK, so here is a very long explanation of that request") === "unexpected");
  check("judgeProbeReply: nothing is empty", judgeProbeReply("  ") === "empty" && judgeProbeReply(null) === "empty");

  globalThis.fetch = makeFetch({ "api.cloudflare.com": chatReply("!!!!!!!!!!!!!!!!!!!!!!!!") });
  res = await run({ live: true });
  const bang = find(res, "Cloudflare Workers AI", cfStd);
  check("the real '!!!!' reply from Cloudflare gpt-oss-120b -> WARN, not a green tick", bang?.status === "warn" && /filler/.test(bang.detail) && /!!!!/.test(bang.detail), bang?.detail);
  globalThis.fetch = makeFetch({ "api.cloudflare.com": chatReply("Hello! How can I help you today?") });
  res = await run({ live: true });
  const chat = find(res, "Cloudflare Workers AI", cfStd);
  check("a model that answers something else -> WARN 'not with OK'", chat?.status === "warn" && /not with OK/.test(chat.detail), chat?.detail);
  globalThis.fetch = makeFetch({ "api.cloudflare.com": chatReply("OK") });
  res = await run({ live: true });
  check("a plain OK is still a green tick", find(res, "Cloudflare Workers AI", cfStd)?.status === "ok");

  // Gemini live test: 200 with no text used to be a green tick
  globalThis.fetch = makeFetch({ "generativelanguage.googleapis.com": (u, o) => (o.method === "POST" ? J({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }) : null) });
  res = await run({ live: true });
  const gem0 = find(res, "Gemini", "live test");
  check("Gemini answers 200 but with no text -> WARN with the finish reason", gem0?.status === "warn" && /no text/.test(gem0.detail) && /MAX_TOKENS/.test(gem0.detail), gem0?.detail);
  globalThis.fetch = makeFetch({ "generativelanguage.googleapis.com": (u, o) => (o.method === "POST" ? J({ candidates: [{ content: { parts: [{ text: "???????????" }] } }] }) : null) });
  res = await run({ live: true });
  check("Gemini answers filler -> WARN", find(res, "Gemini", "live test")?.status === "warn");

  // The three repeating warnings now say WHY
  globalThis.fetch = makeFetch({ "generativelanguage.googleapis.com": (u, o) => (o.method === "POST" ? J({ error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } }, 503) : null) });
  res = await run({ live: true });
  const g503 = find(res, "Gemini", "live test");
  check("Gemini 503 -> warn that quotes Google's own message", g503?.status === "warn" && /HTTP 503: This model is currently experiencing high demand/.test(g503.detail), g503?.detail);
  globalThis.fetch = makeFetch({ "openrouter.ai/api/v1/chat/completions": () => J({ error: { message: "Provider returned error", code: 429, metadata: { raw: JSON.stringify({ error: { message: "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly." } }), provider_name: "Google AI Studio" } } }, 429) });
  res = await run({ live: true });
  const orw = find(res, "OpenRouter", "gemma-4-31b-it:free");
  check("OpenRouter 'Provider returned error' -> warn that digs out the upstream reason and provider", orw?.status === "warn" && /temporarily rate-limited upstream/.test(orw.detail) && /Google AI Studio/.test(orw.detail), orw?.detail);
  globalThis.fetch = makeFetch({ "api.mistral.ai/v1/chat/completions": (u, o) => (JSON.parse(o.body).model === maxModel ? new Response(JSON.stringify({ message: "Rate limit exceeded" }), { status: 429, headers: { "retry-after": "37" } }) : null) });
  res = await run({ live: true });
  check("429 with a Retry-After header -> says how long to wait", /retry in 37s/.test(find(res, "Mistral", maxModel)?.detail || ""), find(res, "Mistral", maxModel)?.detail);

  // Search: awake-but-useless is not a green tick
  const sxEnv = { ...process.env, SEARXNG_URL: "https://searx.example.test" };
  globalThis.fetch = makeFetch({ "searx.example.test": () => J({ results: [], unresponsive_engines: [["google", "CAPTCHA"], ["duckduckgo", "timeout"]] }) });
  res = await run({ live: true }, {}, sxEnv);
  const sx0 = find(res, "Search", "SearXNG");
  check("SearXNG 200 with 0 results -> WARN naming the failing engines", sx0?.status === "warn" && /0 results/.test(sx0.detail) && /google \(CAPTCHA\)/.test(sx0.detail), sx0?.detail);
  globalThis.fetch = makeFetch({ "searx.example.test": () => J({ results: [{ title: "x" }] }) });
  res = await run({ live: true }, {}, sxEnv);
  check("SearXNG with results is still a green tick", find(res, "Search", "SearXNG")?.status === "ok");
  globalThis.fetch = makeFetch({ "api.tavily.com": () => J({ detail: "weird" }) });
  res = await run({ live: true }, {}, { ...process.env, TAVILY_API_KEY: "tvly-FAKE_TAVILY_000111" });
  check("Tavily 200 without a results list -> WARN", find(res, "Search", "Tavily")?.status === "warn");
}

// ===== 16. image probe: vision models are tested with a real image =====
{
  const cfVision = catalog.openAiCompatible.find((r) => r.tier === "vision" && /cloudflare/.test(r.baseUrl)).model;
  globalThis.fetch = makeFetch();
  res = await run({ live: true });
  const imgPosts = calls.filter((x) => x.method === "POST" && /image_url/.test(x.body || ""));
  const cfImg = imgPosts.find((x) => x.url.includes("api.cloudflare.com"));
  const sent = cfImg && JSON.parse(cfImg.body);
  check("live: the Cloudflare vision model is sent a real PNG image (same message shape the bot uses)", !!sent && sent.model === cfVision && sent.messages[0].content.some((c) => c.type === "image_url" && /^data:image\/png;base64,iVBOR/.test(c.image_url.url)));
  check("live: the test image is bigger than 1x1 (vision encoders reject tiny images)", (() => { const b = Buffer.from(sent.messages[0].content.find((c) => c.type === "image_url").image_url.url.split(",")[1], "base64"); return b.readUInt32BE(16) >= 28 && b.readUInt32BE(20) >= 28; })());
  check("live: a vision-only model is NOT also sent a text probe (saves requests)", !calls.some((x) => x.method === "POST" && x.url.includes("api.cloudflare.com") && x.body && JSON.parse(x.body).model === cfVision && !/image_url/.test(x.body)));
  const cfLine = find(res, "Cloudflare Workers AI", cfVision);
  check("live: the vision line says it read the test image", cfLine?.status === "ok" && /read the test image in/.test(cfLine.detail) && /Red/.test(cfLine.detail), cfLine?.detail);
  const zline = res.find((r) => r.group === "Z.ai" && r.name === "glm-4.6v-flash");
  check("live: Z.ai's vision model is image-tested too", zline?.status === "ok" && /read the test image/.test(zline.detail), zline?.detail);
  const gposts = calls.filter((x) => x.method === "POST" && x.url.includes("generateContent"));
  check("live: Gemini's vision backup gets an inline image", gposts.length === 1 && /inline_data/.test(gposts[0].body) && /image\/png/.test(gposts[0].body));
  check("live: Gemini line says it read the test image", /read the test image/.test(find(res, "Gemini", "live test")?.detail || ""), find(res, "Gemini", "live test")?.detail);

  // a model that answers about something else
  globalThis.fetch = makeFetch({ "api.cloudflare.com": (u, o) => (u.endsWith("/chat/completions") && JSON.parse(o.body).model === cfVision ? J({ choices: [{ message: { content: "I cannot see any image." } }] }) : null) });
  res = await run({ live: true });
  const blind = find(res, "Cloudflare Workers AI", cfVision);
  check("a vision model that can't see the image -> WARN 'not with red'", blind?.status === "warn" && /not with red/.test(blind.detail) && /can't tell what is in a plain test image/.test(blind.detail), blind?.detail);
  // a model that rejects images
  globalThis.fetch = makeFetch({ "api.cloudflare.com": (u, o) => (u.endsWith("/chat/completions") && JSON.parse(o.body).model === cfVision ? J({ errors: [{ message: "this model does not support image input" }] }, 400) : null) });
  res = await run({ live: true });
  const reject = find(res, "Cloudflare Workers AI", cfVision);
  check("a vision model that rejects images -> not green, and says it was the image", reject?.status !== "ok" && /while reading the test image/.test(reject.detail), reject?.detail);
  // Gemini vision returning the wrong thing
  globalThis.fetch = makeFetch({ "generativelanguage.googleapis.com": (u, o) => (o.method === "POST" ? J({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }) : null) });
  res = await run({ live: true });
  check("Gemini answering 'OK' to the image question -> WARN (it ignored the image)", find(res, "Gemini", "live test")?.status === "warn" && /not with red/.test(find(res, "Gemini", "live test")?.detail || ""), find(res, "Gemini", "live test")?.detail);
  // a rejected KEY while reading the image must not claim the image was the problem
  globalThis.fetch = makeFetch({ "api.cloudflare.com": (u, o) => (u.endsWith("/chat/completions") && JSON.parse(o.body).model === cfVision ? J({ errors: [{ message: "Authentication failed" }] }, 401) : null) });
  res = await run({ live: true });
  const auth401 = find(res, "Cloudflare Workers AI", cfVision);
  check("a 401 on the image probe is a key problem, with no '(while reading the test image)' note", auth401?.status !== "ok" && !/while reading the test image/.test(auth401.detail), auth401?.detail);
  globalThis.fetch = makeFetch({ "api.cloudflare.com": (u, o) => (u.endsWith("/chat/completions") && JSON.parse(o.body).model === cfVision ? J({ errors: [{ message: "The service may be temporarily overloaded" }] }, 429) : null) });
  res = await run({ live: true });
  const lim429 = find(res, "Cloudflare Workers AI", cfVision);
  check("a 429 on the image probe is a rate-limit WARN, with no '(while reading the test image)' note", lim429?.status === "warn" && /rate-limited right now/.test(lim429.detail) && !/while reading the test image/.test(lim429.detail), lim429?.detail);
  const { judgeProbeReply: j2 } = await import("../lib/health.js");
  check("judgeProbeReply(…, 'red'): Red / red. / 'The image is red' ok; 'blue' and 'OK' are not", ["Red", "red.", "The image is red"].every((t) => j2(t, "red") === "ok") && j2("blue", "red") === "unexpected" && j2("OK", "red") === "unexpected");
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
