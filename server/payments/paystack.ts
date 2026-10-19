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

export async function refundPaystackPayment(reference: string, opts: { merchantNote?: string } = {}): Promise<void> {
  // Omitting `amount` triggers a full refund of the original transaction amount.
  // merchant_note carries our own deterministic refund reference (Paystack's refund API has no idempotency key), so a
  // later lookup can tell whether this exact refund was already created.
  // paystackCall: an HTTP 5xx (even with a JSON body) or no answer throws "Paystack unavailable" (an outage: the room
  // refund code retries after a lookup); a 4xx / status:false answer throws "Paystack error: ..." as before.
  await paystackCall<unknown>("/refund", {
    method: "POST",
    body: JSON.stringify({ transaction: reference, ...(opts.merchantNote ? { merchant_note: opts.merchantNote } : {}) }),
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


// ============================================================
// REFUND LOOKUP + TRANSFERS (paid rooms: refunds and host payouts, lane S3)
// ============================================================
// Checked against the Paystack docs on 2026-10-19 (docs-v2.paystack.com "Single Transfers", "How Transfers Work", "Refund"
// and the PaystackOSS OpenAPI TransferBase schema): a transfer reference is lowercase alphanumeric with only - and _,
// at least 16 characters, and is the idempotency key (retry with the SAME reference; a new reference is a new transfer);
// statuses are pending | success | failed | reversed | otp | abandoned | blocked | rejected | received; the refund API has
// no idempotency key, so the refund's merchant_note carries our own deterministic reference and is looked up before any
// retry. Never log what these functions receive or return: they carry bank account numbers.
//
// MUST BE CONFIRMED WITH PAYSTACK TEST KEYS before selling (see the 4F-S2 report): the refund list filter
// `GET /refund?transaction=<transaction id>`, the shape of a "transfer not found" answer (HTTP 404 or 400, and its
// message), the subaccount fields that carry the bank (`bank_id` / `bank` / `settlement_bank`), and a second full refund.

/**
 * Error classes, by message prefix (so the test mock can produce the same ones):
 *  - "Paystack unavailable: ..." = no usable answer (network, HTTP 5xx even with a JSON body, an unreadable body).
 *    Callers treat it as an OUTAGE: never counted as an attempt, retried, and money is never moved on it.
 *  - "Paystack error: ..." = Paystack answered and refused (4xx / status false). Callers may count it.
 */
export const PAYSTACK_UNAVAILABLE = "Paystack unavailable";
export function isPaystackOutage(e: unknown): boolean {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m.startsWith(PAYSTACK_UNAVAILABLE);
}

type PaystackAnswer<T> = { httpStatus: number; ok: true; data: T } | { httpStatus: number; ok: false; message: string; code?: string };

/** One request. Throws only "Paystack unavailable" (outage); every answer Paystack actually gave is returned. */
async function paystackAnswer<T>(path: string, options: RequestInit = {}): Promise<PaystackAnswer<T>> {
  let res: Response;
  try {
    res = await fetch(`https://api.paystack.co${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${getSecretKey()}`, "Content-Type": "application/json", ...options.headers },
    });
  } catch (e) {
    throw new Error(`${PAYSTACK_UNAVAILABLE}: ${e instanceof Error ? e.message : "network error"}`);
  }
  // M4: a 5xx is an outage even when Paystack sends a JSON error body with it.
  if (res.status >= 500) throw new Error(`${PAYSTACK_UNAVAILABLE}: HTTP ${res.status}`);
  const body = await res.json().catch(() => null) as { status?: boolean; data?: T; message?: string; code?: string } | null;
  if (!body || typeof body !== "object") throw new Error(`${PAYSTACK_UNAVAILABLE}: HTTP ${res.status} without a JSON body`);
  if (body.status === true && res.status < 400) return { httpStatus: res.status, ok: true, data: body.data as T };
  return { httpStatus: res.status, ok: false, message: String(body.message ?? `HTTP ${res.status}`), code: typeof body.code === "string" ? body.code : undefined };
}

/** paystackAnswer, with a refusal thrown as "Paystack error: <message>". */
async function paystackCall<T>(path: string, options: RequestInit = {}): Promise<T> {
  const a = await paystackAnswer<T>(path, options);
  if (!a.ok) throw new Error(`Paystack error: ${a.message}`);
  return a.data;
}

export type ProviderRefundState = "none" | "in_progress" | "needs_attention" | "done" | "failed";

/** What a set of Paystack refund statuses means for one payment. Pure (exported for the unit tests). */
export function refundStateFrom(statuses: string[]): ProviderRefundState {
  const st = statuses.map((s) => (s ?? "").toLowerCase());
  if (!st.length) return "none";
  if (st.includes("processed")) return "done";
  if (st.includes("needs-attention") || st.includes("needs_attention")) return "needs_attention";
  if (st.some((s) => s !== "failed")) return "in_progress"; // pending, processing, unknown: exists, never create another
  return "failed";
}

type PaystackRefundRow = { status?: string; merchant_note?: string | null; transaction?: unknown; transaction_reference?: string };

/**
 * Has this transaction already been refunded (by our deterministic note, or at all)? Throws when Paystack cannot answer
 * (or answers the lookup with an error): the caller must then NOT create a refund (fail closed, retry later).
 *  1. GET /transaction/verify/:reference gives the transaction id (and "reversed" = fully refunded already).
 *  2. GET /refund?transaction=<id> (the documented filter). Only if THAT answers 4xx: a scan of /refund?reference=,
 *     filtered here by our merchant note or the transaction reference/id.
 */
export async function getPaystackRefundState(reference: string, merchantNote: string): Promise<ProviderRefundState> {
  const tx = await paystackAnswer<{ id?: number | string; status?: string; reference?: string }>(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!tx.ok) throw new Error(`Paystack error: refund lookup could not find the transaction (${tx.message})`);
  if ((tx.data?.status ?? "").toLowerCase() === "reversed") return "done";
  const txId = tx.data?.id;
  if (txId === undefined || txId === null || String(txId) === "") throw new Error("Paystack error: refund lookup got no transaction id");

  const byTx = await paystackAnswer<PaystackRefundRow[]>(`/refund?transaction=${encodeURIComponent(String(txId))}&perPage=100`);
  if (byTx.ok) {
    // Filtered by Paystack to this transaction: every row is a refund of it (ours, or one made by hand in the dashboard).
    const rows = (byTx.data ?? []).filter((r) => {
      const t = r.transaction;
      const id = t && typeof t === "object" ? (t as { id?: unknown }).id : t;
      return id === undefined || id === null || String(id) === String(txId); // belt and braces if the filter were ignored
    });
    return refundStateFrom(rows.map((r) => r.status ?? ""));
  }
  if (byTx.httpStatus < 400 || byTx.httpStatus >= 500) throw new Error(`Paystack error: refund lookup failed (${byTx.message})`);

  // Fallback (the documented filter was refused with a 4xx): scan by reference and filter ourselves.
  const scan = await paystackCall<PaystackRefundRow[]>(`/refund?reference=${encodeURIComponent(reference)}&perPage=100`);
  const mine = (scan ?? []).filter((r) => {
    const t = r.transaction && typeof r.transaction === "object" ? (r.transaction as { reference?: string; id?: unknown }) : null;
    return r.merchant_note === merchantNote || r.transaction_reference === reference || t?.reference === reference
      || (t?.id !== undefined && String(t.id) === String(txId));
  });
  return refundStateFrom(mine.map((r) => r.status ?? ""));
}

/** Bank names as Paystack writes them differ in case, punctuation and suffixes ("Plc", "Limited"). */
export function normaliseBankName(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(plc|limited|ltd|nigeria)\b/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Which bank of the list is the subaccount's? By the bank id or code the subaccount API returns when it has one; only
 * otherwise by normalised name, and only when exactly one bank matches. null = unresolved (the caller alerts).
 */
export function matchSettlementBank(
  sub: { bank_id?: unknown; bank?: unknown; settlement_bank?: unknown },
  banks: Array<{ id?: number | string; code: string; name: string }>,
): { code: string; name: string } | null {
  const idOf = (v: unknown) => (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? String(v) : null);
  const bankId = idOf(sub.bank_id) ?? idOf(sub.bank);
  if (bankId) {
    const byId = banks.filter((b) => b.id !== undefined && String(b.id) === bankId);
    if (byId.length === 1) return byId[0];
  }
  const sb = typeof sub.settlement_bank === "string" ? sub.settlement_bank.trim() : "";
  if (!sb) return null;
  const byCode = banks.filter((b) => b.code === sb);
  if (byCode.length === 1) return byCode[0];
  const n = normaliseBankName(sb);
  const byName = n ? banks.filter((b) => normaliseBankName(b.name) === n) : [];
  return byName.length === 1 ? byName[0] : null;
}

/**
 * A transfer recipient for a host, built ONLY from their verified Paystack subaccount (organizer_payment_accounts), never
 * from a request: the subaccount gives the account number and bank, the bank list gives the bank code, and the account is
 * resolved again for the name Paystack wants.
 */
export async function createPaystackTransferRecipient(params: { subaccountCode: string }): Promise<{ recipientCode: string }> {
  const sub = await paystackCall<{ settlement_bank?: string; account_number?: string; active?: boolean; bank_id?: number | string; bank?: unknown }>(
    `/subaccount/${encodeURIComponent(params.subaccountCode)}`,
  );
  if (!sub.account_number || (!sub.settlement_bank && sub.bank_id === undefined && sub.bank === undefined)) throw new Error("PAYOUT_ACCOUNT_INCOMPLETE");
  if (sub.active === false) throw new Error("PAYOUT_ACCOUNT_INACTIVE");
  const banks = await paystackCall<Array<{ id?: number; name: string; code: string }>>("/bank?country=nigeria&currency=NGN");
  const bank = matchSettlementBank(sub, banks ?? []);
  if (!bank) throw new Error("PAYOUT_BANK_UNRESOLVED");
  const resolved = await paystackCall<{ account_number: string; account_name: string }>(
    `/bank/resolve?account_number=${encodeURIComponent(sub.account_number)}&bank_code=${encodeURIComponent(bank.code)}`,
  );
  const data = await paystackCall<{ recipient_code: string }>("/transferrecipient", {
    method: "POST",
    body: JSON.stringify({ type: "nuban", name: resolved.account_name, account_number: sub.account_number, bank_code: bank.code, currency: "NGN" }),
  });
  if (!data?.recipient_code) throw new Error("PAYOUT_RECIPIENT_FAILED");
  return { recipientCode: data.recipient_code };
}

export interface TransferResult { status: string }

/** Starts a transfer from our Paystack balance. The reference is the idempotency key: callers always pass the same one per payout. */
export async function createPaystackTransfer(params: { amountKobo: number; recipientCode: string; reference: string; reason: string }): Promise<TransferResult> {
  if (!Number.isInteger(params.amountKobo) || params.amountKobo <= 0) throw new Error("BAD_AMOUNT");
  if (!/^[a-z0-9_-]{16,100}$/.test(params.reference)) throw new Error("BAD_REFERENCE");
  const data = await paystackCall<{ status: string }>("/transfer", {
    method: "POST",
    body: JSON.stringify({
      source: "balance", amount: params.amountKobo, recipient: params.recipientCode,
      reference: params.reference, reason: params.reason.slice(0, 100), currency: "NGN",
    }),
  });
  return { status: data?.status ?? "pending" };
}

/** Paystack's own words for "there is no transfer with this reference" (M4: anything else is not proof of absence). */
export function isTransferNotFoundAnswer(a: { httpStatus: number; message?: string; code?: string }): boolean {
  if (a.httpStatus !== 404 && a.httpStatus !== 400) return false;
  const text = `${a.code ?? ""} ${a.message ?? ""}`.toLowerCase();
  return /transfer[^a-z]*not[^a-z]*found|transfer_not_found|not_found|no transfer|transfer does not exist|reference not found/.test(text);
}

/**
 * The transfer with this reference, or null when Paystack SAYS it has none (404 or 400 with a "not found" message).
 * Any other answer it cannot be sure of (a 404 from a proxy, another 4xx, a 5xx, no answer) throws "Paystack unavailable":
 * the caller must not start a new transfer then, and must not count an attempt.
 */
export async function verifyPaystackTransfer(reference: string): Promise<TransferResult | null> {
  const a = await paystackAnswer<{ status?: string }>(`/transfer/verify/${encodeURIComponent(reference)}`);
  if (a.ok) return { status: a.data?.status ?? "pending" };
  if (isTransferNotFoundAnswer(a)) return null;
  throw new Error(`${PAYSTACK_UNAVAILABLE}: transfer verify answered HTTP ${a.httpStatus} (${a.message.slice(0, 80)})`);
}
