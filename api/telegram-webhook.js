// api/telegram-webhook.js
//
// Telegram webhook handler — Gemini for text + vision (Groq fallback for
// text only), Pollinations.ai for image generation. Stateless: Vercel spins
// this up per incoming message, so there's no "12 hour" session limit and
// no process to keep running. Always on.
//
// Required environment variables (set in Vercel → Project Settings →
// Environment Variables):
//   TELEGRAM_BOT_TOKEN       your bot token from BotFather
//   OWNER_CHAT_ID            your own numeric chat id — the sole admin who
//                             approves/denies access requests and can
//                             remove people later. Replaces the old
//                             AUTHORIZED_CHAT_IDS static allowlist —
//                             everyone else's access is DB-backed now
//                             (see lib/access.js), reachable through a
//                             request -> approve/deny flow instead of a
//                             fixed list you had to redeploy to change.
//   DATABASE_URL              Neon Postgres — the access list lives here now,
//                             shared with the mini app (see db/schema.js)
//   GEMINI_API_KEY
//   GROQ_API_KEY             from console.groq.com (free API tier, no card)
//   TELEGRAM_WEBHOOK_SECRET  any random string you make up — verifies
//                             incoming requests really came from Telegram
//
// Commands:
//   /start           intro message
//   /image <prompt>  generates an image via Pollinations.ai (also /img)
//   /users           (owner only) lists approved users with a Remove button
//   /upgrade         shows current plan + Pro/Premium options (Telegram Stars,
//                     billed monthly, auto-renewing)
//   send a photo     analyzes it — uses your caption as the question if you
//                     add one, otherwise reads/answers anything written in
//                     the image or describes it
//   send a document  reads PDF, .docx, or plain-text files — uses your
//                     caption as the question if you add one, otherwise
//                     summarizes / answers whatever's in the file
//   anything else    normal text chat (Groq primary for speed, Gemini
//                     fallback) — unless you're not yet approved, in which
//                     case the access-request flow handles it instead
//
// Extra npm dependencies:
//   mammoth               pulls text out of .docx files
//   drizzle-orm           query builder for the shared Postgres access list
//   @neondatabase/serverless   Neon's HTTP driver

import mammoth from "mammoth";
import { fetchWithTimeout } from "../lib/fetchWithTimeout.js";
import { resizeImageIfNeeded } from "../lib/imageResize.js";
import {
  isOwner,
  getOwnerChatId,
  getAccessStatus,
  autoApproveUser,
  startAccessRequest,
  submitAccessReason,
  decideAccessRequest,
  removeUser,
  listApprovedUsers,
} from "../lib/access.js";
import { checkMessageLimit, recordMessageUsage, checkImageGenLimit, recordImageUsage, TIER_LIMITS, limitsFor } from "../lib/limits.js";
import { getUserTier, activateSubscription, getTierPrices, setTierPrice, MAX_PRICE_STARS, SUBSCRIPTION_PERIOD_SECONDS } from "../lib/subscriptions.js";
import {
  referralCodeFor,
  parseReferralPayload,
  recordPendingReferral,
  creditReferralIfPending,
  getCreditedReferralCount,
  getReferralBonus,
  getNextMilestone,
} from "../lib/referrals.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
// e.g. https://your-project.vercel.app/miniapp/index.html — set after the
// mini app is deployed. /start includes an "Open Chat App" button only
// when this is set, so the bot still works fine without it.
const MINI_APP_URL = process.env.MINI_APP_URL;
// Used to build shareable https://t.me/<username>?start=ref_<id> invite
// links for /invite. Without it, /invite falls back to a plain referral
// code the friend can paste in manually.
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

// Model IDs current as of Aug 2026 — swap if your account has different access.
const GEMINI_MODEL = "gemini-3.6-flash";
const GROQ_MODEL = "openai/gpt-oss-120b"; // Groq's current flagship open model (text only)

const PRODUCT_CREDIT = "🤖 @assist_ai — try it free.";

