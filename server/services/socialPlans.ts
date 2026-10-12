import * as Sentry from "@sentry/node";
import { and, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { socialPasses, socialPosts, socialTopups, type SocialPass } from "@shared/schema";
import {
  SOCIAL_TIER_DEFS,
  SOCIAL_PASS_DAYS,
  MAX_SENDS_PER_PLATFORM_PER_DAY,
  MAX_EXTRA_PLATFORMS,
  SOCIAL_TOPUP_DEFS,
  isSocialTier,
  isTopupId,
  topupPrice,
  type SocialTopupId,
  tierRank,
  tierPrice,
  type SocialBilling,
  type SocialCurrency,
  type SocialTier,
  type SocialTierDef,
} from "@shared/socialPlans";
import { recordTransaction } from "../payments/ledger";
import { refundPayment } from "../payments/index";

const DAY_MS = 24 * 60 * 60 * 1000;
// A renewal webhook can land a little after the period rolls over; this keeps a
// paying subscriber from being locked out for the gap.
const RENEWAL_GRACE_MS = DAY_MS;

export function tierDefOf(pass: Pick<SocialPass, "tier">): SocialTierDef | undefined {
  return isSocialTier(pass.tier) ? SOCIAL_TIER_DEFS[pass.tier] : undefined;
}

// A pass's real limits: the tier's, plus whatever top-ups were bought for this period.
export function passLimits(pass: SocialPass) {
  const def = tierDefOf(pass);
  if (!def) return undefined;
  return {
    def,
    maxPlatforms: def.maxPlatforms + pass.extraPlatforms,
    campaigns: def.campaignsPerPass + pass.extraCampaigns,
    timesPerCampaign: def.timesPerCampaign,
  };
}

function asCurrency(value: unknown): SocialCurrency | null {
  const c = String(value ?? "").toUpperCase();
  return c === "GBP" || c === "NGN" ? c : null;
}

// ── Reads ───────────────────────────────────────────────────────────────────

// The pass that governs a user right now. Normally there is exactly one; a renewal
// overlaps the previous period by its 1-day grace, and then the higher tier wins (a
// renewal for a different tier is the only way two can overlap, since buying a second plan
// while one is running is refused).
export async function getActivePass(userId: string): Promise<SocialPass | undefined> {
  const now = new Date();
  const rows = await db.select().from(socialPasses).where(and(
    eq(socialPasses.userId, userId),
    lte(socialPasses.startsAt, now),
    gt(socialPasses.endsAt, now),
  )).orderBy(desc(socialPasses.endsAt));

  let best: SocialPass | undefined;
  for (const row of rows) {
    if (!isSocialTier(row.tier)) continue;
    if (!best || tierRank(row.tier as SocialTier) > tierRank(best.tier as SocialTier)) best = row;
  }
  return best;
}

export interface SocialPlanSummary {
  active: boolean;
  tier?: SocialTier;
  label?: string;
  billing?: SocialBilling;
  endsAt?: string;
  autoRenew?: boolean;
  campaignsUsed?: number;
  campaignsLimit?: number;
  campaignsLeft?: number;
  maxPlatforms?: number;
  platformsConnected: number;
  timesPerCampaign?: number;
  extraCampaigns?: number;
  extraPlatforms?: number;
  canAddPlatformTopup?: boolean;
  currency?: SocialCurrency;
}

export async function getPlanSummary(userId: string): Promise<SocialPlanSummary> {
  const [pass, connected] = await Promise.all([getActivePass(userId), storage.getConnectedSocials(userId)]);
  const platformsConnected = connected.length;
  const limits = pass ? passLimits(pass) : undefined;
  if (!pass || !limits) return { active: false, platformsConnected };
  const def = limits.def;
  return {
    active: true,
    tier: def.id,
    label: def.label,
    billing: pass.billing as SocialBilling,
    endsAt: pass.endsAt.toISOString(),
    autoRenew: pass.autoRenew,
    campaignsUsed: pass.campaignsUsed,
    campaignsLimit: limits.campaigns,
    campaignsLeft: Math.max(0, limits.campaigns - pass.campaignsUsed),
    maxPlatforms: limits.maxPlatforms,
    platformsConnected,
    timesPerCampaign: limits.timesPerCampaign,
    extraCampaigns: pass.extraCampaigns,
    extraPlatforms: pass.extraPlatforms,
    canAddPlatformTopup: pass.extraPlatforms < MAX_EXTRA_PLATFORMS,
    currency: pass.currency as SocialCurrency,
  };
}

// ── Enforcement ─────────────────────────────────────────────────────────────

export type GateResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

// Connecting an account is what costs us money (Zernio bills per connected
// account), so the platform cap is enforced here, on the server.
export async function canConnectPlatform(userId: string, platform: string): Promise<GateResult> {
  const pass = await getActivePass(userId);
  const limits = pass ? passLimits(pass) : undefined;
  if (!pass || !limits) {
    return { ok: false, status: 402, code: "NO_PLAN", message: "Choose a social plan before connecting accounts." };
  }
  const connected = await storage.getConnectedSocials(userId);
  if (connected.some((c) => c.platform === platform)) return { ok: true }; // reconnecting
  if (connected.length >= limits.maxPlatforms) {
    return {
      ok: false, status: 403, code: "PLATFORM_LIMIT",
      message: `Your ${limits.def.label} plan allows ${limits.maxPlatforms} connected platforms. Disconnect one or add a platform top-up to connect another.`,
    };
  }
  return { ok: true };
}

// Platforms that already hit the per-day send guard.
export async function platformsOverDailyLimit(userId: string, platforms: string[]): Promise<string[]> {
  const since = new Date(Date.now() - DAY_MS);
  const over: string[] = [];
  for (const platform of platforms) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(socialPosts).where(and(
      eq(socialPosts.userId, userId),
      eq(socialPosts.platform, platform),
      eq(socialPosts.status, "posted"),
      gte(socialPosts.postedAt, since),
    ));
    if ((row?.n ?? 0) >= MAX_SENDS_PER_PLATFORM_PER_DAY) over.push(platform);
  }
  return over;
}

