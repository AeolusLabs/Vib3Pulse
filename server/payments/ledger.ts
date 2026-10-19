// Single write path for the payment_transactions ledger. Route handlers should
// always call this instead of writing to storage directly, so "how much has
// the platform taken" stays answerable from one table instead of ad-hoc SUMs.
//
// Never throws — a ledger write failing must never take down the payment flow
// that already succeeded. Failures are logged for manual reconciliation.
// Exception: with `{ tx }` (see below) it throws, on purpose.
import { storage, db } from "../storage.js";
import { paymentTransactions, type InsertPaymentTransaction, type PaymentTransaction } from "@shared/schema";

export type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function recordTransaction(tx: InsertPaymentTransaction): Promise<PaymentTransaction | null>;
/**
 * Inside the caller's database transaction. THROWS on failure instead of logging, so the money row it belongs to (for
 * example a room ticket) and its ledger row commit together or not at all: a replay can never find a ticket with no
 * ledger row, and a failed ledger write rolls the ticket back (the webhook then answers 500 and Paystack retries).
 */
export function recordTransaction(tx: InsertPaymentTransaction, opts: { tx: LedgerTx }): Promise<PaymentTransaction>;
export async function recordTransaction(tx: InsertPaymentTransaction, opts?: { tx: LedgerTx }): Promise<PaymentTransaction | null> {
  if (opts?.tx) {
    const [written] = await opts.tx.insert(paymentTransactions).values(tx).returning();
    return written;
  }
  try {
    return await storage.createPaymentTransaction(tx);
  } catch (err) {
    console.error("[Ledger] Failed to record transaction:", tx.type, tx.providerPaymentId, err);
    return null;
  }
}