// Free, no-cost way to noticeably improve answer quality without changing
// models (the underlying model is already the strongest one available on
// the free tier — see the README for why "more powerful" mostly means
// better prompting, not a bigger model).
const SYSTEM_PROMPT =
  "You are a helpful, knowledgeable personal assistant chatting over Telegram. " +
  "Give complete, specific answers with real detail — don't artificially " +
  "shorten a good answer just to be brief. Plain text only, no markdown headers " +
  "(Telegram doesn't render them well) — use line breaks and dashes for " +
  "structure instead.";

async function askGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: prompt }] }],
    }),
  }, 20000);
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;
  return { text, tokensUsed };
}

// Same Gemini endpoint, just with an extra inline_data part — Gemini
// natively handles text+image together in one request, no separate
// "vision model" needed.
async function askGeminiVision(prompt, base64Image, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } },
          ],
        },
      ],
    }),
  }, 35000); // the real bottleneck for a complex image/PDF — rebalanced (was 30000, capped too tight against the 60s ceiling once file download time is added in)
  if (!resp.ok) throw new Error(`Gemini vision error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini vision returned no text");
  return text;
}

// Resolves a Telegram file_id to a downloadable URL — photos come in as
// IDs, not URLs, so this is always the first step before fetching one.
async function getTelegramFileUrl(fileId) {
  const resp = await fetchWithTimeout(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
    {},
    8000
  );
  const data = await resp.json();
  if (!data.ok) throw new Error(`getFile failed: ${JSON.stringify(data)}`);
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

async function fetchAsBase64(url) {
  const resp = await fetchWithTimeout(url, {}, 12000);
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
  const mimeType = resp.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await resp.arrayBuffer();
  return { base64: Buffer.from(arrayBuffer).toString("base64"), mimeType };
}

// Returns a Buffer of image bytes for /image generation. Uses
// Pollinations.ai's older image.pollinations.ai endpoint, which — unlike
// the newer gen.pollinations.ai unified API — still works without any API
// key or billing. Rate-limited to roughly 1 request per 15 seconds for
// anonymous use, which is plenty for a single-person bot.
async function askPollinationsImage(prompt) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  const resp = await fetchWithTimeout(url, {}, 30000); // image generation takes longer than text
  if (!resp.ok) throw new Error(`Pollinations error ${resp.status}: ${await resp.text()}`);
  const mimeType = resp.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await resp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

async function askGroq(prompt) {
  const resp = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  }, 20000);
  if (!resp.ok) throw new Error(`Groq error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned no text");
  const tokensUsed = data?.usage?.total_tokens ?? null;
  return { text, tokensUsed };
}

// Groq goes first here (not Gemini) purely for speed — Groq's custom
// hardware is built for low-latency inference, and it was previously only
// ever used as a fallback, so its speed was going unused for the common
// case. Trade-off: Gemini was originally primary because it's the
// strongest model on Gemini's free tier, so this trades a little of that
// quality margin for consistently faster replies. Vision/documents are
// untouched below — they stay Gemini-only either way.
// Returns { text, tokensUsed }.
async function getAiReply(prompt) {
  try {
    return await askGroq(prompt);
  } catch (err) {
    console.warn("Groq failed, falling back to Gemini:", err.message);
    try {
      return await askGemini(prompt);
    } catch (err2) {
      console.error("Gemini also failed:", err2.message);
      return { text: "⚠️ Both Groq and Gemini failed to respond just now — try again in a moment.", tokensUsed: null };
    }
  }
}

// No Groq fallback for vision on purpose: Groq's only current vision model
// (qwen/qwen3.6-27b) is explicitly a preview model in their own docs, and
// their previous stable vision model (Llama 4 Scout) was just deprecated.
// Better to fail clearly than silently hand you a less reliable answer.
// Also used for PDFs sent as documents, since Gemini reads those through
// the exact same inline_data + mimeType mechanism as images.
async function getVisionReply(prompt, base64Image, mimeType) {
  try {
    return await askGeminiVision(prompt, base64Image, mimeType);
  } catch (err) {
    console.error("Gemini vision/document failed:", err.message);
    return `⚠️ Couldn't read that file right now: ${err.message}`;
  }
}

async function sendTypingAction(chatId) {
  try {
    await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }, 8000);
  } catch {
    // A missed typing indicator isn't worth failing the request over.
  }
}

