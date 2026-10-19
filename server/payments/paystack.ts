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
  const reference = `vib3_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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

export async function verifyPaystackTransaction(reference: string): Promise<VerifiedSession | null> {
  try {
    const data = await paystackRequest<PaystackVerifyData>(`/transaction/verify/${reference}`);
    const paid = data.status === "success";
    const meta = data.metadata ?? {};

    return {
      paid,
      providerPaymentId: data.reference,
      provider: "paystack",
      currency: (data.currency?.toUpperCase() ?? "NGN") as "GBP" | "NGN",
      amountSmallestUnit: data.amount,
      metadata: {
        // Pass through everything the initializer attached (type, tier, billing,
        // platforms, ...) — callers previously only saw the fixed fields below,
        // so any new metadata key silently came back undefined. Known fields
        // below still override.
        ...(meta as Record<string, string>),
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
        ticketTierId: meta.ticketTierId || undefined,
        platformFeeAmount: meta.platformFeeAmount || undefined,
        quantity: meta.quantity || undefined,
        userId: meta.userId,
      },
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

export async function refundPaystackPayment(reference: string, opts: { merchantNote?: string } = {}): Promise<void> {
  // Omitting `amount` triggers a full refund of the original transaction amount.
  // merchant_note carries our own deterministic refund reference (Paystack's refund API has no idempotency key), so a
  // later lookup can tell whether this exact refund was already created.
  await paystackRequest<unknown>("/refund", {
    method: "POST",
    body: JSON.stringify({ transaction: reference, ...(opts.merchantNote ? { merchant_note: opts.merchantNote } : {}) }),
  });
}

export function verifyPaystackWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;

  const crypto = require("crypto") as typeof import("crypto");
  const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return hash === signature;
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

// ============================================================
// REFUND LOOKUP + TRANSFERS (paid rooms: refunds and host payouts, lane S3)
// ============================================================
// Checked against the Paystack docs on 2026-10-19 (docs-v2.paystack.com "Single Transfers", "How Transfers Work", "Refund"
// and the PaystackOSS OpenAPI TransferBase schema): a transfer reference is lowercase alphanumeric with only - and _,
// at least 16 characters, and is the idempotency key (retry with the SAME reference; a new reference is a new transfer);
// statuses are pending | success | failed | reversed | otp | abandoned | blocked | rejected | received; the refund API has
// no idempotency key, so the refund's merchant_note carries our own deterministic reference and is looked up before any
// retry. Never log what these functions receive or return: they carry bank account numbers.

/** One request that tells "not found" (HTTP 404) apart from an outage or another error. */
async function paystackRaw<T>(path: string, options: RequestInit = {}): Promise<{ notFound: true } | { notFound: false; data: T }> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${getSecretKey()}`, "Content-Type": "application/json", ...options.headers },
  });
  if (res.status === 404) return { notFound: true };
  // A server-side failure is "no answer" (an outage), not Paystack refusing something: callers retry without counting it.
  if (res.status >= 500) throw new Error(`Paystack unavailable: HTTP ${res.status}`);
  const body = await res.json().catch(() => null) as { status: boolean; data: T; message?: string } | null;
  if (!body || !body.status) throw new Error(`Paystack error: ${body?.message ?? `HTTP ${res.status}`}`);
  return { notFound: false, data: body.data };
}

export type ProviderRefundState = "none" | "in_progress" | "done" | "failed";

/**
 * Has this transaction already been refunded (by our deterministic note, or at all)? Throws when Paystack cannot answer:
 * the caller must then NOT create a refund (fail closed, retry later).
 */
export async function getPaystackRefundState(reference: string, merchantNote: string): Promise<ProviderRefundState> {
  const tx = await paystackRaw<{ status: string }>(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!tx.notFound && tx.data.status === "reversed") return "done";
  const list = await paystackRequest<Array<{ status?: string; merchant_note?: string | null; transaction?: unknown }>>(
    `/refund?reference=${encodeURIComponent(reference)}&perPage=100`,
  );
  const mine = (list ?? []).filter((r) => {
    const txRef = r.transaction && typeof r.transaction === "object" ? (r.transaction as { reference?: string }).reference : undefined;
    return r.merchant_note === merchantNote || txRef === reference;
  });
  if (!mine.length) return "none";
  const st = mine.map((r) => (r.status ?? "").toLowerCase());
  if (st.includes("processed")) return "done";
  if (st.some((s) => s !== "failed")) return "in_progress"; // pending, processing, needs-attention: exists, do not create another
  return "failed";
}

/**
 * A transfer recipient for a host, built ONLY from their verified Paystack subaccount (organizer_payment_accounts), never
 * from a request: the subaccount gives the account number and bank, the bank list gives the bank code, and the account is
 * resolved again for the name Paystack wants.
 */
export async function createPaystackTransferRecipient(params: { subaccountCode: string }): Promise<{ recipientCode: string }> {
  const sub = await paystackRequest<{ settlement_bank?: string; account_number?: string; active?: boolean }>(
    `/subaccount/${encodeURIComponent(params.subaccountCode)}`,
  );
  if (!sub.account_number || !sub.settlement_bank) throw new Error("PAYOUT_ACCOUNT_INCOMPLETE");
  if (sub.active === false) throw new Error("PAYOUT_ACCOUNT_INACTIVE");
  const norm = (s: string) => s.trim().toLowerCase();
  const banks = (await listPaystackBanks()).filter((b) => norm(b.name) === norm(sub.settlement_bank!));
  if (banks.length !== 1) throw new Error("PAYOUT_BANK_UNRESOLVED");
  const resolved = await resolvePaystackBankAccount(sub.account_number, banks[0].code);
  const data = await paystackRequest<{ recipient_code: string }>("/transferrecipient", {
    method: "POST",
    body: JSON.stringify({ type: "nuban", name: resolved.accountName, account_number: sub.account_number, bank_code: banks[0].code, currency: "NGN" }),
  });
  if (!data?.recipient_code) throw new Error("PAYOUT_RECIPIENT_FAILED");
  return { recipientCode: data.recipient_code };
}

export interface TransferResult { status: string }

/** Starts a transfer from our Paystack balance. The reference is the idempotency key: callers always pass the same one per payout. */
export async function createPaystackTransfer(params: { amountKobo: number; recipientCode: string; reference: string; reason: string }): Promise<TransferResult> {
  if (!Number.isInteger(params.amountKobo) || params.amountKobo <= 0) throw new Error("BAD_AMOUNT");
  if (!/^[a-z0-9_-]{16,100}$/.test(params.reference)) throw new Error("BAD_REFERENCE");
  const data = await paystackRequest<{ status: string }>("/transfer", {
    method: "POST",
    body: JSON.stringify({
      source: "balance", amount: params.amountKobo, recipient: params.recipientCode,
      reference: params.reference, reason: params.reason.slice(0, 100), currency: "NGN",
    }),
  });
  return { status: data?.status ?? "pending" };
}

/** The transfer with this reference, or null when Paystack has none. Throws on an outage (the caller must not start a new one then). */
export async function verifyPaystackTransfer(reference: string): Promise<TransferResult | null> {
  const r = await paystackRaw<{ status: string }>(`/transfer/verify/${encodeURIComponent(reference)}`);
  return r.notFound ? null : { status: r.data?.status ?? "pending" };
}
