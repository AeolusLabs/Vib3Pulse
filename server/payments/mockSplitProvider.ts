// In-memory SplitPaymentProvider for tests and the local dev fixture (SPRAY_PROVIDER=mock). Never charges anything.
// Refuses to exist in production (constructor throws): a mock in production would "deliver" sprays nobody paid for.
//
// It runs every input through the same pure validator as the Paystack module (buildChargeBody), so a bad split, a wrong
// currency or a malformed reference fails in tests exactly as it would for real, and it applies the same 3D Secure rule.
//
// Scripting:
//   mock.nextCharge.push("declined")            // the next chargeSaved answers this (FIFO); default "success"
//   mock.completeCheckout(ref, { reusable })    // the payer finishes the hosted checkout: the transaction becomes paid
//   mock.failCheckout(ref)                      // the payer's bank declines the checkout
//   mock.refundMode = "fail" | "outage"         // the next refund() throws like Paystack would
//   mock.processRefunds()                       // pending refunds become processed ("done")
//   mock.tamper(ref, { amountKobo, currency })  // the provider reports a different amount / currency (B4 tests)
import { buildChargeBody, THREE_DS_FLOOR_KOBO } from "./paystackSplit.js";
import { PAYSTACK_UNAVAILABLE, type ProviderRefundState } from "./paystack.js";
import { looksLikeSprayReference } from "./sprayReference.js";
import type { ChargeResult, SplitPaymentProvider, SplitSpec, SplitVerifyResult } from "./splitProvider.js";

export type MockChargeOutcome = "success" | "declined" | "insufficient" | "not_reusable" | "network" | "network_but_charged" | "action_required";

interface MockTx {
  reference: string;
  amountKobo: number;
  currency: string;
  metadata: Record<string, string>;
  split: SplitSpec;
  state: "pending" | "paid" | "failed";
  via: "checkout" | "saved";
  reusable: boolean;
  refund: ProviderRefundState;
}

export interface MockCall { method: "startFirstPayment" | "chargeSaved" | "verify" | "refund" | "refundState"; reference: string; amountKobo?: number; shares?: SplitSpec["shares"]; force3ds?: boolean }

const MOCK_SPLIT_CODE = "SPL_mockmock01";

export class MockSplitProvider implements SplitPaymentProvider {
  readonly txs = new Map<string, MockTx>();
  /** Every call, without emails or authorization codes. */
  readonly calls: MockCall[] = [];
  /** References a refund was created for, in order (a second refund for the same payment would show up twice). */
  readonly refunds: string[] = [];
  nextCharge: MockChargeOutcome[] = [];
  refundMode: "ok" | "fail" | "outage" = "ok";
  verifyMode: "ok" | "outage" = "ok";
  /** The fake card a successful payment reports. Codes are fake, but tests still check they never leak. */
  card = { code: "AUTH_mockcard0001", last4: "4081", brand: "visa", bank: "Test Bank", signature: "SIG_mockcard0001" };

  constructor() {
    if (process.env.NODE_ENV === "production") throw new Error("MockSplitProvider is not allowed in production");
  }

  private validate(kind: "initialize" | "charge_authorization", p: { reference: string; email: string; amountKobo: number; split: SplitSpec; metadata: Record<string, string>; callbackUrl?: string; authorizationCode?: string }) {
    return buildChargeBody({
      kind, reference: p.reference, email: p.email, amountKobo: p.amountKobo, currency: "NGN", split: p.split, metadata: p.metadata,
      ...(kind === "initialize" ? { callbackUrl: p.callbackUrl } : { authorizationCode: p.authorizationCode }),
      splitCode: p.split.shares.length === 2 ? MOCK_SPLIT_CODE : undefined,
    });
  }

  private record(p: { reference: string; amountKobo: number; split: SplitSpec; metadata: Record<string, string> }, via: MockTx["via"], state: MockTx["state"], reusable: boolean): MockTx {
    const existing = this.txs.get(p.reference);
    if (existing) return existing; // Paystack refuses a duplicate reference; the first transaction stands
    const body = { reference: p.reference, amountKobo: p.amountKobo, currency: "NGN", metadata: { ...p.metadata, type: "spray" }, split: p.split, state, via, reusable, refund: "none" as ProviderRefundState };
    this.txs.set(p.reference, body);
    return body;
  }

  async startFirstPayment(p: { reference: string; email: string; amountKobo: number; split: SplitSpec; metadata: Record<string, string>; callbackUrl: string }): Promise<{ url: string }> {
    this.validate("initialize", p);
    this.calls.push({ method: "startFirstPayment", reference: p.reference, amountKobo: p.amountKobo, shares: p.split.shares });
    this.record(p, "checkout", "pending", false);
    return { url: `https://checkout.mock.test/pay/${p.reference}` };
  }

