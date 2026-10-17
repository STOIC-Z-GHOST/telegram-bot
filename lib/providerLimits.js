// "What can each of my keys actually use?" — the models each key can see and the limits each provider will tell us.
// Different from /health (is it working?) and from lib/limits.js (the bot's own per-user plan caps): this asks the
// PROVIDERS how much of their service your keys allow.
//
// What each provider really exposes (nothing here is guessed):
//   Groq        every response carries x-ratelimit-* headers: limit-requests = requests PER DAY, limit-tokens = tokens PER MINUTE
//   Mistral     x-ratelimit-limit-req-minute on responses (0 = your plan has no access to that model)
//   OpenRouter  GET /key -> usage, limit, free-tier flag
//   Tavily      GET /usage -> credits used / allowed
//   Cloudflare  no limit headers; lists the models; the free allowance is in neurons per day (not readable from the API)
//   Gemini      no limit headers; lists models + token limits; the real per-model limits are on the AI Studio rate-limit page.
//               A 429 body does say which quota was hit, so a probe prints that.
//   Z.ai        no documented limit headers; we print any x-ratelimit-* it happens to send
//
// Costs: the model lists are free. Chat probes are ONE tiny request each ("hi", max 5 tokens). OpenRouter is never probed
// (50 free requests a day) and Gemini only with probeGemini (its main model has a very small daily allowance).

import { CF_STAYS_ACTIVE } from "./knownModels.js";

const HEADER_RE = /^(x-ratelimit|ratelimit|retry-after)/i;

function limitHeaders(headers) {
  const out = {};
  try { headers?.forEach?.((v, k) => { if (HEADER_RE.test(k)) out[k.toLowerCase()] = v; }); } catch { /* no headers */ }
  return out;
}

async function call(fetchImpl, url, { headers = {}, method = "GET", body } = {}) {
  const started = Date.now();
  try {
    const resp = await fetchImpl(url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: resp.status, ok: resp.ok, json, text, limits: limitHeaders(resp.headers), ms: Date.now() - started };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: "", limits: {}, ms: Date.now() - started, error: String(e?.message || e).slice(0, 100) };
  }
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const bearer = (key, extra) => ({ Authorization: `Bearer ${key}`, ...(extra || {}) });
const errText = (r) => String(r.json?.error?.message || r.json?.message || r.json?.errors?.[0]?.message || r.error || r.text || "").replace(/\s+/g, " ").slice(0, 90);

// Friendly names for the headers we know; unknown ones are printed as the provider sent them.
const LABELS = {
  Groq: { "x-ratelimit-limit-requests": "requests/day", "x-ratelimit-limit-tokens": "tokens/min", "x-ratelimit-remaining-requests": "requests/day left", "x-ratelimit-remaining-tokens": "tokens/min left" },
  Mistral: { "x-ratelimit-limit-req-minute": "requests/min", "x-ratelimit-remaining-req-minute": "requests/min left", "x-ratelimit-limit-tokens-minute": "tokens/min", "x-ratelimit-remaining-tokens-minute": "tokens/min left" },
};
function limitText(provider, limits) {
  return Object.entries(limits)
    .filter(([k]) => !/reset|query-cost/.test(k)) // reset timers and the cost of this tiny test are noise here
    .map(([k, v]) => `${LABELS[provider]?.[k] || k.replace(/^x-ratelimit-/, "")}: ${v}`)
    .join(", ");
}

function verdict(r) {
  const zero = String(r.limits["x-ratelimit-limit-req-minute"]).trim() === "0";
  if (r.status === 200) return { state: "ok", text: "works" };
  if (r.status === 429 && zero) return { state: "blocked", text: "BLOCKED — 0 requests a minute on your plan" };
  if (r.status === 429) return { state: "busy", text: `rate-limited right now (429)${errText(r) ? ` — ${errText(r)}` : ""}` };
  if (r.status === 403) return { state: "blocked", text: "not available on your plan (403)" };
  if (r.status === 401) return { state: "bad", text: "key rejected (401)" };
  if (r.status === 0) return { state: "bad", text: `no answer${r.error ? ` (${r.error})` : ""}` };
  return { state: "bad", text: `HTTP ${r.status}${errText(r) ? `: ${errText(r)}` : ""}` };
}

async function probeChat(fetchImpl, base, key, model, extraHeaders) {
  return call(fetchImpl, `${base}/chat/completions`, { method: "POST", headers: bearer(key, extraHeaders), body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 } });
}

const section = (title) => ({ title, models: [], notes: [], error: null });
const listFailed = (r) => `couldn't list models — ${verdict(r).text}${errText(r) ? `: ${errText(r)}` : ""}`;

// ---------- providers ----------

