/**
 * Payment Service (Simulation Mode)
 * 
 * This module provides simulated payment processing for demo purposes.
 * All payments are automatically completed without requiring real payment providers.
 * 
 * Features:
 * - Checkout sessions for event ticket purchases (auto-completes)
 * - Payment intents for venue entry tickets (auto-completes)
 * - No external payment provider required
 */

import crypto from "crypto";

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
// SIMULATED PAYMENT STORAGE
// ============================================================

// In-memory store for simulated sessions (persists during runtime)
const simulatedSessions = new Map<string, CheckoutSessionData>();
const simulatedPaymentIntents = new Map<string, PaymentIntentParams>();

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Creates a checkout session for event ticket purchases
 * Returns a mock session that auto-completes payment
 */
export const createCheckoutSession = async (
  params: CheckoutSessionParams
): Promise<CheckoutSessionResult> => {
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
 * Retrieves and verifies a checkout session
 * Returns mock data with payment marked as complete
 */
export const retrieveCheckoutSession = async (
  sessionId: string
): Promise<CheckoutSessionData | null> => {
  const session = simulatedSessions.get(sessionId);
  if (!session) {
    console.warn(`[PaymentService] Simulated session not found: ${sessionId}`);
    return null;
  }
  console.log(`[PaymentService] Retrieved simulated session: ${sessionId}`);
  return session;
};

/**
 * Creates a payment intent for venue entry tickets
 * Returns a mock client secret that auto-confirms
 */
export const createPaymentIntent = async (
  params: PaymentIntentParams
): Promise<PaymentIntentResult> => {
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

/**
 * Verifies a simulated payment intent was created
 * Used for venue ticket confirmations
 */
export const verifyPaymentIntent = async (
  paymentIntentId: string
): Promise<PaymentIntentParams | null> => {
  const intent = simulatedPaymentIntents.get(paymentIntentId);
  if (!intent) {
    console.warn(`[PaymentService] Simulated payment intent not found: ${paymentIntentId}`);
    return null;
  }
  console.log(`[PaymentService] Verified simulated payment intent: ${paymentIntentId}`);
  return intent;
};

/**
 * Always returns true - payments are always simulated
 */
export const isPaymentSimulated = (): boolean => {
  return true;
};

/**
 * Gets a human-readable payment mode description
 */
export const getPaymentModeDescription = (): string => {
  return "Demo Mode (payments simulated for demonstration)";
};
