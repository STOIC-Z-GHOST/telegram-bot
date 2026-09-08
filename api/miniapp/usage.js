// api/miniapp/usage.js
//
// GET -> the calling user's current usage and tier, or { isOwner: true }
// if they're not limited at all. Powers the usage line in the mini app's
// menu drawer.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { isOwner } from "../../lib/access.js";
import { getUserTier } from "../../lib/subscriptions.js";
import { getUsageSummary, TIER_LIMITS } from "../../lib/limits.js";

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
  const limits = TIER_LIMITS[tier];
  const { messagesLastHour, totalTokens, imagesLast30Days } = await getUsageSummary(user.id);

  res.status(200).json({
    isOwner: false,
    tier,
    messagesLastHour,
    messagesPerHourLimit: limits.messagesPerHour,
    totalTokens,
    maxTokens: limits.maxTokens,
    imagesLast30Days,
    imageGenPerMonth: limits.imageGenPerMonth,
    maxImagesPerMessage: limits.maxImagesPerMessage,
  });
}
