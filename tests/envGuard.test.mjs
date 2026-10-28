// Run from the project folder:  node --no-deprecation tests/envGuard.test.mjs
// A description pasted where a model id belongs ("the 8B Ministral") must not break photos, and /health must say so.

import { execFileSync } from "child_process";
process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const visionModel = (value) => {
  const env = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, MISTRAL_API_KEY: "m", ...(value === undefined ? {} : { MISTRAL_VISION_MODEL: value }) };
  // the photo reader is the last Mistral row in the catalog (after the text rows)
  const code = `const { providerCatalog } = await import("./lib/ai.js"); const r = providerCatalog().openAiCompatible.filter((x) => /mistral/.test(x.baseUrl)); console.log(JSON.stringify(r.at(-1).model));`;
  return JSON.parse(execFileSync(process.execPath, ["--no-deprecation", "--input-type=module", "-e", code], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop());
};
check("unset -> the 8B Ministral id is used for photos", visionModel(undefined) === "ministral-8b-2512", visionModel(undefined));
check("a real id is used as given", visionModel("ministral-14b-2512") === "ministral-14b-2512");
check("a description with spaces ('the 8B Ministral') is ignored and the default id is used", visionModel("the 8B Ministral") === "ministral-8b-2512", visionModel("the 8B Ministral"));
check("an empty or blank value uses the default", visionModel("   ") === "ministral-8b-2512");

const { checkSettings } = await import("../lib/health.js");
const required = { DATABASE_URL: "x", TELEGRAM_BOT_TOKEN: "x", TELEGRAM_WEBHOOK_SECRET: "x", OWNER_CHAT_ID: "1", MINI_APP_URL: "https://a.b/miniapp/index.html", GROQ_API_KEY: "x", GEMINI_API_KEY: "x", BLOB_READ_WRITE_TOKEN: "x" };
const text = (rs) => rs.map((r) => `${r.name}|${r.status}|${r.detail}`).join("\n");
{
  const rs = checkSettings({ ...required, MISTRAL_VISION_MODEL: "the 8B Ministral" });
  const bad = rs.find((r) => r.name === "MISTRAL_VISION_MODEL");
  check("/health flags a model setting that has spaces as a problem and says what to do", !!bad && bad.status === "fail" && /no spaces/.test(bad.detail) && /ministral-8b-2512/.test(bad.detail), bad && bad.detail);
  check("a correct model setting is not flagged", !checkSettings({ ...required, MISTRAL_VISION_MODEL: "ministral-14b-2512" }).some((r) => r.name === "MISTRAL_VISION_MODEL"));
}
{
  const off = text(checkSettings(required));
  const on = text(checkSettings({ ...required, CRON_SECRET: "a-long-random-secret-value" }));
  check("CRON_SECRET is listed: reported as not set when missing, as set when present (so a missing cleanup secret is visible)", /Optional keys not set\|skip\|[^\n]*CRON_SECRET/.test(off) && /Optional keys set\|ok\|[^\n]*CRON_SECRET/.test(on), off.split("\n").find((l) => /not set/.test(l)));
  check("the new settings are listed under built-in defaults until set", /Using built-in defaults\|skip\|[^\n]*EARLY_ACCESS_SLOTS[^\n]*STORAGE_FREE_MB/.test(off) && !/Using built-in defaults\|skip\|[^\n]*EARLY_ACCESS_SLOTS/.test(text(checkSettings({ ...required, EARLY_ACCESS_SLOTS: "20" }))));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
