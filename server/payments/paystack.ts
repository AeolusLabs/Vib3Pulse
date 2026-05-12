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

  const data = await paystackRequest<PaystackInitData>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: `payment+${params.userId}@vib3pulse.com`, // placeholder — replace with real email lookup
      amount: params.amountSmallestUnit,
      currency: params.currency,
      reference,
      callback_url: params.successUrl.replace("{CHECKOUT_SESSION_ID}", reference),
      metadata: {
        itemId: params.itemId,
        itemType: params.itemType,
        userId: params.userId,
        cancel_action: params.cancelUrl,
      },
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
        eventId: meta.itemType === "event" ? meta.itemId : undefined,
        venueEntryNightId: meta.itemType === "venue_entry" ? meta.itemId : undefined,
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
export async function createPaystackInlineSession(params: CreatePaymentIntentParams & { userId: string }): Promise<PaymentIntentResult> {
  const reference = `vib3_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const data = await paystackRequest<PaystackInitData>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: `payment+${params.userId}@vib3pulse.com`,
      amount: params.amountSmallestUnit,
      currency: params.currency,
      reference,
      metadata: params.metadata,
    }),
  });

  return {
    provider: "paystack",
    currency: params.currency,
    paymentIntentId: data.reference,
    clientSecret: data.access_code,
  };
}

export function verifyPaystackWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;

  const crypto = require("crypto") as typeof import("crypto");
  const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return hash === signature;
}