async function groq(ctx, rows) {
  const s = section("Groq");
  const { fetchImpl, all } = ctx;
  const { baseUrl, apiKey } = rows[0];
  const list = await call(fetchImpl, `${baseUrl}/models`, { headers: bearer(apiKey) });
  if (!list.ok) { s.error = listFailed(list); return s; }
  const mine = new Set([...rows.map((r) => r.model), "whisper-large-v3-turbo"]); // the last one is the voice model (lib/transcribe.js)
  const models = (list.json?.data || []).filter((m) => m.active !== false).sort((a, b) => (mine.has(b.id) - mine.has(a.id)) || a.id.localeCompare(b.id));
  const chatish = (id) => !/whisper|guard|tts|playai|orpheus/i.test(id);
  for (const m of models) {
    const entry = { id: m.id, bot: mine.has(m.id), info: [m.context_window ? `context ${m.context_window}` : "", m.max_completion_tokens ? `max output ${m.max_completion_tokens}` : ""].filter(Boolean).join(", ") };
    if ((entry.bot || all) && chatish(m.id)) {
      const r = await probeChat(fetchImpl, baseUrl, apiKey, m.id);
      Object.assign(entry, verdict(r), { limits: limitText("Groq", r.limits) });
    }
    s.models.push(entry);
  }
  s.notes.push("requests/day and tokens/min are PER MODEL. The same numbers are in the Groq console under Settings → Limits");
  if (!all) s.notes.push("Only the models the bot uses were asked; add --all to ask every chat model (one tiny request each).");
  return s;
}

async function mistral(ctx, rows) {
  const s = section("Mistral");
  const { fetchImpl } = ctx;
  const { baseUrl, apiKey } = rows[0];
  const list = await call(fetchImpl, `${baseUrl}/models`, { headers: bearer(apiKey) });
  if (!list.ok) { s.error = listFailed(list); return s; }
  const mine = new Set(rows.map((r) => r.model));
  const seen = new Set();
  const chat = [];
  for (const m of list.json?.data || []) {
    if (!m.capabilities?.completion_chat || seen.has(m.billing_model_name || m.id)) continue;
    seen.add(m.billing_model_name || m.id);
    // the bot may use any alias of this model, so mark it if the id or an alias matches
    chat.push({ m, bot: mine.has(m.id) || (m.aliases || []).some((a) => mine.has(a)) });
  }
  chat.sort((a, b) => (b.bot - a.bot) || a.m.id.localeCompare(b.m.id));
  for (const { m, bot } of chat) {
    const r = await probeChat(fetchImpl, baseUrl, apiKey, m.id); // limits are per model, so one request each is well inside them
    s.models.push({ id: m.id, bot, info: [m.max_context_length ? `context ${m.max_context_length}` : "", m.capabilities?.vision ? "vision" : "", m.capabilities?.reasoning ? "reasoning" : ""].filter(Boolean).join(", "), ...verdict(r), limits: limitText("Mistral", r.limits) });
  }
  s.notes.push("requests/min is per model. 'BLOCKED' = the plan allows 0, so waiting never helps.");
  return s;
}

async function openrouter(ctx, rows) {
  const s = section("OpenRouter");
  const { fetchImpl } = ctx;
  const { apiKey } = rows[0];
  const base = "https://openrouter.ai/api/v1";
  let key = await call(fetchImpl, `${base}/key`, { headers: bearer(apiKey) });
  if (!key.ok) key = await call(fetchImpl, `${base}/auth/key`, { headers: bearer(apiKey) });
  if (!key.ok) { s.error = `key check failed — ${verdict(key).text}`; return s; }
  const d = key.json?.data || {};
  // d.label is a masked fragment of the key itself ("sk-or-v1-7a8...320") and d.rate_limit is flagged deprecated: print neither.
  const bits = [d.is_free_tier !== undefined ? `free tier: ${d.is_free_tier ? "yes" : "no"}` : "", d.usage !== undefined ? `used: $${d.usage}` : "", d.limit !== undefined ? `spend limit: ${d.limit === null ? "none" : `$${d.limit}`}` : ""].filter(Boolean);
  s.notes.push(bits.join(" · ") || "key accepted");
  const list = await call(fetchImpl, `${base}/models`, { headers: bearer(apiKey) });
  const mine = new Set(rows.map((r) => r.model));
  const free = (list.json?.data || []).filter((m) => /:free$/.test(m.id));
  for (const m of free.sort((a, b) => (mine.has(b.id) - mine.has(a.id)) || a.id.localeCompare(b.id))) s.models.push({ id: m.id, bot: mine.has(m.id), info: m.context_length ? `context ${m.context_length}` : "", text: "free model", state: "info" });
  s.notes.push("Free models are shared pools: usually 20 requests/min and ~50 requests/day on a free account (more once you've added credits). Not probed, to keep your daily requests.");
  return s;
}

