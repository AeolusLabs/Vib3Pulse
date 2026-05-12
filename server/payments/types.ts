export type SupportedCurrency = "GBP" | "NGN";
export type PaymentProvider = "stripe" | "paystack" | "free";

export interface CreateCheckoutParams {
  itemId: string;        // eventId or venueEntryNightId
  itemType: "event" | "venue_entry";
  userId: string;
  title: string;
  description: string;
  amountSmallestUnit: number; // pence for GBP, kobo for NGN
  currency: SupportedCurrency;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  provider: PaymentProvider;
  currency: SupportedCurrency;
  sessionId: string;
  url: string;
  amountSmallestUnit: number;
}

export interface CreatePaymentIntentParams {
  amountSmallestUnit: number;
  currency: SupportedCurrency;
  metadata: Record<string, string>;
}

export interface PaymentIntentResult {
  provider: PaymentProvider;
  currency: SupportedCurrency;
  paymentIntentId: string;
  clientSecret: string;
}

export interface VerifiedSession {
  paid: boolean;
  providerPaymentId: string;
  provider: PaymentProvider;
  currency: SupportedCurrency;
  amountSmallestUnit: number;
  metadata: {
    eventId?: string;
    venueEntryNightId?: string;
    userId: string;
  };
}

export interface VerifiedPaymentIntent {
  paid: boolean;
  providerPaymentId: string;
  provider: PaymentProvider;
  currency: SupportedCurrency;
  amountSmallestUnit: number;
  metadata: Record<string, string>;
}
