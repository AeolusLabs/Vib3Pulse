import Stripe from "stripe";
import type {
  CreateCheckoutParams,
  CheckoutResult,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  VerifiedSession,
  VerifiedPaymentIntent,
} from "./types.js";

function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: "2025-04-30.basil" });
}

export async function createStripeCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
  const stripe = getStripeClient();

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: params.currency.toLowerCase(),
          product_data: {
            name: params.title,
            description: params.description,
          },
          unit_amount: params.amountSmallestUnit,
        },
        quantity: 1,
      },
    ],
    metadata: {
      itemId: params.itemId,
      itemType: params.itemType,
      userId: params.userId,
    },
    success_url: params.successUrl.includes("{CHECKOUT_SESSION_ID}")
      ? params.successUrl.replace("{CHECKOUT_SESSION_ID}", "{CHECKOUT_SESSION_ID}")
      : `${params.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: params.cancelUrl,
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");

  return {
    provider: "stripe",
    currency: params.currency,
    sessionId: session.id,
    url: session.url,
    amountSmallestUnit: params.amountSmallestUnit,
  };
}

export async function verifyStripeSession(sessionId: string): Promise<VerifiedSession | null> {
  const stripe = getStripeClient();
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === "paid";
    const meta = (session.metadata ?? {}) as Record<string, string>;

    return {
      paid,
      providerPaymentId: session.payment_intent as string,
      provider: "stripe",
      currency: (session.currency?.toUpperCase() ?? "GBP") as "GBP" | "NGN",
      amountSmallestUnit: session.amount_total ?? 0,
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

export async function createStripePaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
  const stripe = getStripeClient();

  const intent = await stripe.paymentIntents.create({
    amount: params.amountSmallestUnit,
    currency: params.currency.toLowerCase(),
    metadata: params.metadata,
    automatic_payment_methods: { enabled: true },
  });

  return {
    provider: "stripe",
    currency: params.currency,
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret!,
  };
}

export async function verifyStripePaymentIntent(paymentIntentId: string): Promise<VerifiedPaymentIntent | null> {
  const stripe = getStripeClient();
  try {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return {
      paid: intent.status === "succeeded",
      providerPaymentId: intent.id,
      provider: "stripe",
      currency: (intent.currency.toUpperCase()) as "GBP" | "NGN",
      amountSmallestUnit: intent.amount,
      metadata: (intent.metadata ?? {}) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

export function constructStripeWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}
