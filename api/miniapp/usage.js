// api/miniapp/usage.js
//
// GET -> the calling user's current usage and tier, or { isOwner: true }
// if they're not limited at all. Powers the usage line in the mini app's
// menu drawer.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { isOwner } from "../../lib/access.js";
import { getUserTier } from "../../lib/subscriptions.js";
import { getUsageSummary, TIER_LIMITS, limitsFor } from "../../lib/limits.js";
import { getCreditedReferralCount, getNextMilestone, referralCodeFor, inviteLinkFor } from "../../lib/referrals.js";

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (isOwner(user.id)) {
    res.status(200).json({ isOwner: true, maxImagesPerMessage: TIER_LIMITS.premium.maxImagesPerMessage });
    return;
  }

  const tier = await getUserTier(user.id);
  const limits = await limitsFor(user.id); // referral-bonus-aware for free tier
  const { messagesLastHour, messagesLast24h, totalTokens, imagesLast30Days } = await getUsageSummary(user.id);

  const body = {
    isOwner: false,
    tier,
    // Free tier is capped per day; Pro/Premium per rolling hour.
    messageWindow: tier === "free" ? "day" : "hour",
    messagesUsed: tier === "free" ? messagesLast24h : messagesLastHour,
    messagesLimit: tier === "free" ? limits.messagesPerDay : limits.messagesPerHour,
    totalTokens,
    maxTokens: limits.maxTokens,
    imagesLast30Days,
    imageGenPerMonth: limits.imageGenPerMonth,
    maxImagesPerMessage: limits.maxImagesPerMessage,
  };

  if (tier === "free") {
    const creditedReferrals = await getCreditedReferralCount(user.id);
    const nextTier = getNextMilestone(creditedReferrals);
    body.referrals = {
      credited: creditedReferrals,
      nextMilestoneAt: nextTier?.invites ?? null,
      code: referralCodeFor(user.id),
      // null if TELEGRAM_BOT_USERNAME isn't set server-side — the
      // frontend falls back to showing the plain code in that case.
      link: inviteLinkFor(user.id),
    };
  }

  res.status(200).json(body);
}
