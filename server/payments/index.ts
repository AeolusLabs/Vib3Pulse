import type { SupportedCurrency, PaymentProvider, CreateCheckoutParams, CheckoutResult, VerifiedSession, CreatePaymentIntentParams, PaymentIntentResult, VerifiedPaymentIntent } from "./types.js";
import { createStripeCheckout, verifyStripeSession, createStripePaymentIntent, verifyStripePaymentIntent, refundStripePayment } from "./stripe.js";
import { createPaystackCheckout, verifyPaystackTransaction, createPaystackInlineSession, refundPaystackPayment } from "./paystack.js";
import {
  getPaystackRefundState, createPaystackTransferRecipient, createPaystackTransfer, verifyPaystackTransfer, isPaystackOutage,
  type ProviderRefundState, type TransferResult,
} from "./paystack.js";

export type { SupportedCurrency, PaymentProvider, CheckoutResult, VerifiedSession, VerifiedPaymentIntent };

// ------------------------------------------------------------ test seam
// Tests replace the provider calls below with a mock so nothing ever reaches Paystack or Stripe and no card is charged.
// Each method is optional: a missing one falls through to the real provider. Refused in production.
export interface PaymentProviderForTests {
  createCheckout?: (params: CreateCheckoutParams) => Promise<CheckoutResult>;
  verifyCheckoutSession?: (sessionId: string, provider: PaymentProvider) => Promise<VerifiedSession | null>;
  /** Refund without options (ticket checkout tests). `refund` below takes precedence when both are set. */
  refundPayment?: (providerPaymentId: string, provider: PaymentProvider) => Promise<void>;
  /** Refund with options (the room refund lane passes its idempotency note). */
  refund?: (providerPaymentId: string, provider: PaymentProvider, opts: { note?: string }) => Promise<void>;
  refundState?: (providerPaymentId: string, provider: PaymentProvider, note: string) => Promise<ProviderRefundState>;
  createTransferRecipient?: (params: { subaccountCode: string }) => Promise<{ recipientCode: string }>;
  createTransfer?: (params: { amountKobo: number; recipientCode: string; reference: string; reason: string }) => Promise<TransferResult>;
  verifyTransfer?: (reference: string) => Promise<TransferResult | null>;
}
let testProvider: PaymentProviderForTests | null = null;
export function setPaymentProviderForTests(p: PaymentProviderForTests | null): void {
  if (p && process.env.NODE_ENV === "production") throw new Error("setPaymentProviderForTests is not allowed in production");
  testProvider = p;
}

// Currency is an explicit field the organizer chooses at event/venue creation
// (events.currency / venues.currency) — it is never guessed from city text at
// charge time. This just guards against a stored value outside the two
// currencies we actually have a payment rail for (e.g. legacy data from
// before the creation-form picker was restricted to GBP/NGN), so a charge
// never silently mis-routes to the wrong provider.
export function asSupportedCurrency(currency: string | null | undefined): SupportedCurrency {
  if (currency === "NGN") return "NGN";
  if (currency !== "GBP") {
    console.warn(`[Payments] Unsupported currency "${currency}" on a chargeable item — falling back to GBP.`);
  }
  return "GBP";
}

export function providerForCurrency(currency: SupportedCurrency): PaymentProvider {
  return currency === "NGN" ? "paystack" : "stripe";
}

// Format currency for display
export function formatAmount(amountSmallestUnit: number, currency: SupportedCurrency): string {
  if (currency === "GBP") {
    return `£${(amountSmallestUnit / 100).toFixed(2)}`;
  }
  return `₦${(amountSmallestUnit / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
}

export async function createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
  if (testProvider?.createCheckout) return testProvider.createCheckout(params);
  if (!process.env.STRIPE_SECRET_KEY && !process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("No payment provider configured. Set STRIPE_SECRET_KEY or PAYSTACK_SECRET_KEY.");
  }

  if (params.currency === "NGN") {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("PAYSTACK_SECRET_KEY required for NGN payments");
    }
    return createPaystackCheckout(params);
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY required for GBP payments");
  }
  return createStripeCheckout(params);
}

export async function verifyCheckoutSession(
  sessionId: string,
  provider: PaymentProvider
): Promise<VerifiedSession | null> {
  if (testProvider?.verifyCheckoutSession) return testProvider.verifyCheckoutSession(sessionId, provider);
  if (provider === "paystack") return verifyPaystackTransaction(sessionId);
  return verifyStripeSession(sessionId);
}

export async function createPaymentIntent(
  params: CreatePaymentIntentParams & { userId: string; email: string }
): Promise<PaymentIntentResult> {
  if (params.currency === "NGN") {
    return createPaystackInlineSession(params);
  }
  return createStripePaymentIntent(params);
}

export async function verifyPaymentIntent(
  paymentIntentId: string,
  provider: PaymentProvider
): Promise<VerifiedPaymentIntent | null> {
  if (provider === "paystack") return verifyPaystackTransaction(paymentIntentId) as any;
  return verifyStripePaymentIntent(paymentIntentId);
}

export async function refundPayment(providerPaymentId: string, provider: PaymentProvider, opts: { note?: string; amountKobo?: number } = {}): Promise<void> {
  if (testProvider?.refund) return testProvider.refund(providerPaymentId, provider, opts);
  if (testProvider?.refundPayment) return testProvider.refundPayment(providerPaymentId, provider);
  if (provider === "paystack") return refundPaystackPayment(providerPaymentId, { merchantNote: opts.note, amountKobo: opts.amountKobo });
  if (provider === "stripe") return refundStripePayment(providerPaymentId);
  // "free" provider (promotion credits, free RSVPs) never charged anything to refund.
}

// ------------------------------------------------------------ paid rooms: refund lookup and host transfers (lane S3)
// Behind this module so the room money code never calls Paystack directly and the tests can swap in a mock.

export type { ProviderRefundState, TransferResult };

/**
 * True when a provider call failed WITHOUT a usable answer (network, HTTP 5xx, unreadable body): an outage. Money code
 * never counts it as an attempt and never moves money on it. The mock signals the same with a message starting
 * "Paystack unavailable" (or any error that is not "Paystack error: ..." / one of our PAYOUT_ / BAD_ codes, see callers).
 */
export function isProviderOutage(e: unknown): boolean {
  return isPaystackOutage(e);
}

/** Was this payment already refunded (by our note, or at all)? Throws when the provider cannot answer: do NOT refund then. */
export async function refundState(providerPaymentId: string, provider: PaymentProvider, note: string): Promise<ProviderRefundState> {
  if (testProvider?.refundState) return testProvider.refundState(providerPaymentId, provider, note);
  if (provider === "paystack") return getPaystackRefundState(providerPaymentId, note);
  throw new Error(`refund lookup is not supported for provider ${provider}`);
}

/** A transfer recipient built only from the host's verified Paystack subaccount code (bank details never pass through us). */
export async function createTransferRecipient(params: { subaccountCode: string }): Promise<{ recipientCode: string }> {
  if (testProvider?.createTransferRecipient) return testProvider.createTransferRecipient(params);
  return createPaystackTransferRecipient(params);
}

export async function createTransfer(params: { amountKobo: number; recipientCode: string; reference: string; reason: string }): Promise<TransferResult> {
  if (testProvider?.createTransfer) return testProvider.createTransfer(params);
  return createPaystackTransfer(params);
}

/** null = the provider has no transfer with this reference. Throws on an outage. */
export async function verifyTransfer(reference: string): Promise<TransferResult | null> {
  if (testProvider?.verifyTransfer) return testProvider.verifyTransfer(reference);
  return verifyPaystackTransfer(reference);
}

