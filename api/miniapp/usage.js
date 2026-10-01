// api/miniapp/usage.js
//
// GET -> the calling user's current usage and tier, or { isOwner: true }
// if they're not limited at all. Powers the usage line in the mini app's
// menu drawer.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { isOwner } from "../../lib/access.js";
import { getUserTier } from "../../lib/subscriptions.js";
import { getUsageSummary, TIER_LIMITS, limitsFor, countVoiceLast24h } from "../../lib/limits.js";
import { PRO_ONLY_EXTS } from "../../lib/fileTypes.js";
import { getCreditedReferralCount, getNextMilestone, referralCodeFor, inviteLinkFor } from "../../lib/referrals.js";

export default async function handler(req, res) {
  const user = await requireTelegramUser(req, res);
  if (!user) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (isOwner(user.id)) {
    const creditedReferrals = await getCreditedReferralCount(user.id);
    const nextTier = getNextMilestone(creditedReferrals);
    res.status(200).json({
      isOwner: true,
      maxImagesPerMessage: TIER_LIMITS.premium.maxImagesPerMessage,
      proFileExts: PRO_ONLY_EXTS,
      canUseProFiles: true,
      voice: { perDay: null, used: 0, maxSeconds: TIER_LIMITS.premium.maxVoiceSeconds }, // null = unlimited
      // Shown so the owner can test/demo the referral flow too — it just
      // never affects the owner's own limits, since those are already
      // unrestricted regardless of what this counts.
      referrals: {
        credited: creditedReferrals,
        nextMilestoneAt: nextTier?.invites ?? null,
        code: referralCodeFor(user.id),
        link: inviteLinkFor(user.id),
      },
    });
    return;
  }

  const tier = await getUserTier(user.id);
  const limits = await limitsFor(user.id); // referral-bonus-aware for free tier
  const [{ messagesLastHour, messagesLast24h, totalTokens, imagesLast30Days }, voiceUsed] = await Promise.all([
    getUsageSummary(user.id),
    countVoiceLast24h(user.id),
  ]);

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
    // Lets the picker warn a free user about Pro-only file types before they
    // upload, and the 🎤 button check the quota before recording.
    proFileExts: PRO_ONLY_EXTS,
    canUseProFiles: tier !== "free",
    voice: { perDay: limits.voicePerDay, used: voiceUsed, maxSeconds: limits.maxVoiceSeconds },
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
