// Admin spray money ledger: the response shapes (binding for the admin screens) and the pure helpers behind them
// (endedAs, the synthetic timeline for rows that predate spray_events, the CSV cell rules). No database, no secrets here.
import type { SprayStatus } from "./spray";

export interface LedgerRow {
  id: string;
  kind: "single" | "team_share";
  batchId: string | null;
  roomId: string;
  roomTitle: string;
  hostId: string;
  hostUsername: string;
  payerId: string;
  payerUsername: string;
  recipientId: string;
  recipientUsername: string;
  tier: string;
  amountKobo: number;
  status: SprayStatus;
  /** A plain English line: where this one ended (see endedAs). */
  endedAs: string;
  /** The provider charge reference (a team share shows its batch's reference: the one charge). */
  providerRef: string;
  createdAt: string;
  deliveredAt: string | null;
  reversedAt: string | null;
}

export interface TimelineEntry { at: string | null; fromStatus: string | null; toStatus: string; source: string; detail: string | null }

export interface LedgerDetail {
  tx: LedgerRow & {
    vatKobo: number; feeKobo: number; reserveKobo: number; platformKobo: number; hostKobo: number; guestKobo: number | null;
    provider: string; reason: string | null; paidAt: string | null; refundRequestedAt: string | null;
    /** Last 4 characters only. The host's current verified payout subaccount (a team batch: the one fixed for it). */
    hostSubaccountLast4: string | null;
    recipientSubaccountLast4: string | null;
  };
  timeline: TimelineEntry[];
  /** true: built from the row's own timestamps because no spray_events exist for it (it predates the log). */
  synthetic: boolean;
  siblings: LedgerRow[];
}

export interface FunnelBucket { count: number; kobo: number }
export interface OutcomesResponse {
  funnel: { initiated: FunnelBucket; paid: FunnelBucket; delivered: FunnelBucket; failed: FunnelBucket; reversed: FunnelBucket; disputed: FunnelBucket; pending: FunnelBucket };
  byDay: Array<{ day: string } & Record<"initiated" | "paid" | "delivered" | "failed" | "reversed" | "disputed" | "pending", FunnelBucket>>;
}

export type AttentionKind = "pending" | "reversing" | "paid_not_delivered" | "disputed";
export interface AttentionItem { kind: AttentionKind; why: string; ageMinutes: number; tx: LedgerRow }

export interface ProviderCheckResult {
  ours: { status: string; amountKobo: number };
  provider: { status: string; amountKobo: number; paidAt: string | null; feeKobo: number | null; refunded: boolean; refundedKobo: number; split: { subaccountLast4: string[] } | null } | null;
  match: boolean;
  mismatches: string[];
  checkedAt: string;
}

/** Funnel bucket of a status. initiated = all; the other six partition it (reversing counts as reversed, created as pending). */
export function funnelBucket(status: string): "paid" | "delivered" | "failed" | "reversed" | "disputed" | "pending" {
  switch (status) {
    case "paid": return "paid";
    case "delivered": return "delivered";
    case "failed": return "failed";
    case "reversed": case "reversing": return "reversed";
    case "disputed": return "disputed";
    default: return "pending";
  }
}

const REASON_WORDS: Record<string, string> = {
  DECLINED: "card declined", INSUFFICIENT_FUNDS: "insufficient funds", NOT_REUSABLE: "saved card cannot be reused", NETWORK: "payment could not be started",
  RECIPIENT_LEFT: "recipient left", ROOM_ENDED: "room ended", TIMEOUT: "payment not completed in time", DISPUTED: "disputed",
  AMOUNT_MISMATCH: "amount did not match", NOT_DELIVERABLE: "could not be delivered", HOST_CAP: "host receive cap", LATE_PAYMENT: "paid after it had failed",
};

