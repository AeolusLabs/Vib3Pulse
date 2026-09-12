// Single write path for the payment_transactions ledger. Route handlers should
// always call this instead of writing to storage directly, so "how much has
// the platform taken" stays answerable from one table instead of ad-hoc SUMs.
//
// Never throws — a ledger write failing must never take down the payment flow
// that already succeeded. Failures are logged for manual reconciliation.
import { storage } from "../storage.js";
import type { InsertPaymentTransaction, PaymentTransaction } from "@shared/schema";

export async function recordTransaction(tx: InsertPaymentTransaction): Promise<PaymentTransaction | null> {
  try {
    return await storage.createPaymentTransaction(tx);
  } catch (err) {
    console.error("[Ledger] Failed to record transaction:", tx.type, tx.providerPaymentId, err);
    return null;
  }
}
