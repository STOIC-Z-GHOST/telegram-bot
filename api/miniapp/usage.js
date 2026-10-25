// api/miniapp/usage.js
//
// GET -> the calling user's current usage and tier, or { isOwner: true }
// if they're not limited at all. Powers the usage line in the mini app's
// menu drawer.

import { requireTelegramUser } from "../../lib/telegramAuth.js";
import { isOwner } from "../../lib/access.js";
import { getSubscriptionInfo } from "../../lib/subscriptions.js";
import { getEffectiveSubscriptionInfo } from "../../lib/earlyAccess.js"; // the real plan, or the early-access plan when that is better
import { storageUsedBytes } from "../../lib/storage.js";
import { getUsageSummary, TIER_LIMITS, TRIAL_KINDS, TOKEN_WINDOW_DAYS, limitsFor, countVoiceLast24h, messagesFreeAt, tokensFreeAt, maxUsageLast24h } from "../../lib/limits.js";
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

  // info = what they get right now (a trial counts as the plan it unlocks, and so does early access); real = what they actually have.
  const [info, real] = await Promise.all([getEffectiveSubscriptionInfo(user.id), getSubscriptionInfo(user.id)]);
  const tier = info.tier;
  const limits = await limitsFor(user.id); // referral-bonus-aware for free tier, trial-capped during a trial
  const [{ messagesLastHour, messagesLast24h, tokensInWindow, imagesLast30Days }, voiceUsed, storageUsed] = await Promise.all([
    getUsageSummary(user.id),
    countVoiceLast24h(user.id),
    storageUsedBytes(user.id).catch(() => null), // a problem here must never take the usage bar down
  ]);

  const body = {
    isOwner: false,
    tier,
    // What they actually pay for — "free" during a trial or early access — so the UI keeps the
    // Subscribe buttons visible to someone who's only trialling (and never offers a downgrade to someone who pays).
    paidTier: real.isTrial ? "free" : real.tier,
    // True while the plan above is only there because of early access (lib/earlyAccess.js): the UI says so.
    earlyAccess: !!info.isEarlyAccess,
    // Used / allowed storage (Settings -> Storage). null = unknown; the picker then skips its early "not enough room" warning.
    storage: storageUsed === null ? null : { usedBytes: storageUsed, quotaBytes: limits.storageBytes ?? null },
    trial:
      info.isTrial && info.expiresAt
        ? {
            kind: info.trialKind,
            plan: tier,
            expiresAt: new Date(info.expiresAt).toISOString(),
            daysLeft: Math.max(1, Math.ceil((new Date(info.expiresAt).getTime() - Date.now()) / 86400000)),
            totalDays: TRIAL_KINDS[info.trialKind]?.days ?? 3, // referral_trial is 3 days
          }
        : null,
    // Free tier is capped per day; Pro/Premium per rolling hour.
    messageWindow: tier === "free" ? "day" : "hour",
    messagesUsed: tier === "free" ? messagesLast24h : messagesLastHour,
    messagesLimit: tier === "free" ? limits.messagesPerDay : limits.messagesPerHour,
    tokensUsed: tokensInWindow,
    maxTokens: limits.maxTokens,
    tokenWindowDays: TOKEN_WINDOW_DAYS,
    imagesLast30Days,
    imageGenPerMonth: limits.imageGenPerMonth,
    maxImagesPerMessage: limits.maxImagesPerMessage,
    // Lets the picker warn a free user about Pro-only file types before they
    // upload, and the 🎤 button check the quota before recording.
    proFileExts: PRO_ONLY_EXTS,
    canUseProFiles: tier !== "free",
    voice: { perDay: limits.voicePerDay, used: voiceUsed, maxSeconds: limits.maxVoiceSeconds },
  };

  // A full bar gets a countdown: when the person is back under the limit. The
  // windows are rolling, so this is "room frees up at", not "everything resets".
  const messageWindowMs = (tier === "free" ? 24 : 1) * 60 * 60 * 1000;
  const [messagesResetAt, tokensResetAt] = await Promise.all([
    body.messagesUsed >= body.messagesLimit ? messagesFreeAt(user.id, messageWindowMs, body.messagesLimit) : null,
    body.tokensUsed >= body.maxTokens ? tokensFreeAt(user.id, TOKEN_WINDOW_DAYS * 24 * 60 * 60 * 1000, body.maxTokens) : null,
  ]);
  body.messagesResetAt = messagesResetAt ? messagesResetAt.toISOString() : null;
  body.tokensResetAt = tokensResetAt ? tokensResetAt.toISOString() : null;

  // Max replies today — only for a plan that has Max AND a daily cap (Free has none; "unlimited" has nothing to
  // show). The menu draws a bar from this, with the same "next one in …" countdown when it is full.
  if (limits.maxPerDay > 0) {
    const m = await maxUsageLast24h(user.id, limits.maxPerDay);
    body.max = { perDay: limits.maxPerDay, used: m.used, resetAt: m.resetAt ? m.resetAt.toISOString() : null };
  }

  // Free people earn bonuses from the invite ladder; early-access people have no bonuses to earn but must still be able to invite
  // their friends (that is the point of early access), so both get the invite link.
  if (tier === "free" || info.isEarlyAccess) {
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
