import type { SupportedCurrency, PaymentProvider, CreateCheckoutParams, CheckoutResult, VerifiedSession, CreatePaymentIntentParams, PaymentIntentResult, VerifiedPaymentIntent } from "./types.js";
import { createStripeCheckout, verifyStripeSession, createStripePaymentIntent, verifyStripePaymentIntent } from "./stripe.js";
import { createPaystackCheckout, verifyPaystackTransaction, createPaystackInlineSession } from "./paystack.js";

export type { SupportedCurrency, PaymentProvider, CheckoutResult, VerifiedSession, VerifiedPaymentIntent };

// Determine currency from city/country context
export function resolveCurrency(city?: string | null): SupportedCurrency {
  if (!city) return "GBP";
  const lower = city.toLowerCase();
  const ngCities = ["lagos", "abuja", "port harcourt", "ibadan", "kano", "kaduna", "benin", "enugu", "calabar", "owerri"];
  return ngCities.some(c => lower.includes(c)) ? "NGN" : "GBP";
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
  params: CreatePaymentIntentParams & { userId: string }
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
