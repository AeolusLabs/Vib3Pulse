import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { storage } from "./storage";
import { requireAuth } from "./middleware";
import { sensitiveOperationLimiter } from "./security";
import { createPaymentIntent, verifyPaymentIntent, providerForCurrency } from "./payments/index";
import { createStripeSubscriptionCheckout, cancelStripeSubscriptionAtPeriodEnd } from "./payments/stripe";
import { createPaystackSubscriptionCheckout, cancelPaystackSocialSubscriptions } from "./payments/paystack";
import { loadTarget } from "./services/promoTargets";
import {
  activatePass,
  applyTopupPayment,
  findBlockingPass,
  getActivePass,
  passLimits,
  getPlanSummary,
  getRenewingPasses,
  paystackPlanName,
  platformsOverDailyLimit,
  releaseCampaign,
  setAutoRenewForUserRecurring,
  tierDefOf,
  tryConsumeCampaign,
} from "./services/socialPlans";
import { cancelCampaign, createScheduledCampaign, listCampaigns, runImmediateCampaign } from "./services/socialCampaigns";
import { SOCIAL_PLATFORMS } from "@shared/schema";
import {
  MAX_SENDS_PER_PLATFORM_PER_DAY,
  SCHEDULE_CANCEL_CUTOFF_MINUTES,
  SCHEDULE_MIN_GAP_MINUTES,
  SCHEDULE_MIN_LEAD_MINUTES,
  SOCIAL_PASS_DAYS,
  SOCIAL_TIERS,
  SOCIAL_TIER_DEFS,
  SOCIAL_TOPUP_DEFS,
  SOCIAL_TOPUP_IDS,
  MAX_EXTRA_PLATFORMS,
  isSocialTier,
  tierPrice,
  topupPrice,
  type SocialCurrency,
} from "@shared/socialPlans";

const currencySchema = z.enum(["GBP", "NGN"]);

// What is being promoted: an event, OR a venue (optionally one of its nights).
const targetFields = {
  eventId: z.string().min(1).optional(),
  venueId: z.string().min(1).optional(),
  venueNightId: z.string().min(1).optional(),
};
const hasOneTarget = (v: { eventId?: string; venueId?: string; venueNightId?: string }) =>
  !!v.eventId !== (!!v.venueId || !!v.venueNightId);
const tierSchema = z.enum(SOCIAL_TIERS);
const packSchema = z.enum(SOCIAL_TOPUP_IDS);

const blockedMessage = (label: string | undefined, endsAt: Date) =>
  `You already have an active ${label} plan until ${endsAt.toLocaleDateString("en-GB")}. Need more? Add campaigns or a platform with a top-up, or choose a new plan once this one ends.`;

function requireOrganizerUser(req: Request, res: Response, next: NextFunction) {
  if (req.user?.userType !== "organizer") {
    return res.status(403).json({ message: "Only organizers can use social promotion plans" });
  }
  next();
}

function appBaseUrl(req: Request): string {
  return (process.env.APP_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "");
}

