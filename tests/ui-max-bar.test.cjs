// Run from the project folder:  node tests/ui-max-bar.test.cjs
// Runs the REAL mini app page (public/miniapp/index.html) in a headless DOM with fake server answers and checks the
// "Max replies" menu bar and the "Compare plans" row. Needs jsdom, which is deliberately NOT a project dependency:
//     npm install --no-save jsdom        (then run this file; without jsdom it just says so and exits 0)

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch { console.log("SKIP  jsdom isn't installed (npm install --no-save jsdom) — UI test not run"); process.exit(0); }
const fs = require("fs");
const path = require("path");
const raw = fs.readFileSync(path.join(__dirname, "..", "public", "miniapp", "index.html"), "utf8");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const baseUsage = { isOwner: false, tier: "pro", paidTier: "pro", trial: null, messageWindow: "hour", messagesUsed: 3, messagesLimit: 100,
  tokensUsed: 120000, maxTokens: 1800000, tokenWindowDays: 30, imagesLast30Days: 0, imageGenPerMonth: 30, maxImagesPerMessage: 10,
  proFileExts: [], canUseProFiles: true, voice: { perDay: 20, used: 0, maxSeconds: 60 }, messagesResetAt: null, tokensResetAt: null };
const lim = (o) => ({ messagesPerDay: 10, messagesPerHour: 100, maxTokens: 1800000, maxFileBytes: 20e6, maxImagesPerMessage: 10, imageGenPerMonth: 30, voicePerDay: 20, voiceSecondsPerDay: 600, filesPerDay: 5, extraPerDay: 0, ...o });
const plans = (free, pro, premium) => ({ limits: { free: lim({ maxPerDay: free }), pro: lim({ maxPerDay: pro }), premium: lim({ maxPerDay: premium, extraPerDay: 10 }) }, prices: { pro: 150, premium: 400 } });

async function page({ usage, plan }) {
  const html = raw.replace('import { upload } from "https://esm.sh/@vercel/blob@2.8.0/client";', "const upload = async () => ({});").replace('<script type="module">', "<script>");
  const errors = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", (e) => errors.push(String(e.message || e).slice(0, 160)));
  const deep = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : deep()), apply: () => deep() });
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://example.test/miniapp/index.html", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.Telegram = { WebApp: new Proxy({ initData: "x=1", initDataUnsafe: { user: { id: 1 } }, colorScheme: "light", themeParams: {}, platform: "web", version: "8.0" }, { get: (t, k) => (k in t ? t[k] : deep()) }) };
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (p) => { const u = String(p); const body = u.includes("/api/miniapp/usage") ? usage : u.includes("/api/miniapp/plans") ? plan : u.includes("/chats") ? { chats: [] } : {}; return { ok: true, status: 200, json: async () => body }; };
    },
  });
  const w = dom.window, d = w.document;
  await new Promise((r) => setTimeout(r, 400));
  const line = d.getElementById("usage-max-line");
  const res = { errors, hidden: line.hidden, text: d.getElementById("usage-max-text").textContent, full: line.classList.contains("full"), warn: line.classList.contains("warn"), fill: d.getElementById("usage-max-fill").style.width };
  d.getElementById("plan-details-btn").click();
  await new Promise((r) => setTimeout(r, 300));
  const rows = [...d.querySelectorAll("#plan-details-table tr")].map((tr) => [...tr.children].map((c) => c.textContent.trim()));
  res.row = rows.find((r) => r[0] === "Max replies/day") || null;
  res.rowAfterTiers = rows.findIndex((r) => r[0] === "Max replies/day") === rows.findIndex((r) => r[0] === "Model tiers") + 1;
  w.close();
  return res;
}

(async () => {
  const soon = new Date(Date.now() + 3 * 3600e3 + 20 * 60e3).toISOString();
  const P = plans(0, 5, 10);

  let r = await page({ usage: { ...baseUsage, tier: "free", paidTier: "free", messageWindow: "day", messagesLimit: 10 }, plan: P });
  check("free: the page runs without script errors", r.errors.length === 0, r.errors.join(" | "));
  check("free: no Max bar (Free has no Max)", r.hidden === true);

  r = await page({ usage: { ...baseUsage, max: { perDay: 5, used: 2, resetAt: null } }, plan: P });
  check("pro 2/5: the bar shows '2 / 5 · last 24h' at 40%", r.hidden === false && r.text === "2 / 5 · last 24h" && r.fill === "40%" && !r.full && !r.warn, JSON.stringify(r));

  r = await page({ usage: { ...baseUsage, max: { perDay: 5, used: 4, resetAt: null } }, plan: P });
  check("pro 4/5: the bar turns amber (80%)", r.warn === true && r.fill === "80%" && !r.full);

  r = await page({ usage: { ...baseUsage, max: { perDay: 5, used: 5, resetAt: soon } }, plan: P });
  check("pro 5/5: red, 'Full', with a countdown to the next Max reply", r.full === true && /^Full · next Max reply in \d+h \d+m$/.test(r.text) && r.fill === "100%", r.text);

  r = await page({ usage: { ...baseUsage, tier: "premium", paidTier: "premium", max: { perDay: 10, used: 7, resetAt: null } }, plan: P });
  check("premium 7/10: '7 / 10 · last 24h' at 70%", r.text === "7 / 10 · last 24h" && r.fill === "70%");

  r = await page({ usage: { ...baseUsage }, plan: plans(0, null, null) });
  check("uncapped plan (owner set 'unlimited'): no bar", r.hidden === true);

  // the Compare-plans table
  r = await page({ usage: { ...baseUsage, max: { perDay: 5, used: 0, resetAt: null } }, plan: P });
  check("plan table: a 'Max replies/day' row with Free —, Pro 5, Premium 10", JSON.stringify(r.row) === JSON.stringify(["Max replies/day", "—", "5", "10"]), JSON.stringify(r.row));
  check("plan table: the row sits right under 'Model tiers'", r.rowAfterTiers === true);
  r = await page({ usage: baseUsage, plan: plans(0, 3, 20) });
  check("plan table follows the server's numbers (env-tunable): Pro 3, Premium 20", JSON.stringify(r.row) === JSON.stringify(["Max replies/day", "—", "3", "20"]), JSON.stringify(r.row));
  r = await page({ usage: baseUsage, plan: plans(0, null, null) });
  check("plan table: no cap -> 'Unlimited'", JSON.stringify(r.row) === JSON.stringify(["Max replies/day", "—", "Unlimited", "Unlimited"]), JSON.stringify(r.row));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