// Atomic: the WHERE clause is the limit check, so two simultaneous requests can
// never both take the last campaign. `tierLimit` is the tier's allowance; any top-up
// campaigns bought for this pass are added in the query itself.
export async function tryConsumeCampaign(passId: string, tierLimit: number): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE social_passes SET campaigns_used = campaigns_used + 1
    WHERE id = ${passId} AND campaigns_used < ${tierLimit} + extra_campaigns AND ends_at > now()
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function releaseCampaign(passId: string): Promise<void> {
  await db.execute(sql`
    UPDATE social_passes SET campaigns_used = campaigns_used - 1
    WHERE id = ${passId} AND campaigns_used > 0
  `);
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface CreatePassInput {
  userId: string;
  tier: SocialTier;
  billing: SocialBilling;
  provider: "stripe" | "paystack";
  currency: SocialCurrency;
  amountPaid: number;
  providerPaymentId: string;
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  startsAt?: Date;
  endsAt?: Date;
}

// Idempotent on providerPaymentId: the client-driven confirm route and the
// provider webhook both call this for the same payment; only the first inserts
// (and records the ledger entry), the other gets the existing row back.
export async function activatePass(input: CreatePassInput): Promise<{ pass: SocialPass; created: boolean }> {
  const startsAt = input.startsAt ?? new Date();
  const recurring = input.billing === "recurring";
  const endsAt = input.endsAt ?? new Date(startsAt.getTime() + SOCIAL_PASS_DAYS * DAY_MS + (recurring ? RENEWAL_GRACE_MS : 0));

  const inserted = await db.insert(socialPasses).values({
    userId: input.userId,
    tier: input.tier,
    billing: input.billing,
    provider: input.provider,
    currency: input.currency,
    amountPaid: input.amountPaid,
    providerPaymentId: input.providerPaymentId,
    providerSubscriptionId: input.providerSubscriptionId ?? null,
    providerCustomerId: input.providerCustomerId ?? null,
    startsAt,
    endsAt,
    autoRenew: recurring,
  }).onConflictDoNothing({ target: socialPasses.providerPaymentId }).returning();

  if (inserted[0]) {
    // Plan revenue is 100% the platform's — no organizer split applies.
    await recordTransaction({
      type: "social_promotion",
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      currency: input.currency,
      buyerUserId: input.userId,
      grossAmount: input.amountPaid,
      platformFeeAmount: input.amountPaid,
      netToOrganizerAmount: 0,
      status: "succeeded",
    });
    return { pass: inserted[0], created: true };
  }
  const [existing] = await db.select().from(socialPasses)
    .where(eq(socialPasses.providerPaymentId, input.providerPaymentId)).limit(1);
  return { pass: existing, created: false };
}

// Purchase guard: one plan at a time. More campaigns or platforms mid-period come from
// top-ups, not from buying a second (or bigger) plan on top.
export async function findBlockingPass(userId: string): Promise<SocialPass | undefined> {
  return getActivePass(userId);
}

export async function getRenewingPasses(userId: string): Promise<SocialPass[]> {
  const now = new Date();
  return db.select().from(socialPasses).where(and(
    eq(socialPasses.userId, userId),
    eq(socialPasses.billing, "recurring"),
    eq(socialPasses.autoRenew, true),
    gt(socialPasses.endsAt, now),
  )).orderBy(desc(socialPasses.endsAt));
}

export async function setAutoRenewForUserRecurring(userId: string, value: boolean): Promise<void> {
  await db.update(socialPasses).set({ autoRenew: value }).where(and(
    eq(socialPasses.userId, userId),
    eq(socialPasses.billing, "recurring"),
  ));
}

async function setAutoRenewBySubscription(subscriptionId: string, value: boolean): Promise<void> {
  await db.update(socialPasses).set({ autoRenew: value })
    .where(eq(socialPasses.providerSubscriptionId, subscriptionId));
}

async function setAutoRenewByCustomer(provider: string, customerId: string, value: boolean): Promise<void> {
  await db.update(socialPasses).set({ autoRenew: value }).where(and(
    eq(socialPasses.provider, provider),
    eq(socialPasses.providerCustomerId, customerId),
    eq(socialPasses.billing, "recurring"),
  ));
}

// ── Provider webhook handlers ───────────────────────────────────────────────
// Each tolerates malformed/unknown payloads by logging and returning — a bad
// event must never 500 the webhook (the provider would retry it forever).

const idOf = (v: any): string | null => (typeof v === "string" ? v : v?.id ?? null);

// Stripe: a recurring plan's invoice was paid (first payment and every renewal).
export async function handleStripeInvoicePaid(invoice: any): Promise<void> {
  const sub = invoice?.parent?.subscription_details;
  const meta = sub?.metadata ?? {};
  if (meta.type !== "social_plan") return;

  const tier = meta.tier;
  const currency = asCurrency(invoice.currency);
  if (!isSocialTier(tier) || !meta.userId || !currency || !(invoice.amount_paid > 0)) {
    Sentry.captureMessage("Social plan invoice.paid with unusable data", { level: "warning", extra: { id: invoice?.id, meta } });
    return;
  }
  const line = invoice.lines?.data?.[0];
  const start = line?.period?.start ? new Date(line.period.start * 1000) : new Date();
  const end = line?.period?.end ? new Date(line.period.end * 1000 + RENEWAL_GRACE_MS) : undefined;

  await activatePass({
    userId: meta.userId,
    tier,
    billing: "recurring",
    provider: "stripe",
    currency,
    amountPaid: invoice.amount_paid,
    providerPaymentId: invoice.id,
    providerSubscriptionId: idOf(sub.subscription),
    providerCustomerId: idOf(invoice.customer),
    startsAt: start,
    endsAt: end,
  });
}

// Stripe: subscription cancelled/ended, or cancel-at-period-end toggled.
export async function handleStripeSubscriptionChange(subscription: any, deleted: boolean): Promise<void> {
  if (subscription?.metadata?.type !== "social_plan" || !subscription.id) return;
  const stillRenewing = !deleted && !subscription.cancel_at_period_end && subscription.status === "active";
  await setAutoRenewBySubscription(subscription.id, stillRenewing);
}

// Stripe: a one-off pass payment succeeded (backs up the client-driven confirm).
export async function handleStripeOneOffIntent(intent: any): Promise<void> {
  const meta = intent?.metadata ?? {};
  if (meta.type !== "social_plan" || meta.billing !== "one_off") return;
  const currency = asCurrency(intent.currency);
  if (!isSocialTier(meta.tier) || !meta.userId || !currency) return;
  if (intent.amount !== tierPrice(meta.tier, currency, "one_off")) {
    Sentry.captureMessage("Social plan one-off amount mismatch", { level: "error", extra: { id: intent.id, amount: intent.amount, meta } });
    return;
  }
  await activatePass({
    userId: meta.userId, tier: meta.tier, billing: "one_off", provider: "stripe",
    currency, amountPaid: intent.amount, providerPaymentId: intent.id,
  });
}

// Paystack plan names are deterministic so a renewal charge (which carries no
// metadata from us) can be mapped back to a tier: vib3-social-<tier>-<kobo>.
export function paystackPlanName(tier: SocialTier, amountKobo: number): string {
  return `vib3-social-${tier}-${amountKobo}`;
}

// Paystack charge.success. Returns true if the charge belonged to a social plan,
// so the caller knows not to treat it as a ticket payment.
export async function handlePaystackCharge(
  data: any,
  verified: { amountSmallestUnit: number; currency: string; metadata: Record<string, any> },
): Promise<boolean> {
  const meta = verified.metadata ?? {};
  if (meta.type === "social_topup") {
    const currency = asCurrency(verified.currency);
    await applyTopupPayment({
      userId: meta.userId, pack: meta.pack, provider: "paystack", currency,
      amountPaid: verified.amountSmallestUnit, providerPaymentId: String(data?.reference ?? ""),
    });
    return true;
  }
  const planName: string | undefined = data?.plan?.name;
  const isRenewalCharge = typeof planName === "string" && planName.startsWith("vib3-social-");
  if (meta.type !== "social_plan" && !isRenewalCharge) return false;

  const currency = asCurrency(verified.currency);
  const reference = String(data?.reference ?? "");
  let tier: unknown = meta.tier;
  let userId: string | undefined = meta.userId;
  let billing: SocialBilling = meta.billing === "one_off" ? "one_off" : "recurring";

  if (meta.type !== "social_plan" && isRenewalCharge) {
    tier = planName!.split("-")[2];
    billing = "recurring";
    const email = data?.customer?.email;
    const user = email ? await storage.getUserByEmail(email) : undefined;
    userId = user?.id;
  }

  if (!isSocialTier(tier) || !userId || !currency || !reference) {
    Sentry.captureMessage("Paystack social plan charge with unusable data", { level: "warning", extra: { reference, planName, meta } });
    return true;
  }
  if (billing === "one_off" && verified.amountSmallestUnit !== tierPrice(tier, currency, "one_off")) {
    Sentry.captureMessage("Social plan one-off amount mismatch", { level: "error", extra: { reference, amount: verified.amountSmallestUnit, meta } });
    return true;
  }

  await activatePass({
    userId, tier, billing, provider: "paystack", currency,
    amountPaid: verified.amountSmallestUnit,
    providerPaymentId: reference,
    providerCustomerId: data?.customer?.customer_code ?? null,
  });
  return true;
}

// Paystack subscription.create: remember the subscription code on the newest period.
export async function handlePaystackSubscriptionCreated(data: any): Promise<void> {
  const planName: string | undefined = data?.plan?.name;
  if (!planName?.startsWith("vib3-social-") || !data.subscription_code || !data.customer?.customer_code) return;
  await db.execute(sql`
    UPDATE social_passes SET provider_subscription_id = ${data.subscription_code}
    WHERE id = (
      SELECT id FROM social_passes
      WHERE provider = 'paystack' AND provider_customer_id = ${data.customer.customer_code}
        AND billing = 'recurring' AND provider_subscription_id IS NULL
      ORDER BY created_at DESC LIMIT 1
    )
  `);
}

// Paystack subscription.disable / subscription.not_renew.
export async function handlePaystackSubscriptionEnded(data: any): Promise<void> {
  const planName: string | undefined = data?.plan?.name;
  if (!planName?.startsWith("vib3-social-") || !data.customer?.customer_code) return;
  await setAutoRenewByCustomer("paystack", data.customer.customer_code, false);
}

// ── Top-ups ─────────────────────────────────────────────────────────────────

export type TopupResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "no_plan" | "platform_cap" };