// Telegram rejects any single message over 4096 characters — and used to
// fail completely silently here (no error thrown, nothing sent, nothing
// logged). That's exactly what "ask for a website, typing shows, then
// nothing arrives" looks like: Gemini's full HTML/CSS/JS reply blew past
// 4096 chars, Telegram's API rejected it, and the code never checked.
// Splitting long replies into multiple messages (on line breaks where
// possible) and logging any real failure fixes this for every long reply,
// not just code.
const TELEGRAM_MESSAGE_LIMIT = 4096;

function splitForTelegram(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit; // no line break to cut on — hard cut
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendTelegramMessage(chatId, text, options = {}) {
  for (const chunk of splitForTelegram(text)) {
    const body = { chat_id: chatId, text: chunk };
    if (options.parseMode) body.parse_mode = options.parseMode;
    const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 10000);
    if (!resp.ok) {
      console.error(`sendMessage failed (${resp.status}):`, await resp.text());
    }
  }
}

// Separate from sendTelegramMessage because this one needs a reply_markup
// (the inline button) — not something the normal chat replies ever use.
async function sendStartMessage(chatId) {
  const body = {
    chat_id: chatId,
    text:
      "I'm online — Gemini for chat (Groq backup), /image <description> for pictures, " +
      "send me a photo any time and I'll analyze it, and send me a PDF, .docx, or text " +
      "file and I'll read it too. Send /upgrade any time to see your current plan and raise your limits, " +
      "or /invite to earn more free usage by inviting friends." +
      (MINI_APP_URL ? " There's also a proper chat app now, with saved history." : "") +
      `\n\n${PRODUCT_CREDIT}`,
  };
  if (MINI_APP_URL) {
    body.reply_markup = {
      inline_keyboard: [[{ text: "💬 Open Chat App", web_app: { url: MINI_APP_URL } }]],
    };
  }
  const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 10000);
  if (!resp.ok) {
    console.error(`sendStartMessage failed (${resp.status}):`, await resp.text());
  }
}

// Like sendTelegramMessage, but with an inline keyboard — used for the
// access-request flow and /users. Not chunked through splitForTelegram
// since every message that uses this is short and written by us.
async function sendTelegramMessageWithKeyboard(chatId, text, inlineKeyboard) {
  const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: inlineKeyboard } }),
  }, 10000);
  if (!resp.ok) {
    console.error(`sendMessage(keyboard) failed (${resp.status}):`, await resp.text());
  }
}

// Telegram requires every callback_query to be acknowledged, or the
// button shows a loading spinner on the tapper's end indefinitely.
async function answerCallbackQuery(callbackQueryId, text) {
  const body = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 8000);
  if (!resp.ok) {
    console.error(`answerCallbackQuery failed (${resp.status}):`, await resp.text());
  }
}

// Replaces a message's text (and drops its buttons) — used to turn the
// owner's Approve/Deny prompt into a plain confirmation once they've
// tapped one, so it can't be tapped twice.
async function editMessageText(chatId, messageId, text) {
  const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  }, 10000);
  if (!resp.ok) {
    console.error(`editMessageText failed (${resp.status}):`, await resp.text());
  }
}

function formatDisplayName(from) {
  if (!from) return "Unknown";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return from.username ? `${name} (@${from.username})` : name || `User ${from.id}`;
}

