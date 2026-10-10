// lib/health.js
//
// "Is everything really connected and talking?" — one check, two ways to run it:
//   • the owner-only /health command in the bot (tests the keys that are actually set on
//     Vercel, from the live deployment), and
//   • `npm run check` / `npm run check:live` (scripts/check-env.mjs) before you deploy.
//
// Two levels, so a check never burns the free quotas you are trying to protect:
//   quick (default) — asks each provider a FREE question ("is this key valid?", "does this
//                     model id exist?"). Uses no generation quota and no money.
//   live            — additionally sends ONE tiny "reply with OK" message per model, which
//                     proves the whole round trip. Costs a handful of requests: ~1 of OpenRouter's
//                     50/day, ~1 of Gemini 3.5 Flash-Lite's 500/day (never the 20/day model), a few
//                     Cloudflare neurons and a fraction of a cent of Mistral.
//
// It tests the SAME model ids the bot calls (taken from lib/ai.js's providerCatalog()), so a
// retired or mistyped model shows up here instead of as a silent fallback in production.
// Secrets: nothing printed or sent ever contains a key — every provider message passes
// through redact() first.

import { fetchWithTimeout } from "./fetchWithTimeout.js";

const TIMEOUT_MS = 9000;
const PROBE = "Reply with exactly: OK";

const TIER_LABEL = {
  standard: "main chat",
  flash: "fast mode",
  max: "max mode",
  vision: "images",
  image: "image generation",
  voice: "voice transcription",
};

const HOST_LABEL = {
  "api.groq.com": "Groq",
  "api.cerebras.ai": "Cerebras",
  "api.cloudflare.com": "Cloudflare Workers AI",
  "openrouter.ai": "OpenRouter",
  "api.mistral.ai": "Mistral",
  "api-inference.modelscope.cn": "ModelScope",
  "api.z.ai": "Z.ai",
};

// Which file creates each table (shown when a table is missing).
const MIGRATION_FOR = {
  access_requests: "db/migrate_access_v3.sql",
  channel_memberships: "db/migrate_channel_bonus_v11.sql",
  memories: "db/migrate_memories_v2.sql",
  plan_prices: "db/migrate_plan_prices_v7.sql",
  plan_trials: "db/migrate_plan_trials_v15.sql",
  referral_trials: "db/migrate_referral_trials_v10.sql",
  referrals: "db/migrate_referrals_v9.sql",
  subscriptions: "db/migrate_subscriptions_v6.sql",
  usage_events: "db/migrate_limits_v4.sql",
  user_settings: "db/migrate_memory.sql",
  chats: "db/setup.sql",
  messages: "db/setup.sql",
};

const REQUIRED = [
  ["DATABASE_URL", "Neon database (set automatically when you connect Neon)"],
  ["TELEGRAM_BOT_TOKEN", "from @BotFather"],
  ["TELEGRAM_WEBHOOK_SECRET", "any random string; must match setWebhook's secret_token"],
  ["OWNER_CHAT_ID", "your numeric Telegram id"],
  ["MINI_APP_URL", "your deployed https://…/miniapp/index.html"],
  ["GROQ_API_KEY", "main chat model + voice"],
  ["GEMINI_API_KEY", "vision, PDFs, Extra tier"],
  ["BLOB_READ_WRITE_TOKEN", "file uploads (connect a Vercel Blob store)"],
];

const OPTIONAL_KEYS = [
  "CEREBRAS_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "MISTRAL_API_KEY", "MODELSCOPE_API_KEY",
  "OPENROUTER_API_KEY", "SEARXNG_URL", "TAVILY_API_KEY", "TELEGRAM_BOT_USERNAME", "TELEGRAM_CHANNEL_USERNAME", "ZAI_API_KEY",
];

