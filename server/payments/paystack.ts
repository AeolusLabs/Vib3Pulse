import crypto from "crypto";
import type {
  CreateCheckoutParams,
  CheckoutResult,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  VerifiedSession,
  VerifiedPaymentIntent,
} from "./types.js";

function getSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set");
  return key;
}

async function paystackRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const body = await res.json() as { status: boolean; data: T; message?: string };
  if (!body.status) {
    throw new Error(`Paystack error: ${body.message ?? "unknown"}`);
  }
  return body.data;
}

interface PaystackInitData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

interface PaystackVerifyData {
  status: string; // "success" | "failed" | "abandoned"
  reference: string;
  amount: number; // kobo
  currency: string;
  metadata: Record<string, string>;
  authorization?: { last4: string };
}

export async function createPaystackCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
  const reference = params.reference ?? `vib3_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const split = params.organizerSplit;

  const data = await paystackRequest<PaystackInitData>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      amount: params.amountSmallestUnit,
      currency: params.currency,
      reference,
      callback_url: params.successUrl.replace("{CHECKOUT_SESSION_ID}", reference),
      metadata: {
        // Caller extras first, so they can never overwrite the fixed keys below.
        ...(params.metadata ?? {}),
        ...(params.itemType === "room" ? { roomId: params.itemId } : {}),
        itemId: params.itemId,
        itemType: params.itemType,
        userId: params.userId,
        cancel_action: params.cancelUrl,
        ...(params.ticketTierId ? { ticketTierId: params.ticketTierId } : {}),
        ...(params.quantity && params.quantity > 1 ? { quantity: String(params.quantity) } : {}),
        ...(split ? { platformFeeAmount: String(split.platformFeeAmount) } : {}),
      },
      // Organizer payout split — subaccount gets amount minus transaction_charge,
      // bearer decides who eats Paystack's own processing fee on top of that.
      ...(split?.paystackSubaccountCode ? {
        subaccount: split.paystackSubaccountCode,
        transaction_charge: split.platformFeeAmount,
        bearer: split.bearer,
      } : {}),
    }),
  });

  return {
    provider: "paystack",
    currency: params.currency,
    sessionId: data.reference,
    url: data.authorization_url,
    amountSmallestUnit: params.amountSmallestUnit,
  };
}

/**
 * The metadata shape callers of verifyPaystackTransaction see. Pure and exported so the test mock provider
 * (setPaymentProviderForTests) can produce exactly what the real verify call produces.
 */
export function normalizePaystackMetadata(meta: Record<string, string>): VerifiedSession["metadata"] {
  return {
    // Pass through everything the initializer attached (type, tier, billing,
    // platforms, ...) — callers previously only saw the fixed fields below,
    // so any new metadata key silently came back undefined. Known fields
    // below still override.
    ...meta,
    // Two metadata shapes reach this function: checkout sessions (event
    // tickets) use {itemId, itemType}; inline sessions (venue entry,
    // promotions) set {venueEntryNightId} etc. directly. Recognize both —
    // previously only the itemId/itemType shape was read, which meant
    // verified.metadata.venueEntryNightId was always undefined for a
    // Paystack venue-entry payment and silently broke the webhook's
    // venue-entry branch (the client-driven /confirm call still worked
    // since it doesn't rely on this field, which is why it went unnoticed).
    eventId: meta.itemType === "event" ? meta.itemId : (meta.eventId as string | undefined),
    venueEntryNightId: meta.itemType === "venue_entry" ? meta.itemId : (meta.venueEntryNightId as string | undefined),
    // Room tickets: only from a room checkout (itemType "room"), never from a bare roomId key.
    roomId: meta.itemType === "room" && typeof meta.itemId === "string" && meta.itemId ? meta.itemId : undefined,
    ticketTierId: meta.ticketTierId || undefined,
    platformFeeAmount: meta.platformFeeAmount || undefined,
    quantity: meta.quantity || undefined,
    userId: meta.userId,
  };
}

export async function verifyPaystackTransaction(reference: string): Promise<VerifiedSession | null> {
  try {
    const data = await paystackRequest<PaystackVerifyData>(`/transaction/verify/${encodeURIComponent(reference)}`);
    const paid = data.status === "success";
    const meta = data.metadata ?? {};

    return {
      paid,
      providerPaymentId: data.reference,
      provider: "paystack",
      currency: (data.currency?.toUpperCase() ?? "NGN") as "GBP" | "NGN",
      amountSmallestUnit: data.amount,
      metadata: normalizePaystackMetadata(meta as Record<string, string>),
    };
  } catch {
    return null;
  }
}

// Paystack does not have a separate "payment intent" concept for inline payments;
// for inline (Paystack Popup), we initialize a transaction and return the access_code
// which the frontend uses with the Paystack JS SDK.
export async function createPaystackInlineSession(params: CreatePaymentIntentParams & { userId: string; email: string }): Promise<PaymentIntentResult> {
  const reference = `vib3_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const split = params.organizerSplit;

  const data = await paystackRequest<PaystackInitData>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      amount: params.amountSmallestUnit,
      currency: params.currency,
      reference,
      metadata: {
        ...params.metadata,
        ...(split ? { platformFeeAmount: String(split.platformFeeAmount) } : {}),
      },
      ...(split?.paystackSubaccountCode ? {
        subaccount: split.paystackSubaccountCode,
        transaction_charge: split.platformFeeAmount,
        bearer: split.bearer,
      } : {}),
    }),
  });

  return {
    provider: "paystack",
    currency: params.currency,
    paymentIntentId: data.reference,
    clientSecret: data.access_code,
  };
}

