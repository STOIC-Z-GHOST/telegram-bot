// Run from the project folder:  node --no-deprecation tests/dataSharing.test.mjs
// Checks the "Extended models" privacy setting (no network, no database):
//   - which providers count as shared, and that an unknown provider fails closed
//   - how a stored answer is read (never asked = no; yes to old wording = no)
//   - the wording (no provider names, benefit first, sensitive-data warning, 18+)
//   - that text, photos/PDFs, voice and web search NEVER reach a shared provider unless the person said yes
//   - that the /limits report tags every provider

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const { isSharedProvider, dataUseOf, sharedProviderKeys, providerKeyOf, DATA_SHARING_COPY, DATA_SHARING_VERSION, dataSharingDmText } = await import("../lib/dataUse.js");
const { dataSharingFromRow } = await import("../lib/dataSharing.js");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

// ---- which providers are shared
const row = (baseUrl) => ({ baseUrl });
check("Groq, Cloudflare and Mistral are private by default",
  !isSharedProvider(row("https://api.groq.com/openai/v1")) && !isSharedProvider(row("https://api.cloudflare.com/client/v4/accounts/x/ai/v1")) && !isSharedProvider(row("https://api.mistral.ai/v1")));
check("Gemini, OpenRouter and Z.ai are shared by default",
  isSharedProvider("gemini") && isSharedProvider(row("https://openrouter.ai/api/v1")) && isSharedProvider(row("https://api.z.ai/api/paas/v4")));
check("the Gemini API host is recognised as Gemini", providerKeyOf(row("https://generativelanguage.googleapis.com/v1beta")) === "gemini");
check("a provider nobody has classified (ModelScope, Pollinations, anything new) counts as shared",
  isSharedProvider(row("https://api-inference.modelscope.cn/v1")) && isSharedProvider(row("https://image.pollinations.ai/prompt")) && isSharedProvider(row("https://new-provider.example/v1")));
check("a row with no usable URL counts as shared", isSharedProvider({}) && isSharedProvider(null) && isSharedProvider(row("not a url")));
check("dataUseOf says 'shared' / 'private'", dataUseOf("gemini") === "shared" && dataUseOf(row("https://api.groq.com/x")) === "private");
check("SHARED_DATA_PROVIDERS changes the list (billing linked -> gemini removed; Mistral switch back on -> mistral added)",
  !isSharedProvider("gemini", { SHARED_DATA_PROVIDERS: "openrouter,zai" }) && isSharedProvider(row("https://api.mistral.ai/v1"), { SHARED_DATA_PROVIDERS: "gemini, Mistral" }));
check("an empty SHARED_DATA_PROVIDERS shares nothing known, but unknown providers still count as shared",
  sharedProviderKeys({ SHARED_DATA_PROVIDERS: "" }).size === 0 && !isSharedProvider("gemini", { SHARED_DATA_PROVIDERS: "" }) && isSharedProvider(row("https://new-provider.example/v1"), { SHARED_DATA_PROVIDERS: "" }));

// ---- how a stored answer is read
const fresh = dataSharingFromRow(undefined);
check("never asked (no row) = NO, and they will be asked", fresh.allow === false && fresh.needsAnswer === true && fresh.choice === null);
check("a row from before this feature (column empty) = NO, and they will be asked", dataSharingFromRow({ dataSharing: null }).allow === false && dataSharingFromRow({ dataSharing: null }).needsAnswer === true);
const no = dataSharingFromRow({ dataSharing: false, dataSharingVersion: DATA_SHARING_VERSION });
check("an answer of NO is final: not allowed, not asked again", no.allow === false && no.needsAnswer === false && no.choice === false);
const yes = dataSharingFromRow({ dataSharing: true, dataSharingVersion: DATA_SHARING_VERSION });
check("YES to the current wording = allowed, not asked again", yes.allow === true && yes.needsAnswer === false && yes.choice === true);
const old = dataSharingFromRow({ dataSharing: true, dataSharingVersion: DATA_SHARING_VERSION - 1 });
check("YES to OLDER wording does not count: not allowed, asked again", old.allow === false && old.needsAnswer === true && old.choice === null);
check("YES with no recorded wording version does not count", dataSharingFromRow({ dataSharing: true }).allow === false);
check("a NO to older wording still stays NO and is not re-asked", dataSharingFromRow({ dataSharing: false, dataSharingVersion: 0 }).needsAnswer === false);
check("garbage in the column (a string) is treated as never asked", dataSharingFromRow({ dataSharing: "true", dataSharingVersion: DATA_SHARING_VERSION }).allow === false);

