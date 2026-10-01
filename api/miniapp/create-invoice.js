// api/miniapp/create-invoice.js
//
// Generates a Telegram Stars invoice link for the mini app's Upgrade
// section, opened via tg.openInvoice() so the user never leaves the app.
// This route only creates the link — the actual payment confirmation
// (pre_checkout_query, successful_payment) still arrives at
// api/telegram-webhook.js the same way it does for the DM bot's /upgrade,
// since Telegram routes all payment events through the bot webhook
// regardless of which surface opened the invoice.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { fetchWithTimeout } from "../../lib/fetchWithTimeout.js";
import { getTierPrices, getUserTier, isDowngrade, SUBSCRIPTION_PERIOD_SECONDS } from "../../lib/subscriptions.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { tier } = req.body || {};
  const prices = await getTierPrices();
  const price = prices[tier];
  if (!price) {
    res.status(400).json({ error: "Unknown plan" });
    return;
  }

  // Never sell someone a plan below the one they already have (the UI hides
  // those buttons — this is the real check).
  const currentTier = await getUserTier(user.id);
  if (currentTier === "owner" || isDowngrade(currentTier, tier)) {
    res.status(400).json({ error: currentTier === "owner" ? "You're the owner — no limits to raise." : `You're already on a higher plan (${currentTier}).` });
    return;
  }

  const label = tier === "premium" ? "Premium" : "Pro";
  const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `${label} subscription`,
      description: `${label} tier — higher limits, billed monthly in Telegram Stars.`,
      payload: `sub:${tier}`,
      currency: "XTR",
      prices: [{ label: `${label} — 1 month`, amount: price }],
      subscription_period: SUBSCRIPTION_PERIOD_SECONDS,
    }),
  }, 10000);

  const data = await resp.json();
  if (!data.ok) {
    console.error("createInvoiceLink failed:", data);
    res.status(502).json({ error: data.description || "Couldn't create invoice link" });
    return;
  }
  res.status(200).json({ url: data.result });
}