// Handles every inline button tap — a completely different update shape
// from a normal message, so it's routed here before any message-handling
// code even runs.
async function handleCallbackQuery(cq) {
  const chatId = cq.message?.chat?.id;
  const fromId = cq.from?.id;
  const data = cq.data || "";

  if (data === "request_access") {
    await startAccessRequest(fromId, formatDisplayName(cq.from));
    await answerCallbackQuery(cq.id);
    await sendTelegramMessage(chatId, "What's the reason you'd like access? Reply with a short message.");
    return;
  }

  if (data.startsWith("approve:") || data.startsWith("deny:")) {
    if (!isOwner(fromId)) {
      await answerCallbackQuery(cq.id, "Only the bot owner can do that.");
      return;
    }
    const [action, idStr] = data.split(":");
    const targetId = Number(idStr);
    const approved = action === "approve";
    await decideAccessRequest(targetId, approved);
    await answerCallbackQuery(cq.id, approved ? "Approved" : "Denied");
    if (cq.message?.message_id) {
      await editMessageText(chatId, cq.message.message_id, approved ? "✅ Approved" : "❌ Denied");
    }
    await sendTelegramMessage(
      targetId,
      approved ? "🎉 You've been approved! Send /start to begin." : "Your access request was declined."
    );
    return;
  }

  if (data.startsWith("remove:")) {
    if (!isOwner(fromId)) {
      await answerCallbackQuery(cq.id, "Only the bot owner can do that.");
      return;
    }
    const targetId = Number(data.split(":")[1]);
    await removeUser(targetId);
    await answerCallbackQuery(cq.id, "Removed");
    if (cq.message?.message_id) {
      await editMessageText(chatId, cq.message.message_id, "🗑️ Removed");
    }
    await sendTelegramMessage(targetId, "Your access to this bot has been removed.");
    return;
  }

  if (data.startsWith("upgrade:")) {
    const tier = data.split(":")[1]; // "pro" | "premium"
    const prices = await getTierPrices();
    const price = prices[tier];
    if (!price) {
      await answerCallbackQuery(cq.id, "Unknown plan.");
      return;
    }
    await answerCallbackQuery(cq.id);
    await sendStarsInvoice(chatId, tier, price);
    return;
  }

  if (data === "compare_plans") {
    await answerCallbackQuery(cq.id);
    await sendTelegramMessage(chatId, await buildPlanComparisonText(), { parseMode: "HTML" });
    return;
  }

  // Unknown callback_data — still must be acknowledged.
  await answerCallbackQuery(cq.id);
}

// A simple monospace comparison table via HTML's <pre> — Telegram renders
// this with real column alignment, unlike plain text. Pulled from
// TIER_LIMITS directly so it can never drift out of sync with the actual
// enforced limits (this shows base tier numbers — a free user's own
// referral-boosted limits are in /invite, not here). Video generation is
// listed as a row but isn't wired to anything yet; see the README.
async function buildPlanComparisonText() {
  const prices = await getTierPrices();
  const { free, pro, premium } = TIER_LIMITS;
  const fmtMB = (bytes) => `${Math.floor(bytes / (1024 * 1024))}MB`;
  const fmtTokens = (n) => (n >= 1000000 ? `${n / 1000000}M` : `${n / 1000}K`);
  const row = (label, freeVal, proVal, premiumVal) =>
    `${label.padEnd(10)}${String(freeVal).padEnd(12)}${String(proVal).padEnd(12)}${premiumVal}`;

  const lines = [
    row("Plan", "Free", "Pro", "Premium"),
    row("Price", "$0", `${prices.pro} ⭐`, `${prices.premium} ⭐`),
    row("Msgs", `${free.messagesPerDay}/day`, `${pro.messagesPerHour}/hr`, "Unlimited"),
    row("Tokens", fmtTokens(free.maxTokens), fmtTokens(pro.maxTokens), fmtTokens(premium.maxTokens)),
    row("Files", fmtMB(free.maxFileBytes), fmtMB(pro.maxFileBytes), fmtMB(premium.maxFileBytes)),
    row("Imgs/msg", free.maxImagesPerMessage, pro.maxImagesPerMessage, premium.maxImagesPerMessage),
    row("Images/mo", free.imageGenPerMonth, pro.imageGenPerMonth, "Unlimited"),
  ];

  return `<pre>${lines.join("\n")}</pre>\n\n📎 Multi-image messages (Imgs/msg) are a mini app feature — the DM bot still takes one photo per message.\n\n🔗 Free tier numbers above don't include your own /invite bonus.\n\n🎬 Video generation — 🚧 under production, coming to paid plans once there are real subscribers.`;
}

// A Stars invoice with subscription_period set bills every 30 days
// automatically from Telegram's side — no cron job or scheduled task
// needed here. The first charge happens the moment they pay; renewals
// arrive later as their own successful_payment updates, handled below.
async function sendStarsInvoice(chatId, tier, priceStars) {
  const label = tier === "premium" ? "Premium" : "Pro";
  const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendInvoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title: `${label} subscription`,
      description: `${label} tier — higher limits, billed monthly in Telegram Stars. Cancel any time from Telegram's own subscription settings.`,
      payload: `sub:${tier}`,
      currency: "XTR",
      prices: [{ label: `${label} — 1 month`, amount: priceStars }],
      subscription_period: SUBSCRIPTION_PERIOD_SECONDS,
    }),
  }, 10000);
  if (!resp.ok) {
    console.error(`sendInvoice failed (${resp.status}):`, await resp.text());
    await sendTelegramMessage(chatId, "⚠️ Couldn't create that invoice right now — try again in a moment.");
  }
}