async function cloudflare(ctx, rows, env) {
  const s = section("Cloudflare Workers AI");
  const { fetchImpl } = ctx;
  const id = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_API_TOKEN;
  if (!id || !token) { s.error = "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set"; return s; }
  const api = `https://api.cloudflare.com/client/v4/accounts/${id}/ai/models/search`;
  const mine = new Set(rows.map((r) => r.model));
  const all = [];
  for (let page = 1; page <= 6; page++) {
    const r = await call(fetchImpl, `${api}?per_page=100&page=${page}`, { headers: bearer(token) });
    if (!r.ok) { if (page === 1) { s.error = listFailed(r); return s; } break; }
    const batch = r.json?.result || [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  const taskOf = (m) => m.task?.name || "other";
  const counts = {};
  for (const m of all) counts[taskOf(m)] = (counts[taskOf(m)] || 0) + 1;
  for (const m of all.filter((x) => mine.has(x.name))) s.models.push({ id: m.name, bot: true, info: taskOf(m), state: "info", text: "in the catalog" });
  for (const mid of [...mine].filter((x) => !all.some((m) => m.name === x))) {
    if (CF_STAYS_ACTIVE.has(mid)) s.models.push({ id: mid, bot: true, info: "", state: "info", text: "not in the catalog search, but Cloudflare's own notice says it stays active" });
    else s.models.push({ id: mid, bot: true, info: "", state: "gone", text: "NOT in the catalog listing (may be an alias, or deprecated)" });
  }
  s.notes.push(`Catalog: ${all.length} models — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (ctx.all) s.notes.push(`Text Generation models you could use: ${all.filter((m) => taskOf(m) === "Text Generation").map((m) => m.name.replace(/^@cf\//, "")).join(", ")}`);
  else s.notes.push("Add `all` (/limits all) to list every Text Generation model.");
  s.notes.push("Cloudflare sends no limit headers. As far as I know the free allowance is about 10,000 neurons a day (resets 00:00 UTC); /health shows the bot's own count against its 9,000 cap.");
  return s;
}

async function gemini(ctx, g) {
  const s = section("Google Gemini");
  const { fetchImpl, probeGemini } = ctx;
  if (!g.apiKey) { s.error = "GEMINI_API_KEY not set"; return s; }
  const api = "https://generativelanguage.googleapis.com/v1beta";
  const headers = { "x-goog-api-key": g.apiKey };
  const list = await call(fetchImpl, `${api}/models?pageSize=1000`, { headers });
  if (!list.ok) { s.error = listFailed(list); return s; }
  const mine = [g.primary, g.fallback, ...(g.extra || [])].filter(Boolean);
  const bare = (n) => String(n).replace(/^models\//, "");
  const byId = new Map((list.json?.models || []).map((m) => [bare(m.name), m]));
  for (const id of mine) {
    const m = byId.get(id);
    s.models.push({ id, bot: true, state: m ? "info" : "gone", text: m ? "available to your key" : "NOT in your key's model list", info: m ? `input ${m.inputTokenLimit ?? "?"}, output ${m.outputTokenLimit ?? "?"} tokens` : "" });
  }
  const others = [...byId.entries()].filter(([id, m]) => !mine.includes(id) && (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/.test(id));
  s.notes.push(ctx.all
    ? `${others.length} other Gemini models can generate text on your key: ${others.map(([id]) => id).join(", ") || "none"}`
    : `${others.length} other Gemini models can generate text on your key (e.g. ${others.slice(0, 4).map(([id]) => id).join(", ") || "none"}; add \`all\` to list them).`);
  s.notes.push("Google sends no limit headers. Your real per-model limits (requests/min, tokens/min, requests/day) are on the AI Studio 'rate limit' page for the project — read them there.");
  if (probeGemini && g.fallback) {
    const r = await call(fetchImpl, `${api}/models/${g.fallback}:generateContent`, { method: "POST", headers, body: { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } } });
    const v = verdict(r);
    let extra = "";
    if (r.status === 429) {
      const details = r.json?.error?.details || [];
      const quota = details.flatMap((d) => d.violations || []).map((x) => x.quotaId || x.quotaMetric).filter(Boolean);
      const retry = details.map((d) => d.retryDelay).find(Boolean);
      extra = `${quota.length ? ` quota hit: ${[...new Set(quota)].join(", ")}` : ""}${retry ? ` · retry in ${retry}` : ""}`;
    }
    const entry = s.models.find((x) => x.id === g.fallback);
    if (entry) Object.assign(entry, { state: v.state, text: `${v.text}${extra}` });
  } else {
    s.notes.push("Not asked (the main model's free daily allowance is small). Add --probe-gemini to send ONE tiny request to the lite model.");
  }
  return s;
}

async function tavily(ctx, env) {
  const s = section("Tavily (web search)");
  if (!env.TAVILY_API_KEY) { s.error = "TAVILY_API_KEY not set"; return s; }
  const r = await call(ctx.fetchImpl, "https://api.tavily.com/usage", { headers: bearer(env.TAVILY_API_KEY) });
  if (!r.ok) { s.error = `usage lookup failed — ${verdict(r).text}`; return s; }
  const k = r.json?.key || {}, a = r.json?.account || {};
  s.notes.push(`this key: ${k.usage ?? "?"} credits used this billing cycle${k.limit ? ` of its ${k.limit} cap` : " (no cap set on the key itself)"}`);
  if (a.current_plan || a.plan_limit !== undefined) {
    const left = Number.isFinite(a.plan_limit) && Number.isFinite(a.plan_usage) ? `, ${a.plan_limit - a.plan_usage} left` : "";
    s.notes.push(`account plan: ${a.current_plan || "?"} — ${a.plan_usage ?? "?"} of ${a.plan_limit ?? "?"} credits used${left}${a.paygo_limit ? ` (pay-as-you-go: ${a.paygo_usage ?? 0} of ${a.paygo_limit})` : ""}`);
  }
  s.notes.push("1 credit per basic search. /health spends 1 credit per live run.");
  return s;
}

async function zai(ctx, rows) {
  const s = section("Z.ai");
  const { baseUrl, apiKey } = rows[0];
  for (const m of [...new Set(rows.map((r) => r.model))]) {
    const r = await probeChat(ctx.fetchImpl, baseUrl, apiKey, m, rows[0].extraHeaders);
    s.models.push({ id: m, bot: true, ...verdict(r), limits: limitText("Z.ai", r.limits) });
  }
  s.notes.push("Z.ai documents no limit headers, so only status and any x-ratelimit-* it sends are shown (a vision model is asked with text here).");
  return s;
}

// ---------- entry point ----------

export async function runProviderLimits({ env, catalog, fetchImpl = globalThis.fetch, all = false, probeGemini = false }) {
  const ctx = { fetchImpl, all, probeGemini };
  const byHost = new Map();
  for (const row of catalog.openAiCompatible) {
    const host = hostOf(row.baseUrl);
    if (!host || !row.apiKey) continue; // an unconfigured provider has nothing to ask
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(row);
  }
  const pick = (re) => [...byHost.entries()].find(([h]) => re.test(h))?.[1];
  // One job per provider. Providers run AT THE SAME TIME (inside one provider the probes stay one after another),
  // so the whole report takes as long as the slowest provider — it has to fit inside a Telegram webhook's 60 seconds.
  const jobs = [];
  const g = pick(/groq\.com$/); if (g) jobs.push(() => groq(ctx, g));
  const m = pick(/mistral\.ai$/); if (m) jobs.push(() => mistral(ctx, m));
  const o = pick(/openrouter\.ai$/); if (o) jobs.push(() => openrouter(ctx, o));
  const c = pick(/cloudflare\.com$/); if (c || (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID)) jobs.push(() => cloudflare(ctx, c || [], env));
  if (catalog.gemini?.apiKey) jobs.push(() => gemini(ctx, catalog.gemini));
  const z = pick(/z\.ai$/); if (z) jobs.push(() => zai(ctx, z));
  if (env.TAVILY_API_KEY) jobs.push(() => tavily(ctx, env));
  const out = await Promise.all(jobs.map(async (job) => {
    try { return await job(); } catch (e) { return { ...section("(internal error)"), error: String(e?.message || e).slice(0, 120) }; }
  }));
  return out;
}

const ICON = { ok: "✅", busy: "💤", blocked: "🚫", bad: "❌", info: "•", gone: "⚠️" };

export function formatProviderLimits(sections) {
  const lines = ["What each key can use (★ = a model the bot uses)", ""];
  for (const s of sections) {
    lines.push(`== ${s.title} ==`);
    if (s.error) lines.push(`  ❌ ${s.error}`);
    for (const m of s.models) {
      const head = `  ${m.bot ? "★" : " "} ${ICON[m.state] || " "} ${m.id}`;
      const detail = [m.text, m.info && `(${m.info})`, m.limits && `— ${m.limits}`].filter(Boolean).join(" ");
      lines.push(detail ? `${head}  ${detail}` : head);
    }
    for (const n of s.notes) lines.push(`  · ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}