// Not keys — knobs that fall back to a built-in default when unset.
const TUNABLES = [
  "BOT_NAME", "CF_FLASH_MODEL", "CF_IMAGE_MODEL", "CF_IMAGE_STEPS", "CF_NEURON_DAILY_CAP", "CF_STANDARD_MODEL", "CF_VISION_MODEL",
  "EXTRA_SITE_DAILY_CAP", "FILE_SITE_DAILY_CAP", "GROQ_FLASH_MODEL", "MISTRAL_14B_MODEL", "MISTRAL_8B_MODEL", "MISTRAL_LARGE_MODEL",
  "MISTRAL_MONTHLY_BUDGET_USD", "MISTRAL_SMALL_MODEL", "OPENROUTER_MODEL", "OPENROUTER_VISION_MODEL", "PRO_PROMO_SLOTS", "TOKEN_WINDOW_DAYS", "TRIAL_DAILY_START_CAP",
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export function makeRedactor(env) {
  const secrets = Object.entries(env || {})
    .filter(([k, v]) => /KEY|TOKEN|SECRET|DATABASE_URL/.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v);
  return (text) => {
    let out = String(text ?? "");
    for (const v of secrets) out = out.split(v).join("***");
    return out;
  };
}

async function http(url, { method = "GET", headers = {}, body, timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs
    );
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: resp.status, ok: resp.ok, text, json, ms: Date.now() - started, error: null };
  } catch (err) {
    const timedOut = err?.name === "AbortError" || /abort|timeout|timed out/i.test(err?.message || "");
    return { status: 0, ok: false, text: "", json: null, ms: Date.now() - started, error: timedOut ? `no answer within ${timeoutMs / 1000}s` : err?.message || "network error" };
  }
}

const apiMessage = (res) => (res.json?.error?.message || res.json?.message || res.json?.errors?.[0]?.message || res.text || "").toString().replace(/\s+/g, " ").slice(0, 90);

// A failed call -> [status, plain-English reason]
function explain(res) {
  if (res.error) return ["fail", res.error];
  if (res.status === 401 || res.status === 403) {
    const m = apiMessage(res);
    return ["fail", `key rejected (HTTP ${res.status})${m ? `: ${m}` : ""}`];
  }
  if (res.status === 429) return ["warn", "rate-limited right now — the key itself works"];
  if (res.status >= 500) return ["warn", `provider is having problems (HTTP ${res.status})`];
  const m = apiMessage(res);
  return ["fail", `HTTP ${res.status}${m ? `: ${m}` : ""}`];
}

const short = (s, n = 24) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const labelFor = (baseUrl) => HOST_LABEL[hostOf(baseUrl)] || hostOf(baseUrl) || "provider";

// ---------------------------------------------------------------------------
// the checks — each returns [{group, name, status, detail}]
// ---------------------------------------------------------------------------
const R = (group, name, status, detail = "") => ({ group, name, status, detail });

function checkSettings(env) {
  const g = "Settings";
  const out = [];
  for (const [name, hint] of REQUIRED) {
    const v = env[name];
    out.push(v ? R(g, name, "ok", "set") : R(g, name, "fail", `MISSING — ${hint}`));
  }
  if (env.OWNER_CHAT_ID && !/^-?\d+$/.test(env.OWNER_CHAT_ID)) out.push(R(g, "OWNER_CHAT_ID", "fail", "must be a number (your Telegram id), not a @username"));
  if (env.MINI_APP_URL && !/^https:\/\/.+/.test(env.MINI_APP_URL)) out.push(R(g, "MINI_APP_URL", "fail", "must start with https://"));
  else if (env.MINI_APP_URL && !/\/miniapp/.test(env.MINI_APP_URL)) out.push(R(g, "MINI_APP_URL", "warn", "normally ends with /miniapp/index.html"));
  const hasId = !!env.CLOUDFLARE_ACCOUNT_ID, hasTok = !!env.CLOUDFLARE_API_TOKEN;
  if (hasId !== hasTok) out.push(R(g, "Cloudflare keys", "warn", `only ${hasId ? "CLOUDFLARE_ACCOUNT_ID" : "CLOUDFLARE_API_TOKEN"} is set — you need BOTH, so Cloudflare is switched off`));
  const optionalSet = OPTIONAL_KEYS.filter((k) => env[k]);
  const optionalOff = OPTIONAL_KEYS.filter((k) => !env[k]);
  out.push(R(g, "Optional keys set", optionalSet.length ? "ok" : "skip", optionalSet.join(", ") || "none"));
  if (optionalOff.length) out.push(R(g, "Optional keys not set", "skip", `${optionalOff.join(", ")} (those features are simply off)`));
  const defaults = TUNABLES.filter((k) => !env[k]);
  if (defaults.length) out.push(R(g, "Using built-in defaults", "skip", defaults.join(", ")));
  out.push(env.VERCEL_ENV
    ? R(g, "Environment", "ok", `VERCEL_ENV=${env.VERCEL_ENV}`)
    : R(g, "Environment", "skip", "VERCEL_ENV not set (running locally, or this project doesn't expose Vercel system variables — harmless)"));
  return out;
}