// ---- the wording
const allCopy = JSON.stringify(DATA_SHARING_COPY) + dataSharingDmText({ withDetails: true });
check("the wording never names a provider or model", !/groq|gemini|google|mistral|openrouter|cloudflare|z\.ai|zhipu|glm|nvidia|deepseek|qwen|llama|pollinations|tavily|searx/i.test(allCopy));
check("it says you get more models when it is on", /more models/i.test(DATA_SHARING_COPY.summary) && DATA_SHARING_COPY.badge === "More models");
check("it says other companies may keep the chats and use them to improve their AI", /other companies/i.test(DATA_SHARING_COPY.summary) && /improve/i.test(DATA_SHARING_COPY.summary));
check("it warns against sharing sensitive information, on or off", DATA_SHARING_COPY.details.some((d) => /sensitive/i.test(d.heading) && /whether this is on or off/i.test(d.text)));
check("it is for 18 and over (the provider's terms require it)", DATA_SHARING_COPY.details.some((d) => /18 and over/.test(d.text)) && !/under 16/.test(allCopy));
check("the name, a Details button and a Hide details button exist", DATA_SHARING_COPY.title === "Extended models" && DATA_SHARING_COPY.detailsButton === "Details" && DATA_SHARING_COPY.hideDetailsButton === "Hide details");
check("the two answers are equally plain and neither is pre-selected", DATA_SHARING_COPY.allowButton.length > 0 && DATA_SHARING_COPY.denyButton.length > 0 && !/recommended|best|default/i.test(DATA_SHARING_COPY.allowButton + DATA_SHARING_COPY.denyButton));
check("the DM text has the title and summary, and the long form has every heading",
  dataSharingDmText().includes(DATA_SHARING_COPY.summary) && DATA_SHARING_COPY.details.every((d) => dataSharingDmText({ withDetails: true }).includes(d.heading)));

