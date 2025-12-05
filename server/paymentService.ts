/**
 * Payment Service
 * 
 * This module provides a unified payment abstraction layer that supports both
 * real Stripe payments and simulated payments for development/demo purposes.
 * 
 * Configuration:
 * - Set SIMULATE_PAYMENTS=true to enable simulated payment mode
 * - Set SIMULATE_PAYMENTS=false (or remove) to use real Stripe payments
 * 
 * When simulated:
 * - Checkout sessions return mock URLs that auto-complete
 * - Payment intents return mock client secrets
 * - All verification calls succeed automatically
 */

import Stripe from "stripe";
import crypto from "crypto";

// Initialize Stripe (only used when not simulating)
const stripe = new Stripe(
  process.env.TESTING_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || "",
  { apiVersion: "2025-11-17.clover" }
);

// Check if payments should be simulated
const isSimulationMode = (): boolean => {
  return process.env.SIMULATE_PAYMENTS === "true";
};

// Generate a unique simulated ID
const generateSimulatedId = (prefix: string): string => {
  return `${prefix}_sim_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
};

// ============================================================
// TYPES
// ============================================================

export interface CheckoutSessionParams {
  eventId: string;
  userId: string;
  eventTitle: string;
  eventDescription: string;
  priceInPence: number;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
}

export interface CheckoutSessionData {
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  paymentIntentId: string;
  metadata: {
    eventId: string;
    userId: string;
  };
}

export interface PaymentIntentParams {
  amountInPence: number;
  metadata: {
    type: string;
    entryNightId: string;
    venueId: string;
    userId: string;
  };
}

export interface PaymentIntentResult {
  clientSecret: string;
  paymentIntentId: string;
}

// ============================================================
// SIMULATED PAYMENT HANDLERS
// ============================================================

// In-memory store for simulated sessions (persists during runtime)
const simulatedSessions = new Map<string, CheckoutSessionData>();
const simulatedPaymentIntents = new Map<string, PaymentIntentParams>();

/**
 * Creates a simulated checkout session for event ticket purchases
 */
const createSimulatedCheckoutSession = (
  params: CheckoutSessionParams
): CheckoutSessionResult => {
  const sessionId = generateSimulatedId("cs");
  const paymentIntentId = generateSimulatedId("pi");

  // Store session data for later retrieval
  simulatedSessions.set(sessionId, {
    paymentStatus: "paid",
    paymentIntentId,
    metadata: {
      eventId: params.eventId,
      userId: params.userId,
    },
  });

  // Return a URL that redirects to success with the session ID
  const successUrlWithSession = params.successUrl.replace(
    "{CHECKOUT_SESSION_ID}",
    sessionId
  );

  console.log(`[PaymentService] Created simulated checkout session: ${sessionId}`);

  return {
    sessionId,
    url: successUrlWithSession,
  };
};

/**
 * Retrieves a simulated checkout session
 */
const retrieveSimulatedCheckoutSession = (
  sessionId: string
): CheckoutSessionData | null => {
  const session = simulatedSessions.get(sessionId);
  if (!session) {
    console.warn(`[PaymentService] Simulated session not found: ${sessionId}`);
    return null;
  }
  console.log(`[PaymentService] Retrieved simulated session: ${sessionId}`);
  return session;
};

/**
 * Creates a simulated payment intent for venue tickets
 */
const createSimulatedPaymentIntent = (
  params: PaymentIntentParams
): PaymentIntentResult => {
  const paymentIntentId = generateSimulatedId("pi");
  const clientSecret = `${paymentIntentId}_secret_${crypto.randomBytes(16).toString("hex")}`;

  // Store for verification
  simulatedPaymentIntents.set(paymentIntentId, params);

  console.log(`[PaymentService] Created simulated payment intent: ${paymentIntentId}`);

  return {
    clientSecret,
    paymentIntentId,
  };
};

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Creates a checkout session for event ticket purchases
 * In simulation mode, returns a mock session that auto-completes
 */
export const createCheckoutSession = async (
  params: CheckoutSessionParams
): Promise<CheckoutSessionResult> => {
  if (isSimulationMode()) {
    return createSimulatedCheckoutSession(params);
  }

  // Real Stripe implementation
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "gbp",
          product_data: {
            name: params.eventTitle,
            description: params.eventDescription,
          },
          unit_amount: params.priceInPence,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: {
      eventId: params.eventId,
      userId: params.userId,
    },
  });

  return {
    sessionId: session.id,
    url: session.url || "",
  };
};

/**
 * Retrieves and verifies a checkout session
 * In simulation mode, returns mock data with payment marked as complete
 */
export const retrieveCheckoutSession = async (
  sessionId: string
): Promise<CheckoutSessionData | null> => {
  if (isSimulationMode()) {
    return retrieveSimulatedCheckoutSession(sessionId);
  }

  // Real Stripe implementation
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  return {
    paymentStatus: session.payment_status as "paid" | "unpaid" | "no_payment_required",
    paymentIntentId: session.payment_intent as string,
    metadata: {
      eventId: session.metadata?.eventId || "",
      userId: session.metadata?.userId || "",
    },
  };
};

/**
 * Creates a payment intent for venue entry tickets
 * In simulation mode, returns a mock client secret
 */
export const createPaymentIntent = async (
  params: PaymentIntentParams
): Promise<PaymentIntentResult> => {
  if (isSimulationMode()) {
    return createSimulatedPaymentIntent(params);
  }

  // Real Stripe implementation
  const paymentIntent = await stripe.paymentIntents.create({
    amount: params.amountInPence,
    currency: "gbp",
    metadata: params.metadata,
  });

  return {
    clientSecret: paymentIntent.client_secret || "",
    paymentIntentId: paymentIntent.id,
  };
};

/**
 * Checks if the payment system is running in simulation mode
 * Useful for UI indicators
 */
export const isPaymentSimulated = (): boolean => {
  return isSimulationMode();
};

/**
 * Gets a human-readable payment mode description
 */
export const getPaymentModeDescription = (): string => {
  return isSimulationMode()
    ? "Demo Mode (payments simulated)"
    : "Live Mode (real payments)";
};