async function defaultDbTables() {
  const { db } = await import("../db/client.js");
  const { sql } = await import("drizzle-orm");
  const result = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
  const rows = Array.isArray(result) ? result : result?.rows ?? [];
  return rows.map((r) => r.table_name);
}
async function defaultExpectedTables() {
  const schema = await import("../db/schema.js");
  const { is, getTableName } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  return Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableName(t));
}

async function checkDatabase(env, deps) {
  const g = "Database";
  if (!env.DATABASE_URL) return [R(g, "Neon", "fail", "DATABASE_URL is not set")];
  let existing;
  try {
    existing = await (deps.dbTables || defaultDbTables)();
  } catch (err) {
    return [R(g, "Neon", "fail", `can't connect: ${short(err?.message, 90)}`)];
  }
  let expected;
  try {
    expected = await (deps.expectedTables || defaultExpectedTables)();
  } catch {
    return [R(g, "Neon", "ok", `connected (${existing.length} tables)`)];
  }
  const missing = expected.filter((t) => !existing.includes(t));
  if (!missing.length) return [R(g, "Neon", "ok", `connected, all ${expected.length} tables present`)];
  const fixes = missing.map((t) => `${t} → run ${MIGRATION_FOR[t] || "the matching db/migrate_*.sql"}`);
  return [R(g, "Neon", "fail", `connected, but missing: ${fixes.join("; ")}`)];
}