async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage) {
  const body = { pre_checkout_query_id: preCheckoutQueryId, ok };
  if (!ok && errorMessage) body.error_message = errorMessage;
  const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 8000);
  if (!resp.ok) {
    console.error(`answerPreCheckoutQuery failed (${resp.status}):`, await resp.text());
  }
}

// Fires for both a brand-new subscription and every automatic 30-day
// renewal — Telegram sends its own successful_payment update for each, so
// there's no cron job here re-charging anyone; this just records whatever
// Telegram already collected.
async function handleSuccessfulPayment(chatId, payment) {
  const tier = (payment.invoice_payload || "").split(":")[1]; // "sub:pro" -> "pro"
  if (tier !== "pro" && tier !== "premium") {
    console.error("successful_payment with unrecognized payload:", payment.invoice_payload);
    return;
  }

  // Telegram's date fields are Unix seconds, not milliseconds.
  const expiresAt = payment.subscription_expiration_date
    ? new Date(payment.subscription_expiration_date * 1000)
    : new Date(Date.now() + SUBSCRIPTION_PERIOD_SECONDS * 1000);

  await activateSubscription(chatId, tier, payment.telegram_payment_charge_id, expiresAt);

  const label = tier === "premium" ? "Premium" : "Pro";
  const isRenewal = payment.is_recurring && !payment.is_first_recurring;
  await sendTelegramMessage(
    chatId,
    isRenewal
      ? `✅ Your ${label} subscription renewed — thanks for sticking around!`
      : `🎉 You're now on ${label}! Higher limits are active immediately.`
  );
}

async function sendTelegramPhoto(chatId, imageBuffer, mimeType, caption) {
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 1024));
  form.append("photo", new Blob([imageBuffer], { type: mimeType }), `image.${ext}`);
  await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  }, 20000);
}