// Monthly auto-renewing subscription. Paystack bills a subscription from a Plan,
// so we find (or create) a plan whose name encodes tier + amount — a price change
// therefore gets a fresh plan instead of mutating one existing subscribers are on.
// Passing `plan` to /transaction/initialize makes the first successful charge
// start the subscription; Paystack then re-charges the saved card each month.
export async function createPaystackSubscriptionCheckout(params: {
  email: string;
  userId: string;
  tier: string;
  planName: string;
  amountSmallestUnit: number;
  callbackUrl: string;
}): Promise<{ url: string }> {
  const plans = await paystackRequest<Array<{ name: string; plan_code: string }>>("/plan?perPage=100");
  let planCode = plans.find((p) => p.name === params.planName)?.plan_code;
  if (!planCode) {
    const created = await paystackRequest<{ plan_code: string }>("/plan", {
      method: "POST",
      body: JSON.stringify({
        name: params.planName,
        amount: params.amountSmallestUnit,
        interval: "monthly",
        currency: "NGN",
      }),
    });
    planCode = created.plan_code;
  }

  const reference = `vib3_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const data = await paystackRequest<PaystackInitData>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      amount: params.amountSmallestUnit,
      currency: "NGN",
      reference,
      plan: planCode,
      callback_url: params.callbackUrl,
      metadata: { type: "social_plan", billing: "recurring", tier: params.tier, userId: params.userId },
    }),
  });
  return { url: data.authorization_url };
}

// Turn off auto-renew for every active social-plan subscription this customer
// has. Paystack needs the subscription's email_token to disable it.
export async function cancelPaystackSocialSubscriptions(customerCode: string): Promise<number> {
  const subs = await paystackRequest<Array<{ subscription_code: string; status: string; plan?: { name?: string } }>>(
    `/subscription?customer=${encodeURIComponent(customerCode)}&perPage=100`,
  );
  let cancelled = 0;
  for (const s of subs) {
    if (s.status !== "active" || !s.plan?.name?.startsWith("vib3-social-")) continue;
    const detail = await paystackRequest<{ email_token: string }>(`/subscription/${encodeURIComponent(s.subscription_code)}`);
    await paystackRequest<unknown>("/subscription/disable", {
      method: "POST",
      body: JSON.stringify({ code: s.subscription_code, token: detail.email_token }),
    });
    cancelled++;
  }
  return cancelled;
}

export async function refundPaystackPayment(reference: string): Promise<void> {
  // Omitting `amount` triggers a full refund of the original transaction amount.
  await paystackRequest<unknown>("/refund", {
    method: "POST",
    body: JSON.stringify({ transaction: reference }),
  });
}

// Was `require("crypto")` inside the function: this package is ESM ("type": "module", esbuild --format=esm), where a
// bare require is not defined, so the call threw before any check ran. Now a static import, and a constant-time compare.
export function verifyPaystackWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return false;

  const hash = crypto.createHmac("sha512", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === hash.length && crypto.timingSafeEqual(given, hash);
}

// ============================================================
// SUBACCOUNTS (organizer payouts — Phase 2)
// ============================================================

export interface PaystackBank {
  name: string;
  code: string;
}

export async function listPaystackBanks(): Promise<PaystackBank[]> {
  const data = await paystackRequest<Array<{ name: string; code: string }>>(
    "/bank?country=nigeria&currency=NGN"
  );
  return data.map((b) => ({ name: b.name, code: b.code }));
}

export interface ResolvedBankAccount {
  accountNumber: string;
  accountName: string;
}

export async function resolvePaystackBankAccount(accountNumber: string, bankCode: string): Promise<ResolvedBankAccount> {
  const data = await paystackRequest<{ account_number: string; account_name: string }>(
    `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
  );
  return { accountNumber: data.account_number, accountName: data.account_name };
}

export interface CreateSubaccountParams {
  businessName: string;
  bankCode: string;
  accountNumber: string;
  percentageCharge: number; // e.g. 10 for 10% — set to the platform commission rate at creation time; actual per-charge split is overridden with transaction_charge at checkout
}

export async function createPaystackSubaccount(params: CreateSubaccountParams): Promise<{ subaccountCode: string }> {
  const data = await paystackRequest<{ subaccount_code: string }>("/subaccount", {
    method: "POST",
    body: JSON.stringify({
      business_name: params.businessName,
      settlement_bank: params.bankCode,
      account_number: params.accountNumber,
      percentage_charge: params.percentageCharge,
    }),
  });
  return { subaccountCode: data.subaccount_code };
}