async function checkTelegram(env) {
  const g = "Telegram";
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return [R(g, "Bot token", "fail", "TELEGRAM_BOT_TOKEN is not set")];
  const base = `https://api.telegram.org/bot${token}`;
  const [me, wh] = await Promise.all([http(`${base}/getMe`), http(`${base}/getWebhookInfo`)]);
  const out = [];
  if (!me.ok || !me.json?.ok) {
    const [st, why] = explain(me.status === 401 || me.status === 404 ? { ...me, status: 401 } : me);
    out.push(R(g, "Bot token", st, why));
  } else {
    const uname = me.json.result?.username || "?";
    const wanted = (env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
    if (wanted && wanted.toLowerCase() !== uname.toLowerCase()) out.push(R(g, "Bot token", "warn", `valid, but it is @${uname} while TELEGRAM_BOT_USERNAME says @${wanted}`));
    else out.push(R(g, "Bot token", "ok", `valid — @${uname}`));
  }
  if (!wh.ok || !wh.json?.ok) {
    const [st, why] = explain(wh);
    out.push(R(g, "Webhook", st, why));
  } else {
    const info = wh.json.result || {};
    if (!info.url) {
      out.push(R(g, "Webhook", "fail", "NOT SET — Telegram has nowhere to send messages. Run setWebhook (README step 2)"));
    } else {
      const problems = [];
      if (!/\/api\/telegram-webhook\/?$/.test(info.url)) problems.push("URL doesn't end with /api/telegram-webhook");
      const recent = info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600;
      if (recent && info.last_error_message) problems.push(`Telegram's last delivery error (<1h ago): ${short(info.last_error_message, 80)}`);
      if (info.pending_update_count > 20) problems.push(`${info.pending_update_count} updates waiting — the bot is erroring or slow`);
      out.push(problems.length ? R(g, "Webhook", "warn", `${hostOf(info.url)}; ${problems.join("; ")}`) : R(g, "Webhook", "ok", `${hostOf(info.url)}, ${info.pending_update_count || 0} pending`));
    }
  }
  return out;
}

async function defaultBlobList(token) {
  const { list } = await import("@vercel/blob");
  await list({ limit: 1, token });
}
async function checkStorage(env, deps) {
  const g = "Storage";
  if (!env.BLOB_READ_WRITE_TOKEN) return [R(g, "Vercel Blob", "fail", "BLOB_READ_WRITE_TOKEN is not set — uploads and generated files won't work")];
  try {
    await (deps.blobList || defaultBlobList)(env.BLOB_READ_WRITE_TOKEN);
    return [R(g, "Vercel Blob", "ok", "token valid, store reachable")];
  } catch (err) {
    return [R(g, "Vercel Blob", "fail", `token rejected or store unreachable: ${short(err?.message, 80)}`)];
  }
}

async function checkGemini(catalog, live) {
  const g = "Gemini";
  const { apiKey, primary, fallback, extra } = catalog.gemini;
  if (!apiKey) return [R(g, "Gemini", "fail", "GEMINI_API_KEY is not set")];
  const roles = new Map();
  const add = (id, role) => roles.set(id, [...(roles.get(id) || []), role]);
  add(primary, "main text"); add(fallback, "vision/PDF/voice backup");
  extra.forEach((m) => add(m, "Extra tier"));
  const headers = { "x-goog-api-key": apiKey };
  const base = "https://generativelanguage.googleapis.com/v1beta/models";
  const out = await Promise.all([...roles].map(async ([id, rs]) => {
    const res = await http(`${base}/${id}`, { headers });
    const role = rs.join(" + ");
    if (res.status === 200) return R(g, id, "ok", `exists (${role})`);
    if (res.status === 404) return R(g, id, rs.includes("main text") || rs.includes("vision/PDF/voice backup") ? "fail" : "warn", `model id not found at Google (${role}) — the bot skips it`);
    if (res.status === 400 && /api key/i.test(apiMessage(res))) return R(g, id, "fail", "API key not valid");
    const [st, why] = explain(res);
    return R(g, id, st, why);
  }));
  if (live) {
    // Only the roomy 500/day model — never spend the 20/day one on a health check.
    const res = await http(`${base}/${fallback}:generateContent`, {
      method: "POST", headers,
      body: { contents: [{ parts: [{ text: PROBE }] }], generationConfig: { maxOutputTokens: 64 } },
    });
    if (res.status === 200 && res.json?.candidates) {
      const text = short(res.json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "");
      out.push(R(g, "live test", "ok", `${fallback} answered in ${res.ms}ms${text ? ` ("${text}")` : ""}`));
    } else {
      const [st, why] = explain(res);
      out.push(R(g, "live test", st, `${fallback}: ${why}`));
    }
  }
  return out;
}

// Providers that speak the OpenAI chat-completions format (everything except Gemini).
function groupProviders(catalog) {
  const byHost = new Map();
  for (const row of catalog.openAiCompatible) {
    // An unconfigured provider has no base URL (Cloudflare's depends on the account id), so label it by name.
    const host = hostOf(row.baseUrl) || `unconfigured:${row.name.split(" ")[0]}`;
    const label = row.baseUrl ? labelFor(row.baseUrl) : row.name.startsWith("Cloudflare") ? "Cloudflare Workers AI" : row.name.split(" ")[0];
    if (!byHost.has(host)) byHost.set(host, { label, baseUrl: row.baseUrl, apiKey: row.apiKey, headers: row.extraHeaders, models: new Map() });
    const p = byHost.get(host);
    if (!p.models.has(row.model)) p.models.set(row.model, new Set());
    p.models.get(row.model).add(row.tier);
  }
  return [...byHost.values()];
}

// Providers whose /models list is complete, so "not in the list" really means "gone".
// (Z.ai and ModelScope publish partial public lists — a miss there is only a warning.)
const AUTHORITATIVE_LIST = new Set(["Groq", "Cerebras", "Mistral", "OpenRouter"]);

function liveTargets(p) {
  const ids = [...p.models.keys()];
  const tiers = (id) => p.models.get(id);
  switch (p.label) {
    case "Groq": return ids.filter((m) => tiers(m).has("standard") || tiers(m).has("flash"));
    case "Cloudflare Workers AI": return ids; // the image model is added separately and never live-tested (costly)
    case "OpenRouter": return ids.filter((m) => tiers(m).has("standard")); // keep to 1 of its 50 free requests/day
    case "Mistral": return ids; // all four together cost well under a cent
    default: return ids.slice(0, 1);
  }
}

// One tiny "reply with OK" -> a structured result (never throws).
async function probe(p, model) {
  const res = await http(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.apiKey}`, ...(p.headers || {}) },
    body: { model, messages: [{ role: "user", content: PROBE }], max_tokens: 200 },
  });
  if (res.status === 200 && Array.isArray(res.json?.choices)) {
    const raw = res.json.choices[0]?.message?.content;
    const text = typeof raw === "string" ? raw : "";
    const stripped = text.replace(/<\|[a-z_]+\|>(?:assistant|user|system|analysis|commentary|final)?/g, "").trim();
    if (!stripped) return { kind: text.trim() ? "tokens-only" : "empty", ms: res.ms };
    return { kind: /<\|[a-z_]+\|>/.test(text) ? "tokens" : "ok", ms: res.ms, text: short(stripped) };
  }
  const [status, why] = explain(res);
  return { kind: res.status === 404 ? "missing" : status === "warn" ? "warn" : "fail", why, ms: res.ms };
}

// "Did you mean…": when a model is gone, show what the provider offers now.
function suggest(model, ids) {
  if (!ids || !ids.size) return "";
  const family = model.split("/").pop().replace(/:.*$/, "").split("-").slice(0, 2).join("-").toLowerCase();
  const all = [...ids].filter((id) => id !== model);
  const sameFamily = all.filter((id) => id.toLowerCase().includes(family));
  // Same family first (the likeliest successor), then other current chat models — a retired model's
  // family often has no successor at all (Groq shut down its whole Llama line).
  const otherChat = all.filter((id) => !sameFamily.includes(id) && !/whisper|tts|guard|embed|orpheus|moderation|ocr|transcri|image|audio|vision-preview/i.test(id));
  const near = [...sameFamily, ...otherChat];
  return near.length ? ` Available now, for example: ${near.slice(0, 5).join(", ")}.` : "";
}

// One line per model, combining "does it exist?" (exists: yes|no|unknown) with the live answer (or null).
function modelLine(g, model, role, { exists, authoritative, live, label, hint = "", deprecatedIfMissing = false }) {
  if (live) {
    switch (live.kind) {
      case "ok":
        if (exists === "no" && deprecatedIfMissing) return R(g, model, "warn", `${role} — still answers (${live.ms}ms${live.text ? `, "${live.text}"` : ""}) but is no longer in ${label}'s catalog: probably deprecated, so plan a replacement`);
        return R(g, model, "ok", `${role} — answered in ${live.ms}ms${live.text ? ` ("${live.text}")` : ""}${exists === "no" ? " (missing from the provider's list, but it works)" : ""}`);
      case "tokens": return R(g, model, "warn", `${role} — answered in ${live.ms}ms, but the text contained raw control tokens (<|…|>); the bot strips these`);
      case "tokens-only": return R(g, model, "warn", `${role} — the reply was only raw control tokens (a cut-off reasoning model); the bot ignores such replies and falls back`);
      case "empty": return R(g, model, "warn", `${role} — reachable, but it sent back no text (a reasoning model can use up a small test budget thinking)`);
      case "missing": return R(g, model, "fail", `${role} — ${label} says this model doesn't exist; the bot skips it.${hint}`);
      case "warn": return R(g, model, "warn", `${role} — ${live.why}`);
      default: return R(g, model, "fail", `${role} — ${live.why}`);
    }
  }
  if (exists === "yes") return R(g, model, "ok", `${role} — listed`);
  if (exists === "no") {
    return authoritative
      ? R(g, model, "fail", `${role} — not found at ${label} (retired or mistyped); the bot skips it.${hint}`)
      : R(g, model, "warn", `${role} — not in ${label}'s list (it may be incomplete or the model retired); a live test will tell`);
  }
  return R(g, model, "warn", `${role} — can't confirm the model id for free; a live test will tell`);
}

