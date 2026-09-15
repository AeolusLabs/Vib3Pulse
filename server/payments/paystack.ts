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

export async function refundPaystackPayment(reference: string): Promise<void> {
  // Omitting `amount` triggers a full refund of the original transaction amount.
  await paystackRequest<unknown>("/refund", {
    method: "POST",
    body: JSON.stringify({ transaction: reference }),
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
