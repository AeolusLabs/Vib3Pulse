// The split payment provider behind spraying (phase 5, task 5.3, decision D6). Room money code calls ONLY this interface,
// never Paystack directly, so tests swap in the mock and the real Paystack mechanics can change after G3 without touching
// the spray endpoint.
//
// Which provider runs:
//  - a test override (setSplitProviderForTests), refused in production;
//  - else the mock ONLY when NODE_ENV is not production AND SPRAY_PROVIDER=mock (local dev fixture). The mock can never run
//    in production: it would "deliver" sprays nobody paid for;
//  - else Paystack (which throws, fail closed, when PAYSTACK_SECRET_KEY is not set).
import type { ProviderRefundState } from "./paystack.js";
import { roomFeatures } from "../rooms/features";
import { assertPaymentTokenKeyForBoot } from "./tokenCrypto.js";
import { createPaystackSplitProvider } from "./paystackSplit.js";
import { MockSplitProvider } from "./mockSplitProvider.js";

export type { ProviderRefundState };

/**
 * Recipients only (host, and a stage guest when there is one); everything else stays with the platform account.
 * `team` (gaming team spray): up to TEAM_SPLIT_MAX recipients (each player's cut and the host's), never set for a single spray.
 */
export interface SplitSpec { shares: { subaccountCode: string; amountKobo: number }[]; team?: true }

/**
 * failure meanings (callers show plain words for each):
 *  - DECLINED / INSUFFICIENT_FUNDS / NOT_REUSABLE: the provider answered and NO money moved. Safe to mark the spray failed
 *    and release the reserved spend.
 *  - NETWORK: the outcome is UNKNOWN (no usable answer, or a status we cannot read as final). The charge may still succeed.
 *    Callers MUST keep the spray pending and let verify / the webhook / the sweep decide. Never mark it failed on NETWORK.
 */
export type ChargeFailure = "DECLINED" | "INSUFFICIENT_FUNDS" | "NOT_REUSABLE" | "NETWORK";
export interface ChargeResult { status: "success" | "action_required" | "failed"; reference: string; authorizationUrl?: string; failure?: ChargeFailure; }

/**
 * A saved card as the provider reports it. `authorizationCode` is a secret: encrypt it at once (tokenCrypto) and never log
 * or return it. The key is named authorizationCode (not a generic `code`) so the global response redaction strips it, and
 * the object always travels under the key `authorization`, which is redacted too.
 */
export interface ProviderAuthorization { authorizationCode: string; last4: string; brand: string; bank?: string; reusable: boolean; signature: string }

/**
 * The provider's view of one transaction.
 *  - paid: true when the provider says success for OUR reference (money was taken), whatever the currency or amount. The
 *    caller compares currency and amount with the stored row and refunds a mismatch in full (never "unpaid": a payment
 *    reported unpaid would be marked failed and kept).
 *  - state (added to the contract): "paid" | "failed" (final, no money taken or already reversed) | "pending" (still
 *    possible: abandoned checkouts, ongoing, queued, OTP steps). Only "failed" may be treated as never paid.
 *  - currency (added to the contract): exactly as the provider reports it, upper case. Callers still compare amountKobo
 *    with the stored row EXACTLY and require currency === "NGN" (rule B4).
 * Returns null when the provider says it has no transaction with this reference. THROWS when the provider cannot answer
 * (outage): the caller must treat that as unknown and retry later, never as unpaid.
 */
export interface SplitVerifyResult {
  paid: boolean;
  state: "paid" | "failed" | "pending";
  amountKobo: number;
  currency: string;
  metadata: Record<string, string>;
  authorization?: ProviderAuthorization;
}

/**
 * The provider's own record of one charge, for the admin look-up only (read-only; nothing here changes a row or moves money).
 * status is the provider's word (success, failed, abandoned, reversed ...). Subaccount codes are reported as their last 4
 * characters only. Null from verifyCharge = the provider has no such transaction; it THROWS when it cannot answer.
 */
export interface ChargeDetails {
  status: string;
  amountKobo: number;
  currency: string;
  paidAt: string | null;
  feeKobo: number | null;
  refunded: boolean;
  refundedKobo: number;
  split: { subaccountLast4: string[] } | null;
}

export interface SplitPaymentProvider {
  /** Hosted checkout (card only). The reference must be a spray reference (sprayReference.ts). */
  startFirstPayment(p: { reference: string; email: string; amountKobo: number; split: SplitSpec; metadata: Record<string, string>; callbackUrl: string; anyMethod?: boolean }): Promise<{ url: string }>;
  /**
   * Charges a saved card. Never called for requiresThreeDs tiers; as a second guard, when force3ds is true or the amount is
   * at or above 10,000 naira the provider does NOT charge silently: it starts a card checkout and answers action_required.
   */
  chargeSaved(p: { reference: string; email: string; amountKobo: number; authorizationCode: string; split: SplitSpec; metadata: Record<string, string>; force3ds: boolean; callbackUrl?: string }): Promise<ChargeResult>;
  verify(reference: string): Promise<SplitVerifyResult | null>;
  /** Read-only look-up of the provider's record of this charge (admin ledger). Never refunds, never changes anything. */
  verifyCharge(reference: string): Promise<ChargeDetails | null>;
  /** Full refund. Idempotent: does nothing when a refund for this reference already exists. Throws on outage / refusal. */
  refund(reference: string): Promise<void>;
  /**
   * Was this payment refunded (by our note, or at all)? Throws when the provider cannot answer: do NOT refund then. With
   * fullKobo, "done" only when processed refunds add up to it (a partial refund is needs_attention).
   */
  refundState(reference: string, fullKobo?: number): Promise<ProviderRefundState>;
}

// Rule B8: production with the spray flag ON and no PAYMENT_TOKEN_KEY refuses to start. This module is loaded at boot by
// the spray routes, so the check runs at boot. With the flag OFF (today) it never throws.
assertPaymentTokenKeyForBoot(roomFeatures.spray, process.env);

let testOverride: SplitPaymentProvider | null = null;
let cached: SplitPaymentProvider | null = null;

export function setSplitProviderForTests(p: SplitPaymentProvider | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setSplitProviderForTests is not allowed in production");
  testOverride = p;
}

export function getSplitProvider(): SplitPaymentProvider {
  if (testOverride) {
    if (process.env.NODE_ENV === "production") throw new Error("test split provider in production");
    return testOverride;
  }
  if (process.env.NODE_ENV !== "production" && process.env.SPRAY_PROVIDER === "mock") {
    if (!cached || !(cached instanceof MockSplitProvider)) cached = new MockSplitProvider();
    return cached;
  }
  if (!cached || cached instanceof MockSplitProvider) cached = createPaystackSplitProvider();
  return cached;
}