async function checkOpenAiProvider(p, env, live) {
  const g = p.label;
  if (!p.apiKey || !p.baseUrl) {
    return [R(g, p.label, p.label === "Groq" ? "fail" : "skip", p.label === "Groq" ? "GROQ_API_KEY is not set (required)" : "not configured (optional)")];
  }
  if (p.label === "Cloudflare Workers AI") return checkCloudflare(p, env, live);

  const auth = { Authorization: `Bearer ${p.apiKey}` };
  let ids = null;
  let keyState = "unknown"; // ok | bad | unverified | unknown
  let keyLine;

  if (p.label === "OpenRouter") {
    // /models is public, so prove the KEY with /auth/key and read the catalog separately.
    const k = await http(`${p.baseUrl}/auth/key`, { headers: auth });
    if (k.status === 200) { keyState = "ok"; keyLine = R(g, "API key", "ok", k.json?.data?.is_free_tier ? "valid (free tier: ~50 requests/day)" : "valid"); }
    else { const [st, why] = explain(k); keyState = k.status === 401 || k.status === 403 ? "bad" : "unknown"; keyLine = R(g, "API key", st, why); }
    const m = await http(`${p.baseUrl}/models`);
    if (m.status === 200 && Array.isArray(m.json?.data)) ids = new Set(m.json.data.map((x) => x.id));
  } else {
    const m = await http(`${p.baseUrl}/models`, { headers: auth });
    if (m.status === 200 && Array.isArray(m.json?.data)) {
      ids = new Set(m.json.data.map((x) => x.id));
      const anon = await http(`${p.baseUrl}/models`); // does this list need the key at all?
      if (anon.status === 200) { keyState = "unverified"; keyLine = R(g, "API key", "warn", `can't be checked for free — ${p.label}'s model list is public${live ? "" : " (run a live test)"}`); }
      else { keyState = "ok"; keyLine = R(g, "API key", "ok", "accepted"); }
    } else if (m.error || m.status === 401 || m.status === 403 || m.status === 429 || m.status >= 500) {
      const [st, why] = explain(m);
      keyState = m.status === 401 || m.status === 403 ? "bad" : "unknown";
      keyLine = R(g, "API key", st, why);
    } else {
      keyState = "unverified";
      keyLine = R(g, "API key", "warn", "set, but this provider has no free key check — a live test will tell");
    }
  }

  // Does each model exist? The list first; a model missing from it gets a second look at its own
  // address (handles aliases and access rules) before it is called gone.
  const exists = new Map();
  if (ids) {
    const unmatched = [];
    for (const model of p.models.keys()) (ids.has(model) ? exists.set(model, "yes") : unmatched.push(model));
    await Promise.all(unmatched.map(async (model) => {
      if (p.label === "OpenRouter") return exists.set(model, "no"); // its list is complete and has no per-model address
      const r = await http(`${p.baseUrl}/models/${model}`, { headers: auth });
      exists.set(model, r.status === 200 ? "yes" : "no");
    }));
  } else {
    for (const model of p.models.keys()) exists.set(model, "unknown");
  }

  const liveResults = new Map();
  if (live && keyState !== "bad") {
    const targets = liveTargets(p);
    const results = await Promise.all(targets.map((m) => probe(p, m)));
    targets.forEach((m, i) => liveResults.set(m, results[i]));
  }
  // A live answer can settle a key the free check couldn't verify.
  if (keyState === "unverified" && liveResults.size) {
    const all = [...liveResults.values()];
    if (all.some((r) => ["ok", "tokens", "tokens-only", "empty"].includes(r.kind))) keyLine = R(g, "API key", "ok", "accepted (proved by the live test)");
    else { const bad = all.find((r) => r.kind === "fail"); if (bad) keyLine = R(g, "API key", "fail", bad.why); }
  }

  const out = [keyLine];
  const authoritative = AUTHORITATIVE_LIST.has(p.label);
  for (const [model, tiers] of p.models) {
    const role = [...tiers].map((t) => TIER_LABEL[t]).join(" + ");
    if (keyState === "bad") { out.push(R(g, model, "skip", `${role} — not tested (key problem above)`)); continue; }
    out.push(modelLine(g, model, role, { exists: exists.get(model), authoritative, live: liveResults.get(model) || null, label: p.label, hint: suggest(model, ids) }));
  }
  if (p.label === "Groq") {
    const { GROQ_WHISPER_MODEL } = await import("./transcribe.js");
    const ex = !ids ? "unknown" : ids.has(GROQ_WHISPER_MODEL) ? "yes" : "no";
    out.push(modelLine(g, GROQ_WHISPER_MODEL, TIER_LABEL.voice, { exists: ex, authoritative: true, live: null, label: p.label, hint: suggest(GROQ_WHISPER_MODEL, ids) }));
  }
  return out;
}