// Idempotent on providerPaymentId (the confirm route and the webhook both call this). Applies
// to the user's CURRENT pass; if they have none (it ended between paying and now) or the
// platform cap would be exceeded, nothing is applied and the caller must refund.
export async function activateTopup(input: {
  userId: string;
  pack: SocialTopupId;
  provider: "stripe" | "paystack";
  currency: SocialCurrency;
  amountPaid: number;
  providerPaymentId: string;
}): Promise<TopupResult> {
  const [already] = await db.select({ id: socialTopups.id }).from(socialTopups)
    .where(eq(socialTopups.providerPaymentId, input.providerPaymentId)).limit(1);
  if (already) return { ok: true, created: false };

  const pass = await getActivePass(input.userId);
  if (!pass) return { ok: false, reason: "no_plan" };
  const pack = SOCIAL_TOPUP_DEFS[input.pack];
  if (pack.kind === "platform" && pass.extraPlatforms + pack.amount > MAX_EXTRA_PLATFORMS) {
    return { ok: false, reason: "platform_cap" };
  }

  const created = await db.transaction(async (tx) => {
    const inserted = await tx.insert(socialTopups).values({
      userId: input.userId, passId: pass.id, pack: pack.id, kind: pack.kind, amount: pack.amount,
      provider: input.provider, currency: input.currency, amountPaid: input.amountPaid,
      providerPaymentId: input.providerPaymentId,
    }).onConflictDoNothing({ target: socialTopups.providerPaymentId }).returning({ id: socialTopups.id });
    if (inserted.length === 0) return false; // the other path won the race
    await tx.update(socialPasses).set(
      pack.kind === "campaigns"
        ? { extraCampaigns: sql`${socialPasses.extraCampaigns} + ${pack.amount}` }
        : { extraPlatforms: sql`${socialPasses.extraPlatforms} + ${pack.amount}` },
    ).where(eq(socialPasses.id, pass.id));
    return true;
  });

  if (created) {
    await recordTransaction({
      type: "social_promotion",
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      currency: input.currency,
      buyerUserId: input.userId,
      grossAmount: input.amountPaid,
      platformFeeAmount: input.amountPaid,
      netToOrganizerAmount: 0,
      status: "succeeded",
    });
  }
  return { ok: true, created };
}

