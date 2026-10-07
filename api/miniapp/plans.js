// api/miniapp/plans.js
//
// GET  -> tier limits + live Stars prices, for the "Details" comparison
//         table in Settings. Pulls straight from TIER_LIMITS/getTierPrices
//         so it can never show numbers that don't match what's actually
//         enforced. Open to any approved user.
// POST { action: "start_trial", plan: "pro" | "premium" } -> any approved user:
//         starts the Pro promo / Premium trial if the rules in lib/trials.js allow.
// POST { tier, priceStars } -> owner only. Same validation as the DM's
//         /setprice — this is just the mini app's way in to the same
//         underlying setTierPrice(), not a separate pricing mechanism.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { isOwner } from "../../lib/access.js";
import { TIER_LIMITS } from "../../lib/limits.js";
import { getTierPrices, setTierPrice, MAX_PRICE_STARS } from "../../lib/subscriptions.js";
import { getTrialStatus, startTrial, TRIAL_REASON_TEXT } from "../../lib/trials.js";

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    const prices = await getTierPrices();
    res.status(200).json({
      limits: TIER_LIMITS,
      prices,
      videoGeneration: "coming_soon",
      // What the Plan sheet shows: the running trial (if any) and, per plan,
      // whether one can be started and why not. null for the owner (no limits).
      trial: isOwner(user.id) ? null : await getTrialStatus(user.id),
    });
    return;
  }

  if (req.method === "POST") {
    if ((req.body || {}).action === "start_trial") {
      const result = await startTrial(user.id, req.body.plan);
      if (!result.ok) {
        res.status(409).json({ error: result.reason, message: TRIAL_REASON_TEXT[result.reason] || "Couldn't start the trial." });
        return;
      }
      res.status(200).json({ started: true, kind: result.kind, plan: result.plan, expiresAt: result.expiresAt });
      return;
    }
    if (!isOwner(user.id)) {
      res.status(403).json({ error: "owner_only", message: "Only the bot owner can change prices." });
      return;
    }
    const { tier, priceStars } = req.body || {};
    if (tier !== "pro" && tier !== "premium") {
      res.status(400).json({ error: "tier must be 'pro' or 'premium'" });
      return;
    }
    const amount = Number(priceStars);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_PRICE_STARS) {
      res.status(400).json({ error: `priceStars must be an integer between 1 and ${MAX_PRICE_STARS}` });
      return;
    }
    await setTierPrice(tier, amount);
    res.status(200).json({ tier, priceStars: amount });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
