import type { SupportedCurrency, PaymentProvider, CreateCheckoutParams, CheckoutResult, VerifiedSession, CreatePaymentIntentParams, PaymentIntentResult, VerifiedPaymentIntent } from "./types.js";
import { createStripeCheckout, verifyStripeSession, createStripePaymentIntent, verifyStripePaymentIntent, refundStripePayment } from "./stripe.js";
import { createPaystackCheckout, verifyPaystackTransaction, createPaystackInlineSession, refundPaystackPayment } from "./paystack.js";

export type { SupportedCurrency, PaymentProvider, CheckoutResult, VerifiedSession, VerifiedPaymentIntent };

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

export async function refundPayment(providerPaymentId: string, provider: PaymentProvider): Promise<void> {
  if (provider === "paystack") return refundPaystackPayment(providerPaymentId);
  if (provider === "stripe") return refundStripePayment(providerPaymentId);
  // "free" provider (promotion credits, free RSVPs) never charged anything to refund.
}
