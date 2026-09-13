export type SupportedCurrency = "GBP" | "NGN";
export type PaymentProvider = "stripe" | "paystack" | "free";

// Set when the organizer has a connected payout account for this charge's
// provider/currency — see computeFeeSplit() in server/payments/fees.ts and
// the payout guardrail in payment-routes.ts. Absent entirely means "no split,
// full amount stays in the platform account" (today's default for every
// currency/provider that doesn't have Connect/Subaccounts wired in yet).
export interface OrganizerSplit {
  paystackSubaccountCode?: string;
  stripeAccountId?: string;
  platformFeeAmount: number; // smallest currency unit
  bearer: "account" | "subaccount"; // who eats the payment processor's own fee
}

export interface CreateCheckoutParams {
  itemId: string;        // eventId or venueEntryNightId
  itemType: "event" | "venue_entry";
  userId: string;
  email: string;
  title: string;
  description: string;
  amountSmallestUnit: number; // pence for GBP, kobo for NGN
  currency: SupportedCurrency;
  successUrl: string;
  cancelUrl: string;
  ticketTierId?: string; // set when itemType === "event" and a specific tier was purchased
  organizerSplit?: OrganizerSplit;
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
  organizerSplit?: OrganizerSplit;
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
    ticketTierId?: string;
    platformFeeAmount?: string;
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