async function checkCloudflare(p, env, live) {
  const g = p.label;
  const id = env.CLOUDFLARE_ACCOUNT_ID;
  const headers = { Authorization: `Bearer ${p.apiKey}` };
  const api = "https://api.cloudflare.com/client/v4";
  const out = [];

  // The "Workers AI" token template makes a user-scoped token; account-owned tokens verify elsewhere. Accept either.
  const [u, a] = await Promise.all([http(`${api}/user/tokens/verify`, { headers }), http(`${api}/accounts/${id}/tokens/verify`, { headers })]);
  const active = (r) => r.status === 200 && r.json?.success && /active/i.test(r.json?.result?.status || "active");
  if (active(u) || active(a)) out.push(R(g, "API token", "ok", "valid and active"));
  else if (u.error && a.error) return [R(g, "API token", "fail", u.error)];
  else return [R(g, "API token", "fail", "rejected — check CLOUDFLARE_API_TOKEN (needs Workers AI Read + Edit) and CLOUDFLARE_ACCOUNT_ID")];

  const wanted = new Map(p.models);
  const imageModel = env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
  wanted.set(imageModel, new Set([...(wanted.get(imageModel) || []), "image"]));

  const exists = new Map();
  await Promise.all([...wanted.keys()].map(async (model) => {
    const res = await http(`${api}/accounts/${id}/ai/models/search?search=${encodeURIComponent(model.split("/").pop())}&per_page=20`, { headers });
    exists.set(model, res.status === 200 && Array.isArray(res.json?.result) ? (res.json.result.some((m) => m.name === model) ? "yes" : "no") : "unknown");
  }));
  const liveResults = new Map();
  if (live) {
    const targets = liveTargets(p);
    const results = await Promise.all(targets.map((m) => probe(p, m)));
    targets.forEach((m, i) => liveResults.set(m, results[i]));
  }
  for (const [model, tiers] of wanted) {
    const role = [...tiers].map((t) => TIER_LABEL[t]).join(" + ");
    out.push(modelLine(g, model, role, { exists: exists.get(model), authoritative: false, live: liveResults.get(model) || null, label: "Cloudflare", deprecatedIfMissing: true }));
  }
  return out;
}