export function registerSocialPlanRoutes(app: Express): void {

  // Catalog — prices come from shared/socialPlans.ts, the same table that
  // decides what is charged, so the price on screen can't drift from the charge.
  app.get("/api/social/plans", (_req, res) => {
    res.json({
      passDays: SOCIAL_PASS_DAYS,
      maxSendsPerPlatformPerDay: MAX_SENDS_PER_PLATFORM_PER_DAY,
      schedule: {
        minLeadMinutes: SCHEDULE_MIN_LEAD_MINUTES,
        minGapMinutes: SCHEDULE_MIN_GAP_MINUTES,
        cancelCutoffMinutes: SCHEDULE_CANCEL_CUTOFF_MINUTES,
      },
      tiers: SOCIAL_TIERS.map((id) => ({
        id,
        label: SOCIAL_TIER_DEFS[id].label,
        maxPlatforms: SOCIAL_TIER_DEFS[id].maxPlatforms,
        campaignsPerPass: SOCIAL_TIER_DEFS[id].campaignsPerPass,
        timesPerCampaign: SOCIAL_TIER_DEFS[id].timesPerCampaign,
        prices: SOCIAL_TIER_DEFS[id].prices,
      })),
      topups: SOCIAL_TOPUP_IDS.map((id) => SOCIAL_TOPUP_DEFS[id]),
      maxExtraPlatforms: MAX_EXTRA_PLATFORMS,
    });
  });

  app.get("/api/social/plans/me", requireAuth, requireOrganizerUser, async (req, res) => {
    try {
      res.json(await getPlanSummary(req.user!.id));
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ message: "Failed to load your plan" });
    }
  });

  // ── One-off 30-day pass ───────────────────────────────────────────────────

  app.post("/api/social/plans/one-off/intent", requireAuth, requireOrganizerUser, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { tier, currency } = z.object({ tier: tierSchema, currency: currencySchema }).parse(req.body);

      const blocking = await findBlockingPass(req.user!.id);
      if (blocking) return res.status(409).json({ message: blockedMessage(tierDefOf(blocking)?.label, blocking.endsAt) });

      const amount = tierPrice(tier, currency, "one_off");
      const intent = await createPaymentIntent({
        amountSmallestUnit: amount,
        currency,
        userId: req.user!.id,
        email: req.user!.email,
        metadata: { type: "social_plan", billing: "one_off", tier, userId: req.user!.id },
      });
      res.json({
        clientSecret: intent.clientSecret,
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider,
        currency,
        amount,
      });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "Invalid plan or currency" });
      Sentry.captureException(err);
      console.error("[SocialPlan] one-off intent error:", err);
      res.status(500).json({ message: "Failed to start the payment" });
    }
  });

  app.post("/api/social/plans/one-off/confirm", requireAuth, requireOrganizerUser, async (req, res) => {
    try {
      const { paymentIntentId, provider } = z.object({
        paymentIntentId: z.string().min(1),
        provider: z.enum(["stripe", "paystack"]),
      }).parse(req.body);

      const verified = await verifyPaymentIntent(paymentIntentId, provider);
      if (!verified || !verified.paid) return res.status(402).json({ message: "Payment not confirmed" });

      const meta = verified.metadata ?? {};
      if (meta.type !== "social_plan" || meta.billing !== "one_off" || !isSocialTier(meta.tier)) {
        return res.status(403).json({ message: "Payment is not for a social plan" });
      }
      if (meta.userId !== req.user!.id) {
        return res.status(403).json({ message: "Payment does not belong to this account" });
      }
      const currency = currencySchema.parse(verified.currency) as SocialCurrency;
      if (verified.amountSmallestUnit !== tierPrice(meta.tier, currency, "one_off")) {
        Sentry.captureMessage("Social plan one-off amount mismatch at confirm", { level: "error", extra: { paymentIntentId, meta } });
        return res.status(403).json({ message: "Payment amount does not match this plan" });
      }

      await activatePass({
        userId: req.user!.id,
        tier: meta.tier,
        billing: "one_off",
        provider: provider as "stripe" | "paystack",
        currency,
        amountPaid: verified.amountSmallestUnit,
        providerPaymentId: verified.providerPaymentId,
      });
      res.json(await getPlanSummary(req.user!.id));
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "paymentIntentId and provider are required" });
      Sentry.captureException(err);
      console.error("[SocialPlan] one-off confirm error:", err);
      res.status(500).json({ message: "Failed to activate your plan" });
    }
  });

  // ── Recurring subscription ────────────────────────────────────────────────
  // Redirect-based (Stripe Checkout / Paystack hosted page). The pass itself is
  // created by the provider webhook once the first payment clears.

  app.post("/api/social/plans/subscribe", requireAuth, requireOrganizerUser, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { tier, currency } = z.object({ tier: tierSchema, currency: currencySchema }).parse(req.body);
      const userId = req.user!.id;

      if ((await getRenewingPasses(userId)).length > 0) {
        return res.status(409).json({ message: "You already have an auto-renewing plan. Cancel it before starting another." });
      }
      const blocking = await findBlockingPass(userId);
      if (blocking) return res.status(409).json({ message: blockedMessage(tierDefOf(blocking)?.label, blocking.endsAt) });

      const amount = tierPrice(tier, currency, "recurring");
      const base = appBaseUrl(req);
      const successUrl = `${base}/organizer/social?social_plan=success`;
      const cancelUrl = `${base}/organizer/social?social_plan=cancelled`;

      const { url } = providerForCurrency(currency) === "paystack"
        ? await createPaystackSubscriptionCheckout({
            email: req.user!.email,
            userId,
            tier,
            planName: paystackPlanName(tier, amount),
            amountSmallestUnit: amount,
            callbackUrl: successUrl,
          })
        : await createStripeSubscriptionCheckout({
            email: req.user!.email,
            userId,
            tier,
            productName: `Vib3Pulse Social ${SOCIAL_TIER_DEFS[tier].label} (monthly)`,
            amountSmallestUnit: amount,
            currency,
            successUrl,
            cancelUrl,
          });
      res.json({ url });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "Invalid plan or currency" });
      Sentry.captureException(err);
      console.error("[SocialPlan] subscribe error:", err);
      res.status(500).json({ message: "Failed to start the subscription" });
    }
  });

  // Stop future renewals. The current period stays usable until it ends.
  app.post("/api/social/plans/cancel-renewal", requireAuth, requireOrganizerUser, sensitiveOperationLimiter, async (req, res) => {
    try {
      const userId = req.user!.id;
      const renewing = await getRenewingPasses(userId);
      if (renewing.length === 0) return res.status(404).json({ message: "You have no auto-renewing plan." });

      const stripeSub = renewing.find((p) => p.provider === "stripe" && p.providerSubscriptionId)?.providerSubscriptionId;
      const paystackCustomer = renewing.find((p) => p.provider === "paystack" && p.providerCustomerId)?.providerCustomerId;
      if (!stripeSub && !paystackCustomer) {
        // Don't claim success without having told the provider.
        Sentry.captureMessage("Social plan cancel: no provider reference on renewing pass", { level: "error", extra: { userId } });
        return res.status(409).json({ message: "We couldn't find your subscription reference. Contact support to cancel." });
      }

      if (stripeSub) await cancelStripeSubscriptionAtPeriodEnd(stripeSub);
      if (paystackCustomer) await cancelPaystackSocialSubscriptions(paystackCustomer);
      await setAutoRenewForUserRecurring(userId, false);
      res.json(await getPlanSummary(userId));
    } catch (err) {
      Sentry.captureException(err);
      console.error("[SocialPlan] cancel renewal error:", err);
      res.status(500).json({ message: "Failed to cancel renewal" });
    }
  });

  // ── Post now (uses one campaign from the plan) ────────────────────────────
  // Replaces the old pay-per-blast endpoints. There is no payment here — the
  // plan is the payment — so the checks below are what stop it being free.

  app.post("/api/social/campaigns", requireAuth, requireOrganizerUser, sensitiveOperationLimiter, async (req, res) => {
    try {
      const body = z.object({
        ...targetFields,
        platforms: z.array(z.enum(SOCIAL_PLATFORMS)).min(1, "Select at least one platform").max(14),
      }).refine(hasOneTarget, "Choose an event or a venue to promote").parse(req.body);
      const unique = Array.from(new Set(body.platforms));
      const userId = req.user!.id;

      const loaded = await loadTarget(userId, body);
      if (!loaded.ok) return res.status(loaded.status).json({ code: loaded.code, message: loaded.message });
      const { target } = loaded;

      const pass = await getActivePass(userId);
      const limits = pass ? passLimits(pass) : undefined;
      if (!pass || !limits) {
        return res.status(402).json({ code: "NO_PLAN", message: "Choose a social plan to promote on social media." });
      }
      const def = limits.def;
      if (unique.length > limits.maxPlatforms) {
        return res.status(403).json({ code: "PLATFORM_LIMIT", message: `Your ${def.label} plan allows ${limits.maxPlatforms} platforms.` });
      }

      const unconnected: string[] = [];
      for (const platform of unique) {
        if (!(await storage.getConnectedSocial(userId, platform))) unconnected.push(platform);
      }
      if (unconnected.length > 0) {
        return res.status(400).json({ message: `Connect these platforms first: ${unconnected.join(", ")}`, unconnected });
      }

      const overLimit = await platformsOverDailyLimit(userId, unique);
      if (overLimit.length > 0) {
        return res.status(429).json({
          code: "DAILY_LIMIT",
          message: `Daily limit reached for ${overLimit.join(", ")} (${MAX_SENDS_PER_PLATFORM_PER_DAY} per platform per day). Try again tomorrow.`,
          platforms: overLimit,
        });
      }

      if (!(await tryConsumeCampaign(pass.id, def.campaignsPerPass))) {
        return res.status(403).json({
          code: "NO_CAMPAIGNS_LEFT",
          message: `You've used all ${limits.campaigns} campaigns on your ${def.label} plan. Add campaigns with a top-up, or wait for your next period.`,
        });
      }

      // Runs as a one-send campaign through the same path as scheduled ones. If nothing gets
      // posted (now, or later when Zernio reports a failure) the campaign goes back to the plan.
      let outcome;
      try {
        outcome = await runImmediateCampaign({ userId, target, platforms: unique, passId: pass.id });
      } catch (err) {
        await releaseCampaign(pass.id);
        throw err;
      }
      if (!outcome.result) {
        return res.status(409).json({ code: "NOT_POSTED", message: outcome.note ?? "Nothing was posted." });
      }
      const result = outcome.result;

      res.json({ message: "Promoted to social media", ...result, plan: await getPlanSummary(userId) });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0]?.message ?? "Invalid request" });
      Sentry.captureException(err);
      console.error("[SocialPlan] campaign error:", err);
      res.status(500).json({ message: "Failed to promote" });
    }
  });

  // ── Scheduled campaigns ───────────────────────────────────────────────────
  // Books one campaign from the plan and stores the send times; the scheduler
  // (server/socialCampaignScheduler.ts) posts each one when it is due.

  const isValidTimezone = (tz: string) => {
    try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
  };

  app.post("/api/social/campaigns/schedule", requireAuth, requireOrganizerUser, sensitiveOperationLimiter, async (req, res) => {
    try {
      const body = z.object({
        ...targetFields,
        platforms: z.array(z.enum(SOCIAL_PLATFORMS)).min(1, "Select at least one platform").max(14),
        times: z.array(z.string().datetime()).min(1, "Pick at least one time").max(3),
        timezone: z.string().min(1).max(64).refine(isValidTimezone, "Unknown timezone"),
      }).refine(hasOneTarget, "Choose an event or a venue to promote").parse(req.body);

      const result = await createScheduledCampaign({
        userId: req.user!.id,
        eventId: body.eventId,
        venueId: body.venueId,
        venueNightId: body.venueNightId,
        platforms: body.platforms,
        times: body.times.map((t) => new Date(t)),
        timezone: body.timezone,
      });
      if (!result.ok) return res.status(result.status).json({ code: result.code, message: result.message });
      res.status(201).json({ campaignId: result.campaignId, plan: await getPlanSummary(req.user!.id) });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0]?.message ?? "Invalid request" });
      Sentry.captureException(err);
      console.error("[SocialPlan] schedule error:", err);
      res.status(500).json({ message: "Failed to schedule the campaign" });
    }
  });

  app.get("/api/social/campaigns", requireAuth, requireOrganizerUser, async (req, res) => {
    try {
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      res.json(await listCampaigns(req.user!.id, {
        eventId: str(req.query.eventId),
        venueId: str(req.query.venueId),
        venueNightId: str(req.query.venueNightId),
      }));
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ message: "Failed to load campaigns" });
    }
  });

  app.post("/api/social/campaigns/:id/cancel", requireAuth, requireOrganizerUser, sensitiveOperationLimiter, async (req, res) => {
    try {
      const result = await cancelCampaign(req.user!.id, req.params.id);
      if (!result.ok) return res.status(result.status).json({ code: result.code, message: result.message });
      res.json({ allowanceReturned: result.allowanceReturned, plan: await getPlanSummary(req.user!.id) });
    } catch (err) {
      Sentry.captureException(err);
      console.error("[SocialPlan] cancel campaign error:", err);
      res.status(500).json({ message: "Failed to cancel the campaign" });
    }
  });

  // ── Top-ups ───────────────────────────────────────────────────────────────
  // Extra campaigns or a connected platform for the rest of the current period. This replaces
  // mid-period upgrades: buying more of what you ran out of, without paying for a second plan.

  app.post("/api/social/topups/intent", requireAuth, requireOrganizerUser, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { pack, currency } = z.object({ pack: packSchema, currency: currencySchema }).parse(req.body);
      const pass = await getActivePass(req.user!.id);
      if (!pass) return res.status(402).json({ code: "NO_PLAN", message: "Top-ups need an active plan. Choose a plan first." });
      if (SOCIAL_TOPUP_DEFS[pack].kind === "platform" && pass.extraPlatforms >= MAX_EXTRA_PLATFORMS) {
        return res.status(409).json({ message: `You've already added the maximum of ${MAX_EXTRA_PLATFORMS} extra platforms this period.` });
      }
      const amount = topupPrice(pack, currency);
      const intent = await createPaymentIntent({
        amountSmallestUnit: amount,
        currency,
        userId: req.user!.id,
        email: req.user!.email,
        metadata: { type: "social_topup", pack, userId: req.user!.id },
      });
      res.json({
        clientSecret: intent.clientSecret,
        paymentIntentId: intent.paymentIntentId,
        provider: intent.provider,
        currency,
        amount,
      });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "Invalid top-up or currency" });
      Sentry.captureException(err);
      console.error("[SocialPlan] top-up intent error:", err);
      res.status(500).json({ message: "Failed to start the payment" });
    }
  });

  app.post("/api/social/topups/confirm", requireAuth, requireOrganizerUser, async (req, res) => {
    try {
      const { paymentIntentId, provider } = z.object({
        paymentIntentId: z.string().min(1),
        provider: z.enum(["stripe", "paystack"]),
      }).parse(req.body);

      const verified = await verifyPaymentIntent(paymentIntentId, provider);
      if (!verified || !verified.paid) return res.status(402).json({ message: "Payment not confirmed" });
      const meta = verified.metadata ?? {};
      if (meta.type !== "social_topup") return res.status(403).json({ message: "Payment is not for a top-up" });
      if (meta.userId !== req.user!.id) return res.status(403).json({ message: "Payment does not belong to this account" });

      const result = await applyTopupPayment({
        userId: meta.userId, pack: meta.pack, provider, currency: verified.currency as SocialCurrency,
        amountPaid: verified.amountSmallestUnit, providerPaymentId: verified.providerPaymentId,
      });
      if (!result.ok) {
        if (result.reason === "invalid") return res.status(403).json({ message: "Payment does not match this top-up" });
        return res.status(409).json({
          message: result.reason === "no_plan"
            ? "Your plan ended before the top-up could be applied. The payment has been refunded."
            : `You've reached the maximum of ${MAX_EXTRA_PLATFORMS} extra platforms. The payment has been refunded.`,
        });
      }
      res.json(await getPlanSummary(req.user!.id));
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "paymentIntentId and provider are required" });
      Sentry.captureException(err);
      console.error("[SocialPlan] top-up confirm error:", err);
      res.status(500).json({ message: "Failed to apply your top-up" });
    }
  });
}
