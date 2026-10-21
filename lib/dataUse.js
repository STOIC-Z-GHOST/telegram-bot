// lib/dataUse.js
//
// "Extended models": which AI providers may keep, use or let staff read what people send them ("shared"), and which
// publish a promise not to ("private"), plus the one piece of wording every surface shows. No database in here, so the
// mini app API, the DM bot, /limits and the tests can all import it.
//
// A person who has NOT turned Extended models on (or has not answered yet) is only ever served by private providers. A
// person who has turned it on also gets the shared ones. See lib/dataSharing.js for where the choice is stored.
//
// What is known about each provider (checked 18 Oct 2026 against the providers' own pages unless noted):
//   groq        private  no training on API data; requests may be logged ~30 days for abuse checks unless Zero Data Retention is on
//   cloudflare  private  Workers AI content is not used to train any model or improve any service
//   mistral     private  ONLY while the training switch in the Mistral console (Admin -> Privacy) is OFF — the owner turned it off.
//                        If it is ever turned back on, add "mistral" to SHARED_DATA_PROVIDERS.
//   gemini      shared   the free (unpaid) Gemini API may use content to improve Google products and human reviewers may read it.
//                        It becomes a "Paid Service" (no training) only when the Google Cloud project that owns the API key has an
//                        active billing account; Google then bills usage from a prepaid balance (it is NOT free any more). Only then
//                        remove "gemini" from SHARED_DATA_PROVIDERS. Google's terms (23 Mar 2026) also say unpaid Gemini must not
//                        serve people in the EEA / Switzerland / UK, and the app must not be likely to be used by under-18s.
//   openrouter  shared   free routes differ per model (the free NVIDIA one logs prompts to improve NVIDIA products). OpenRouter has
//                        an account setting for free models ("allow providers that may train") that decides which routes are used
//   zai         shared   no published promise found, so treated as shared
// Any provider this file does not know is treated as shared.

// Bump this when the wording below changes in a way that matters: everyone who said "yes" to the old wording is asked again
// (and until they answer they are treated as "no"). A "no" never needs re-asking.
export const DATA_SHARING_VERSION = 1;

const KNOWN = new Set(["groq", "cloudflare", "mistral", "gemini", "openrouter", "zai"]);
const DEFAULT_SHARED = "gemini,openrouter,zai";

// The providers that count as shared. SHARED_DATA_PROVIDERS="gemini,openrouter,zai" is the default; set it to change what
// the switch controls. An empty value means nothing is shared.
export function sharedProviderKeys(env = process.env) {
  const raw = env.SHARED_DATA_PROVIDERS ?? DEFAULT_SHARED;
  return new Set(String(raw).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// A provider row from lib/ai.js (it has a baseUrl) or the literal "gemini".
export function providerKeyOf(provider) {
  if (provider === "gemini") return "gemini";
  let host = "";
  try { host = new URL(provider?.baseUrl || "").host.toLowerCase(); } catch { /* no URL */ }
  if (/(^|\.)groq\.com$/.test(host)) return "groq";
  if (/(^|\.)cloudflare\.com$/.test(host)) return "cloudflare";
  if (/(^|\.)mistral\.ai$/.test(host)) return "mistral";
  if (/(^|\.)openrouter\.ai$/.test(host)) return "openrouter";
  if (/(^|\.)z\.ai$/.test(host)) return "zai";
  if (/googleapis\.com$/.test(host)) return "gemini";
  return host || null;
}

export function isSharedProvider(provider, env = process.env) {
  const key = providerKeyOf(provider);
  if (!key || !KNOWN.has(key)) return true; // unknown = assume it may keep data
  return sharedProviderKeys(env).has(key);
}

export const dataUseOf = (provider, env = process.env) => (isSharedProvider(provider, env) ? "shared" : "private");

// ---- the wording (one copy, used by the mini app, the DM bot and the tests) ----

export const DATA_SHARING_COPY = {
  title: "Extended models",
  // One honest line next to the switch: what you get AND what it costs you.
  badge: "More models",
  summary: "You get more models when this is on. Some run on free services from other companies, which may keep your chats and use them to improve their AI.",
  detailsButton: "Details",
  hideDetailsButton: "Hide details",
  details: [
    { heading: "What you get when it's on", text: "Extra models: Premium's Extra tier, a backup when the main models are busy, and a stronger model for reading photos and PDFs. Answers can be better and you'll hit \"busy\" less often." },
    { heading: "What it means for your chats", text: "The extra models run on free services from other companies. Those companies may keep your messages and the replies, use them to improve their own AI, and in some cases let their staff read them. We can't control that." },
    { heading: "When it's off", text: "Your chats only go to models whose providers say they don't train on your data. You keep Flash, Standard and Max. You lose Extra, photos and documents are read by a simpler method, and replies can be slower when things are busy." },
    { heading: "Never share sensitive information", text: "Don't send passwords, ID or bank details, health records, or other people's private details, whether this is on or off. Even private providers may keep requests briefly to check for abuse." },
    { heading: "Photos, files and voice", text: "They follow the same switch. When it's off they only go to the private models." },
    { heading: "You're in control", text: "Change it any time in Settings. It applies to messages you send after you change it; it can't take back what was already sent. Extended models is for people 18 and over." },
  ],
  allowButton: "Turn on Extended models",
  denyButton: "Keep my chats private",
};

// Plain text for the DM bot (Telegram messages have no expandable panels).
export function dataSharingDmText({ withDetails = false } = {}) {
  const c = DATA_SHARING_COPY;
  const head = `🧩 ${c.title}\n\n${c.summary}`;
  if (!withDetails) return `${head}\n\nTap Details to read exactly what that means, or choose now.`;
  return `${head}\n\n${c.details.map((d) => `• ${d.heading}: ${d.text}`).join("\n\n")}`;
}