async function checkSearch(env, live) {
  const g = "Search";
  const out = [];
  if (env.SEARXNG_URL) {
    const base = env.SEARXNG_URL.replace(/\/+$/, "");
    const res = await http(`${base}/search?q=test&format=json`, { timeoutMs: 12000 });
    if (res.status === 200 && Array.isArray(res.json?.results)) out.push(R(g, "SearXNG", "ok", `answered in ${res.ms}ms`));
    else if (res.status === 403) out.push(R(g, "SearXNG", "warn", "reachable, but JSON output is switched off (enable `json` under search.formats in its settings.yml)"));
    else { const [st, why] = explain(res); out.push(R(g, "SearXNG", st, why)); }
  }
  if (env.TAVILY_API_KEY) {
    if (live) {
      const res = await http("https://api.tavily.com/search", { method: "POST", body: { api_key: env.TAVILY_API_KEY, query: "test", max_results: 1 } });
      if (res.status === 200) out.push(R(g, "Tavily", "ok", `answered in ${res.ms}ms (used 1 credit)`));
      else { const [st, why] = explain(res); out.push(R(g, "Tavily", st, why)); }
    } else {
      const res = await http("https://api.tavily.com/usage", { headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}` } });
      if (res.status === 200) out.push(R(g, "Tavily", "ok", "key valid"));
      else if (res.status === 401 || res.status === 403) out.push(R(g, "Tavily", "fail", `key rejected (HTTP ${res.status})`));
      else out.push(R(g, "Tavily", "warn", "key set — it has no free key check, use a live test to be sure"));
    }
  }
  if (!env.SEARXNG_URL && !env.TAVILY_API_KEY) out.push(R(g, "Web search", "skip", "SearXNG and Tavily not set — search falls back to Gemini's built-in search"));
  return out;
}

// ---------------------------------------------------------------------------
export async function runHealthCheck({ live = false, env = process.env, deps = {} } = {}) {
  const redact = makeRedactor(env);
  let catalog = deps.catalog;
  if (!catalog) {
    try {
      catalog = (await import("./ai.js")).providerCatalog();
    } catch (err) {
      return [R("Settings", "Provider list", "fail", `couldn't load lib/ai.js: ${redact(short(err?.message, 120))}`), ...checkSettings(env)];
    }
  }
  const safe = async (group, fn) => {
    try { return await fn(); } catch (err) { return [R(group, "check", "fail", `check crashed: ${redact(short(err?.message, 100))}`)]; }
  };
  const providers = groupProviders(catalog);
  const groups = await Promise.all([
    Promise.resolve(checkSettings(env)),
    safe("Database", () => checkDatabase(env, deps)),
    safe("Telegram", () => checkTelegram(env)),
    safe("Storage", () => checkStorage(env, deps)),
    safe("Gemini", () => checkGemini(catalog, live)),
    ...providers.map((p) => safe(p.label, () => checkOpenAiProvider(p, env, live))),
    safe("Search", () => checkSearch(env, live)),
  ]);
  return groups.flat().map((r) => ({ ...r, name: redact(r.name), detail: redact(r.detail) }));
}

// ---------------------------------------------------------------------------
// Presentation (plain text — works in a Telegram message and in a terminal)
// ---------------------------------------------------------------------------
const ICON = { ok: "✅", warn: "⚠️", fail: "❌", skip: "⏭️" };

export function summarize(results) {
  const c = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

export function formatReport(results, { live = false, liveHint = "Run a live test (/health live)" } = {}) {
  const order = [];
  const byGroup = new Map();
  for (const r of results) {
    if (!byGroup.has(r.group)) { byGroup.set(r.group, []); order.push(r.group); }
    byGroup.get(r.group).push(r);
  }
  const blocks = order.map((g) => `${g}\n` + byGroup.get(g).map((r) => `${ICON[r.status]} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`).join("\n"));
  const attention = results.filter((r) => r.status === "fail" || r.status === "warn").sort((x, y) => (x.status === "fail" ? 0 : 1) - (y.status === "fail" ? 0 : 1));
  if (attention.length) {
    blocks.push("Needs attention\n" + attention.slice(0, 12).map((r) => `${ICON[r.status]} ${r.group}: ${r.name} — ${short(r.detail, 100)}`).join("\n") + (attention.length > 12 ? `\n…and ${attention.length - 12} more above` : ""));
  }
  const c = summarize(results);
  const headline = c.fail ? `❌ ${c.fail} problem${c.fail === 1 ? "" : "s"} need fixing` : c.warn ? "⚠️ Working, with warnings" : "✅ Everything checked is connected";
  const tail = `${headline}\n${c.ok} ok · ${c.warn} warning${c.warn === 1 ? "" : "s"} · ${c.fail} problem${c.fail === 1 ? "" : "s"} · ${c.skip} not set/skipped\n` +
    (live ? "Live test: each model was asked to reply \"OK\"." : `Quick check: keys and model ids verified for free. ${liveHint} to make each model actually answer.`);
  return `Health check (${live ? "live" : "quick"})\n\n${blocks.join("\n\n")}\n\n${tail}`;
}

// Telegram caps a message at 4096 characters — split on blank lines.
export function splitReport(text, max = 3800) {
  const parts = [];
  let cur = "";
  for (const block of text.split("\n\n")) {
    if (cur && cur.length + block.length + 2 > max) { parts.push(cur); cur = block; }
    else cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) parts.push(cur);
  return parts;
}