  async chargeSaved(p: { reference: string; email: string; amountKobo: number; authorizationCode: string; split: SplitSpec; metadata: Record<string, string>; force3ds: boolean; callbackUrl?: string }): Promise<ChargeResult> {
    this.calls.push({ method: "chargeSaved", reference: p.reference, amountKobo: p.amountKobo, shares: p.split.shares, force3ds: p.force3ds });
    if (p.force3ds || p.amountKobo >= THREE_DS_FLOOR_KOBO) {
      if (typeof p.callbackUrl !== "string") throw new RangeError("callbackUrl: required when 3D Secure applies");
      this.validate("initialize", { ...p, callbackUrl: p.callbackUrl });
      this.record(p, "checkout", "pending", false);
      return { status: "action_required", reference: p.reference, authorizationUrl: `https://checkout.mock.test/3ds/${p.reference}` };
    }
    this.validate("charge_authorization", p);
    const outcome = this.nextCharge.shift() ?? "success";
    const ref = p.reference;
    switch (outcome) {
      case "success": this.record(p, "saved", "paid", true); return { status: "success", reference: ref };
      case "network_but_charged": this.record(p, "saved", "paid", true); return { status: "failed", reference: ref, failure: "NETWORK" };
      case "network": this.record(p, "saved", "pending", false); return { status: "failed", reference: ref, failure: "NETWORK" };
      case "declined": this.record(p, "saved", "failed", false); return { status: "failed", reference: ref, failure: "DECLINED" };
      case "insufficient": this.record(p, "saved", "failed", false); return { status: "failed", reference: ref, failure: "INSUFFICIENT_FUNDS" };
      case "not_reusable": this.record(p, "saved", "failed", false); return { status: "failed", reference: ref, failure: "NOT_REUSABLE" };
      case "action_required": this.record(p, "checkout", "pending", false); return { status: "action_required", reference: ref, authorizationUrl: `https://checkout.mock.test/3ds/${ref}` };
    }
  }

  async verify(reference: string): Promise<SplitVerifyResult | null> {
    this.calls.push({ method: "verify", reference });
    if (this.verifyMode === "outage") throw new Error(`${PAYSTACK_UNAVAILABLE}: mock outage`);
    if (!looksLikeSprayReference(reference)) return null;
    const t = this.txs.get(reference);
    if (!t) return null;
    const paid = t.state === "paid" && t.currency === "NGN";
    const reversed = t.refund === "done";
    return {
      paid: paid && !reversed,
      state: reversed ? "failed" : paid ? "paid" : t.state === "failed" ? "failed" : "pending",
      amountKobo: t.amountKobo,
      currency: t.currency,
      metadata: { ...t.metadata },
      ...(paid ? { authorization: { ...this.card, code: this.card.code, reusable: t.reusable } } : {}),
    };
  }

  async refund(reference: string): Promise<void> {
    this.calls.push({ method: "refund", reference });
    if (this.refundMode === "outage") throw new Error(`${PAYSTACK_UNAVAILABLE}: mock outage`);
    if (this.refundMode === "fail") throw new Error("Paystack error: mock refund refused");
    const t = this.txs.get(reference);
    if (!t || t.state !== "paid") throw new Error("Paystack error: transaction not refundable");
    if (t.refund !== "none" && t.refund !== "failed") return; // idempotent, like the real one
    t.refund = "in_progress";
    this.refunds.push(reference);
  }

  async refundState(reference: string): Promise<ProviderRefundState> {
    this.calls.push({ method: "refundState", reference });
    if (this.refundMode === "outage") throw new Error(`${PAYSTACK_UNAVAILABLE}: mock outage`);
    const t = this.txs.get(reference);
    if (!t) throw new Error("Paystack error: refund lookup could not find the transaction");
    return t.refund;
  }

  // ------------------------------------------------------------ scripting helpers

  /** The payer completes the hosted checkout (first payment or a 3D Secure step). */
  completeCheckout(reference: string, opts: { reusable?: boolean } = {}): void {
    const t = this.txs.get(reference);
    if (!t) throw new Error("mock: no such checkout");
    if (t.state === "pending") { t.state = "paid"; t.reusable = opts.reusable ?? true; }
  }

  failCheckout(reference: string): void {
    const t = this.txs.get(reference);
    if (t && t.state === "pending") t.state = "failed";
  }

  /** Refunds in progress become processed. Returns how many. */
  processRefunds(): number {
    let n = 0;
    for (const t of this.txs.values()) if (t.refund === "in_progress") { t.refund = "done"; n++; }
    return n;
  }

  /** Pretend the provider reports something else for this payment (forged amount / currency tests). */
  tamper(reference: string, patch: { amountKobo?: number; currency?: string; metadata?: Record<string, string> }): void {
    const t = this.txs.get(reference);
    if (!t) throw new Error("mock: no such payment");
    if (patch.amountKobo !== undefined) t.amountKobo = patch.amountKobo;
    if (patch.currency !== undefined) t.currency = patch.currency;
    if (patch.metadata !== undefined) t.metadata = patch.metadata;
  }

  /** A transaction made outside our flow (for example with our public key and chosen metadata): it must never become a spray. */
  injectForeignPayment(reference: string, amountKobo: number, metadata: Record<string, string>): void {
    this.txs.set(reference, { reference, amountKobo, currency: "NGN", metadata, split: { shares: [] }, state: "paid", via: "checkout", reusable: false, refund: "none" });
  }
}