// Validates a top-up payment against the catalog, applies it, and refunds it if it can't be
// applied (so nobody pays for something they didn't get).
export async function applyTopupPayment(input: {
  userId: unknown; pack: unknown; provider: "stripe" | "paystack"; currency: SocialCurrency | null;
  amountPaid: number; providerPaymentId: string;
}): Promise<TopupResult | { ok: false; reason: "invalid" }> {
  if (typeof input.userId !== "string" || !isTopupId(input.pack) || !input.currency || !input.providerPaymentId) {
    Sentry.captureMessage("Social top-up payment with unusable data", { level: "warning", extra: { ...input } });
    return { ok: false, reason: "invalid" };
  }
  if (input.amountPaid !== topupPrice(input.pack, input.currency)) {
    Sentry.captureMessage("Social top-up amount mismatch", { level: "error", extra: { ...input } });
    return { ok: false, reason: "invalid" };
  }
  const result = await activateTopup({ ...input, userId: input.userId, pack: input.pack, currency: input.currency });
  if (!result.ok) {
    try {
      await refundPayment(input.providerPaymentId, input.provider);
    } catch (err) {
      await storage.createPaymentIssue({
        providerPaymentId: input.providerPaymentId,
        provider: input.provider,
        reason: "refund_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

// Stripe: a top-up payment intent succeeded (backs up the client-driven confirm).
export async function handleStripeTopupIntent(intent: any): Promise<void> {
  const meta = intent?.metadata ?? {};
  if (meta.type !== "social_topup") return;
  await applyTopupPayment({
    userId: meta.userId, pack: meta.pack, provider: "stripe", currency: asCurrency(intent.currency),
    amountPaid: intent.amount, providerPaymentId: intent.id,
  });
}