// ---- end to end with a pretend network: who is called, with and without a yes
const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "_probe_sharing.mjs");
fs.writeFileSync(probe, `
  const calls = [];
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  console.error = (...a) => warns.push(a.join(" "));
  console.log = () => {};
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  const failing = new Set((process.env.FAIL || "").split(",").filter(Boolean));
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url);
    const host = new URL(u).host;
    calls.push(host);
    for (const f of failing) if (host.includes(f)) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    if (host.includes("generativelanguage")) return ok({ candidates: [{ content: { parts: [{ text: "gemini answer" }] } }], usageMetadata: { totalTokenCount: 5 } });
    if (host.includes("groq.com") && u.includes("transcriptions")) return ok({ text: "groq heard this" });
    if (host.includes("tavily") || host.includes("searx")) return new Response("{}", { status: 500 });
    return ok({ choices: [{ message: { content: "private answer" } }], usage: { total_tokens: 5 } });
  };
  const allow = process.env.ALLOW === "1" ? true : process.env.ALLOW === "0" ? false : undefined;
  const opts = allow === undefined ? {} : { allowShared: allow };
  let out;
  const s = process.env.SCENARIO;
  if (s === "text" || s === "extra" || s === "max" || s === "flash") {
    const { getConversationReply } = await import("../lib/ai.js");
    const r = await getConversationReply([{ role: "user", content: "hello" }], {}, { ...opts, tier: s === "text" ? "standard" : s });
    out = { text: r.text };
  } else if (s === "vision" || s === "pdf") {
    const { getVisionReply } = await import("../lib/ai.js");
    const mime = s === "pdf" ? "application/pdf" : "image/png";
    const r = await getVisionReply("what is this", [{ base64: "AAAA", mimeType: mime }], opts);
    out = { text: r.text };
  } else if (s === "voice") {
    const { transcribeAudio } = await import("../lib/transcribe.js");
    try { const r = await transcribeAudio(Buffer.from("abc"), "audio/ogg", opts); out = { text: r.text, provider: r.provider }; } catch (e) { out = { threw: String(e.message).slice(0, 60) }; }
  } else if (s === "search") {
    const { searchWeb } = await import("../lib/search.js");
    const r = await searchWeb("weather today", [{ role: "user", content: "weather today" }], {}, 1, opts);
    out = { result: r ? Object.keys(r).join() : null };
  }
  process.stdout.write("\\n" + JSON.stringify({ ...out, calls: [...new Set(calls)], warns: warns.length }));
`);
const SHARED_HOSTS = /generativelanguage|openrouter\.ai|z\.ai|modelscope/;
const run = (scenario, allow, extra = {}) => {
  const env = { PATH: process.env.PATH, SCENARIO: scenario, DATABASE_URL: "postgres://u:p@localhost.invalid/db",
    GROQ_API_KEY: "g", MISTRAL_API_KEY: "m", OPENROUTER_API_KEY: "o", ZAI_API_KEY: "z", GEMINI_API_KEY: "k", MODELSCOPE_API_KEY: "s",
    CLOUDFLARE_API_TOKEN: "c", CLOUDFLARE_ACCOUNT_ID: "acct", OPENROUTER_IN_STANDARD: "1", ...extra };
  if (allow !== undefined) env.ALLOW = allow ? "1" : "0";
  return JSON.parse(execFileSync(process.execPath, ["--no-deprecation", probe], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
};
const reachedShared = (r) => r.calls.some((h) => SHARED_HOSTS.test(h));
const PRIVATE_DOWN = "groq.com,cloudflare.com,mistral.ai"; // every private text provider fails

try {
  // text
  for (const tier of ["text", "flash", "max", "extra"]) {
    const off = run(tier, false);
    check(`${tier}: without a yes, only private providers are called and an answer still arrives`, !reachedShared(off) && off.text === "private answer", JSON.stringify(off.calls));
  }
  const unset = run("text", undefined);
  check("text: a caller that forgets allowShared is treated as private", !reachedShared(unset) && unset.text === "private answer");
  const extraOn = run("extra", true);
  check("extra WITH a yes: Gemini is tried first", extraOn.calls[0].includes("generativelanguage") && extraOn.text === "gemini answer", JSON.stringify(extraOn.calls));
  const textOn = run("text", true);
  check("standard WITH a yes still uses the private models first (Gemini is only a backup)", !textOn.calls.some((h) => /generativelanguage/.test(h)) && textOn.text === "private answer");

  // when every private provider is down
  const downOff = run("text", false, { FAIL: PRIVATE_DOWN });
  check("every private provider down + no yes: the person gets the 'try again' message and NOTHING shared is called", !reachedShared(downOff) && /try again/i.test(downOff.text), JSON.stringify(downOff));
  const downOn = run("text", true, { FAIL: PRIVATE_DOWN });
  check("every private provider down + a yes: shared providers rescue the reply", reachedShared(downOn) && /answer/.test(downOn.text), JSON.stringify(downOn.calls));

  // photos and PDFs
  const imgOff = run("vision", false);
  check("a photo without a yes goes only to the private vision model (Cloudflare)", !reachedShared(imgOff) && imgOff.calls.some((h) => /cloudflare/.test(h)), JSON.stringify(imgOff.calls));
  const imgOn = run("vision", true);
  check("a photo WITH a yes goes to Gemini first", imgOn.calls[0].includes("generativelanguage") && imgOn.text === "gemini answer", JSON.stringify(imgOn));
  const imgOffDown = run("vision", false, { FAIL: "cloudflare.com" });
  check("a photo, no yes, private vision down: nothing shared is called and the message points at Extended models", !reachedShared(imgOffDown) && /Extended models/.test(imgOffDown.text), JSON.stringify(imgOffDown));
  const pdfOff = run("pdf", false);
  check("a PDF without a yes never reaches a shared provider", !reachedShared(pdfOff), JSON.stringify(pdfOff.calls));

  // voice
  const voiceOff = run("voice", false, { FAIL: "groq.com" });
  check("voice: Groq down + no yes -> it fails rather than sending the audio to Gemini", !voiceOff.calls.some((h) => /generativelanguage/.test(h)) && voiceOff.threw, JSON.stringify(voiceOff));
  const voiceOn = run("voice", true, { FAIL: "groq.com" });
  check("voice: Groq down + a yes -> the Gemini backup transcribes", voiceOn.provider === "gemini", JSON.stringify(voiceOn));
  const voiceFine = run("voice", false);
  check("voice: Groq up -> Groq transcribes for everyone", voiceFine.provider === "groq" && !voiceFine.calls.some((h) => /generativelanguage/.test(h)));

  // web search (SearXNG/Tavily unset -> straight to the Gemini-grounding last resort)
  const sOff = run("search", false);
  check("search: without a yes the whole conversation is never sent to Gemini grounding", sOff.result === null && !sOff.calls.some((h) => /generativelanguage/.test(h)), JSON.stringify(sOff));
  const sUnset = run("search", undefined);
  check("search: a caller that forgets allowShared is treated as private", sUnset.result === null && !sUnset.calls.some((h) => /generativelanguage/.test(h)));
} finally {
  fs.rmSync(probe, { force: true });
}

// ---- /limits tags every provider
{
  const { providerCatalog } = await import("../lib/ai.js");
  const { formatProviderLimits } = await import("../lib/providerLimits.js");
  const cat = providerCatalog();
  check("every provider row in the catalog carries a data-use tag", cat.openAiCompatible.every((r) => r.dataUse === "shared" || r.dataUse === "private") && (cat.gemini.dataUse === "shared"));
  const text = formatProviderLimits([{ title: "Groq", models: [], notes: [], error: null, dataUse: "private" }, { title: "Google Gemini", models: [], notes: [], error: null, dataUse: "shared" }, { title: "Tavily", models: [], notes: [], error: null }]);
  check("/limits marks private providers 🔒, shared ones 🧩, and leaves non-chat services untagged", /== Groq 🔒 ==/.test(text) && /== Google Gemini 🧩 ==/.test(text) && /== Tavily ==/.test(text));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