/** Plain English: where this spray ended up. Pure; covers every status. */
export function endedAs(row: { status: string; reason?: string | null; recipientUsername?: string | null }): string {
  switch (row.status) {
    case "delivered": return `Delivered to ${row.recipientUsername || "the recipient"}`;
    case "reversed": return "Refunded to payer";
    case "reversing": return "Reversing";
    case "failed": return `Failed: ${(row.reason && REASON_WORDS[row.reason]) || (row.reason ? row.reason.toLowerCase().replace(/_/g, " ") : "no reason recorded")}`;
    case "disputed": return "Disputed";
    case "paid": return "Paid, not yet delivered";
    case "created": case "pending": return "Still pending";
    default: return "Unknown";
  }
}

/** Timeline for a row with no spray_events (it predates the log), from its own timestamps and reason. at is null when unknown. */
export function syntheticTimeline(r: {
  status: string; reason: string | null; createdAt: string; paidAt: string | null; deliveredAt: string | null; reversedAt: string | null; refundRequestedAt: string | null;
}): TimelineEntry[] {
  const e = (at: string | null, from: string | null, to: string, detail: string | null = null): TimelineEntry => ({ at, fromStatus: from, toStatus: to, source: "system", detail });
  const out: TimelineEntry[] = [e(r.createdAt, null, "created")];
  if (r.status === "pending") out.push(e(null, "created", "pending"));
  if (r.paidAt) out.push(e(r.paidAt, "pending", "paid"));
  if (r.refundRequestedAt) out.push(e(r.refundRequestedAt, r.paidAt ? "paid" : "failed", "reversing", r.reason));
  if (r.deliveredAt) out.push(e(r.deliveredAt, "paid", "delivered"));
  if (r.reversedAt) out.push(e(r.reversedAt, "reversing", "reversed", r.reason));
  if (r.status === "failed") out.push(e(null, "pending", "failed", r.reason));
  if (r.status === "disputed") out.push(e(null, r.deliveredAt ? "delivered" : null, "disputed", r.reason));
  return out.sort((a, b) => (a.at === null ? 1 : 0) - (b.at === null ? 1 : 0) || (a.at ?? "").localeCompare(b.at ?? ""));
}

/** One CSV cell: injection guard first (a leading = + - @ tab or CR gets a leading '), then quoting when needed. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: readonly unknown[]): string => cells.map(csvCell).join(",");
export const ngn = (kobo: number | null | undefined): string => ((kobo ?? 0) / 100).toFixed(2);

export const CSV_COLUMNS = [
  "id", "created_at", "status", "ended_as", "room", "host", "payer", "recipient", "tier", "amount_ngn",
  "vat", "fee", "reserve", "platform", "host_share", "recipient_share", "provider_ref", "batch_id",
] as const;

/** What differs between our row and the provider's record of the same charge (empty = they agree). Pure. */
export function compareWithProvider(
  ours: { status: string; amountKobo: number }, p: NonNullable<ProviderCheckResult["provider"]> & { currency?: string } | null,
): string[] {
  if (!p) return ["The provider has no record of this reference"];
  const out: string[] = [];
  if (p.amountKobo !== ours.amountKobo) out.push(`Amount differs: ours ${ours.amountKobo} kobo, provider ${p.amountKobo} kobo`);
  if (p.currency && p.currency !== "NGN") out.push(`Provider currency is ${p.currency}, not NGN`);
  const taken = p.status === "success";
  const refunded = p.refunded || p.status === "reversed";
  switch (ours.status) {
    case "delivered": case "paid": case "disputed":
      if (!taken && !refunded) out.push(`We show ${ours.status} but the provider status is ${p.status}`);
      if (refunded) out.push(`We show ${ours.status} but the provider has refunded it`);
      break;
    case "reversing":
      if (!taken && !refunded) out.push(`We show reversing but the provider status is ${p.status}`);
      break;
    case "reversed":
      if (!refunded) out.push("We show reversed but the provider has not refunded it in full");
      break;
    default: // created, pending, failed: no money should have been taken
      if (taken && !refunded) out.push(`We show ${ours.status} but the provider has taken the payment`);
  }
  return out;
}