export default async function handler(req, res) {
  // Anything that isn't Telegram POSTing an update (e.g. you opening the
  // URL in a browser) just gets a plain 200 so it doesn't look broken.
  if (req.method !== "POST") {
    res.status(200).send("Telegram AI bot webhook is up.");
    return;
  }

  // Confirms the request actually came from Telegram and not a stranger
  // who found this URL and started POSTing fake updates to it.
  if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    res.status(401).send("Unauthorized");
    return;
  }

  const update = req.body;

  // Inline button taps arrive as a completely different update shape from
  // a message (no update.message at all) — handled entirely separately,
  // before any of the message-shaped logic below even looks at the body.
  if (update?.callback_query) {
    await handleCallbackQuery(update.callback_query);
    res.status(200).send("OK");
    return;
  }

  // Telegram requires answering this within 10 seconds or the charge never
  // goes through. For Stars there's nothing further to validate beyond
  // what we already put in the invoice, so this always approves.
  if (update?.pre_checkout_query) {
    await answerPreCheckoutQuery(update.pre_checkout_query.id, true);
    res.status(200).send("OK");
    return;
  }

  const message = update?.message;
  const chatId = message?.chat?.id;

  if (!chatId) {
    res.status(200).send("OK");
    return;
  }

  // A completed charge — the first payment or one of the automatic 30-day
  // renewals Telegram sends on its own. Handled before the access gate
  // below since a successful payment should never be blocked by access
  // status (by the time someone can pay, they were already approved
  // enough to see /upgrade in the first place, but this stays robust
  // either way).
  if (message.successful_payment) {
    await handleSuccessfulPayment(chatId, message.successful_payment);
    res.status(200).send("OK");
    return;
  }

  const text = message.text;

  // --- Access gate ---
  // The bot is public: anyone not explicitly banned falls straight through
  // to normal handling below on the free tier, no owner review needed.
  // "denied" is the one real gate left — it's what /remove (banning a
  // user) sets, via lib/access.js's decideAccessRequest/removeUser. Any
  // leftover "awaiting_reason"/"pending" rows from before the bot went
  // public are treated the same as a first-time visitor and waved through.
  const accessStatus = isOwner(chatId) ? "owner" : await getAccessStatus(chatId);

  if (accessStatus === "denied") {
    await sendTelegramMessage(
      chatId,
      "Your access to this bot has been revoked. If you think that's a mistake, reach out to the owner directly."
    );
    res.status(200).send("OK");
    return;
  }

  if (accessStatus !== "owner" && accessStatus !== "approved") {
    // "none", "awaiting_reason", or "pending" — auto-approve and continue
    // straight into normal handling below, same request.
    await autoApproveUser(chatId, formatDisplayName(message.from));
  }

  if (text === "/start" || text?.startsWith("/start ")) {
    // A referral deep link looks like https://t.me/<bot>?start=ref_12345 —
    // Telegram delivers that as the text "/start ref_12345". Only the
    // first link a brand-new user clicks ever sticks (see
    // recordPendingReferral) — the /start click itself isn't what earns
    // the referrer credit, though; that happens on this user's next
    // message, below.
    const payload = text.length > 6 ? text.slice(6).trim() : "";
    const referrerId = parseReferralPayload(payload, chatId);
    if (referrerId) {
      await recordPendingReferral(referrerId, chatId);
    }
    await sendStartMessage(chatId);
    res.status(200).send("OK");
    return;
  }

  // Credit any pending referral the moment this user does anything past
  // the initial /start click — safe to call unconditionally, it's a
  // no-op once already credited (or if this user was never referred).
  await creditReferralIfPending(chatId);

  if (text === "/invite") {
    const creditedCount = await getCreditedReferralCount(chatId);
    const bonus = getReferralBonus(creditedCount);
    const nextTier = getNextMilestone(creditedCount);
    const code = referralCodeFor(chatId);
    const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${code}` : null;

    const lines = [
      link
        ? `📨 Invite friends — they get the bot, you get more free usage:\n${link}`
        : `📨 Invite friends — have them send this to the bot:\n/start ${code}`,
      "",
      `Credited invites (last 60 days): ${creditedCount} — counts once a friend sends their first message, not just opens the bot. This rolls forward, so keep inviting to stay near the top of your ladder.`,
      `Current bonus: +${bonus.messagesPerDay} msgs/day, +${bonus.imageGenPerMonth} images/mo, +${bonus.maxAttachmentsPerChat} attachments/chat, +${Math.round(bonus.maxTokens / 1000)}K tokens`,
    ];
    if (nextTier) {
      const need = nextTier.invites - creditedCount;
      lines.push(`${need} more to your next reward at ${nextTier.invites} invites.`);
    } else {
      lines.push("You've hit the top of the referral ladder.");
    }
    await sendTelegramMessage(chatId, lines.join("\n"));
    res.status(200).send("OK");
    return;
  }

  if (text === "/users" && isOwner(chatId)) {
    const users = await listApprovedUsers();
    if (users.length === 0) {
      await sendTelegramMessage(chatId, "No approved users yet.");
    } else {
      const keyboard = users.map((u) => [
        { text: `🗑️ Remove ${u.displayName || u.telegramUserId}`, callback_data: `remove:${u.telegramUserId}` },
      ]);
      await sendTelegramMessageWithKeyboard(chatId, `Approved users (${users.length}):`, keyboard);
    }
    res.status(200).send("OK");
    return;
  }

  if (text === "/upgrade") {
    const currentTier = await getUserTier(chatId);
    if (currentTier === "owner") {
      await sendTelegramMessage(chatId, "You're the owner — no limits to raise.");
    } else {
      const prices = await getTierPrices();
      const tierLine = currentTier === "free" ? "You're currently on the Free tier." : `You're currently on ${currentTier[0].toUpperCase()}${currentTier.slice(1)}.`;
      await sendTelegramMessageWithKeyboard(
        chatId,
        `${tierLine} Pick a plan — billed monthly in Telegram Stars, starting today, renewing automatically every 30 days:`,
        [
          [{ text: `⭐ Pro — ${prices.pro} Stars/month`, callback_data: "upgrade:pro" }],
          [{ text: `⭐ Premium — ${prices.premium} Stars/month`, callback_data: "upgrade:premium" }],
          [{ text: "📊 Compare plans", callback_data: "compare_plans" }],
        ]
      );
    }
    res.status(200).send("OK");
    return;
  }

  if (text === "/plans") {
    await sendTelegramMessage(chatId, await buildPlanComparisonText(), { parseMode: "HTML" });
    res.status(200).send("OK");
    return;
  }

  const setPriceMatch = isOwner(chatId) && text?.match(/^\/setprice\s+(pro|premium)\s+(\d+)/i);
  if (setPriceMatch) {
    const tier = setPriceMatch[1].toLowerCase();
    const amount = Number(setPriceMatch[2]);
    if (amount < 1 || amount > MAX_PRICE_STARS) {
      await sendTelegramMessage(chatId, `Price has to be between 1 and ${MAX_PRICE_STARS} Stars — that's Telegram's own limit, not ours.`);
    } else {
      await setTierPrice(tier, amount);
      await sendTelegramMessage(chatId, `Done — ${tier} is now ${amount} Stars/month. Takes effect immediately, no redeploy needed.`);
    }
    res.status(200).send("OK");
    return;
  }
  if (isOwner(chatId) && /^\/setprice\b/i.test(text || "")) {
    await sendTelegramMessage(chatId, "Send it like: /setprice pro 300");
    res.status(200).send("OK");
    return;
  }

  // Photo message (with or without a caption).
  if (message.photo && message.photo.length) {
    const largest = message.photo[message.photo.length - 1]; // last = highest res
    const question =
      (message.caption || "").trim() ||
      "Look at this image. If it contains a question, problem, or text to solve " +
        "(like a screenshot of homework, a quiz, or a math problem), read it and " +
        "answer it directly. Otherwise, describe what's in the image.";

    try {
      sendTypingAction(chatId); // fire-and-forget — already swallows its own errors
      const fileUrl = await getTelegramFileUrl(largest.file_id);
      const resp = await fetchWithTimeout(fileUrl, {}, 12000);
      if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      // Telegram re-compresses every "photo" upload to JPEG server-side,
      // regardless of the original format — but its file-download server
      // doesn't reliably report that back in Content-Type. Trusting that
      // header was the actual bug: a wrong/generic mime type meant Gemini
      // couldn't decode the bytes as an image, and described the raw data
      // instead ("pasted as raw code"). Hardcoding it is more reliable.
      const { buffer, mimeType } = await resizeImageIfNeeded(Buffer.from(arrayBuffer), "image/jpeg");
      const base64 = buffer.toString("base64");
      const answer = await getVisionReply(question, base64, mimeType);
      await sendTelegramMessage(chatId, answer);
    } catch (err) {
      console.error("Vision pipeline failed:", err.message);
      await sendTelegramMessage(chatId, `⚠️ Couldn't process that image: ${err.message}`);
    }
    res.status(200).send("OK");
    return;
  }

  // Document message (PDF, .docx, or plain text — sent as a "file" rather
  // than a "photo" on Telegram, so it arrives as message.document).
  if (message.document) {
    const doc = message.document;
    const fileName = doc.file_name || "file";
    const mimeType = doc.mime_type || "";
    const lowerName = fileName.toLowerCase();
    const question =
      (message.caption || "").trim() ||
      "Read this document. If it contains a question or something to solve, " +
        "answer it directly. Otherwise, summarize what's in it.";

    // Telegram bots can only download files up to 20MB regardless of chat type.
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await sendTelegramMessage(
        chatId,
        "⚠️ That file's too big for me to download — Telegram bots max out at 20MB."
      );
      res.status(200).send("OK");
      return;
    }

    try {
      sendTypingAction(chatId); // fire-and-forget — already swallows its own errors
      const fileUrl = await getTelegramFileUrl(doc.file_id);

      if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
        // Gemini reads PDFs natively through the same inline_data mechanism
        // used for images — no text extraction needed, and it handles
        // scanned/image-only PDFs too since it's reading the actual pages.
        const { base64 } = await fetchAsBase64(fileUrl);
        const answer = await getVisionReply(question, base64, "application/pdf");
        await sendTelegramMessage(chatId, answer);
      } else if (
        mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        lowerName.endsWith(".docx")
      ) {
        // Gemini's inline_data doesn't accept .docx directly, so pull the
        // text out first with mammoth and send it as a normal text prompt.
        const resp = await fetchWithTimeout(fileUrl, {}, 12000);
        const arrayBuffer = await resp.arrayBuffer();
        const { value: docText } = await mammoth.extractRawText({
          buffer: Buffer.from(arrayBuffer),
        });
        if (!docText.trim()) {
          await sendTelegramMessage(chatId, "⚠️ Couldn't find any text in that .docx file.");
        } else {
          const limitCheck = await checkMessageLimit(chatId);
          if (!limitCheck.allowed) {
            await sendTelegramMessage(chatId, limitCheck.reason);
          } else {
            const prompt = `${question}\n\n--- Document text ---\n${docText.slice(0, 30000)}`;
            const { text: answer, tokensUsed } = await getAiReply(prompt);
            // Neither of these needs the other's result — running them
            // concurrently instead of sequentially shaves a round trip.
            await Promise.all([recordMessageUsage(chatId, tokensUsed), sendTelegramMessage(chatId, answer)]);
          }
        }
      } else if (mimeType.startsWith("text/") || lowerName.endsWith(".txt")) {
        const resp = await fetchWithTimeout(fileUrl, {}, 12000);
        const docText = await resp.text();
        const limitCheck = await checkMessageLimit(chatId);
        if (!limitCheck.allowed) {
          await sendTelegramMessage(chatId, limitCheck.reason);
        } else {
          const prompt = `${question}\n\n--- Document text ---\n${docText.slice(0, 30000)}`;
          const { text: answer, tokensUsed } = await getAiReply(prompt);
          await Promise.all([recordMessageUsage(chatId, tokensUsed), sendTelegramMessage(chatId, answer)]);
        }
      } else {
        // Old .doc, .pptx, .xlsx, etc. — not wired up yet.
        await sendTelegramMessage(
          chatId,
          `⚠️ I can only read PDF, .docx, and plain text files right now — "${fileName}" isn't one of those.`
        );
      }
    } catch (err) {
      console.error("Document pipeline failed:", err.message);
      await sendTelegramMessage(chatId, `⚠️ Couldn't process that file: ${err.message}`);
    }
    res.status(200).send("OK");
    return;
  }

  if (!text) {
    // Sticker, voice note, etc. — nothing to reply to.
    res.status(200).send("OK");
    return;
  }

  const imageMatch = text.match(/^\/(image|img)\s+([\s\S]+)/i);
  if (imageMatch) {
    const imageLimitCheck = await checkImageGenLimit(chatId);
    if (!imageLimitCheck.allowed) {
      await sendTelegramMessage(chatId, imageLimitCheck.reason);
      res.status(200).send("OK");
      return;
    }
    const imagePrompt = imageMatch[2].trim();
    try {
      const { buffer, mimeType } = await askPollinationsImage(imagePrompt);
      await Promise.all([sendTelegramPhoto(chatId, buffer, mimeType, imagePrompt), recordImageUsage(chatId)]);
    } catch (err) {
      console.error("Image generation failed:", err.message);
      await sendTelegramMessage(chatId, `⚠️ Couldn't generate that image: ${err.message}`);
    }
    res.status(200).send("OK");
    return;
  }

  if (/^\/(image|img)$/i.test(text)) {
    await sendTelegramMessage(chatId, "Send it like: /image a red fox in a snowy forest");
    res.status(200).send("OK");
    return;
  }

  const limitCheck = await checkMessageLimit(chatId);
  if (!limitCheck.allowed) {
    await sendTelegramMessage(chatId, limitCheck.reason);
    res.status(200).send("OK");
    return;
  }

  sendTypingAction(chatId); // fire-and-forget — already swallows its own errors
  const { text: reply, tokensUsed } = await getAiReply(text);
  await Promise.all([recordMessageUsage(chatId, tokensUsed), sendTelegramMessage(chatId, reply)]);
  res.status(200).send("OK");
}
