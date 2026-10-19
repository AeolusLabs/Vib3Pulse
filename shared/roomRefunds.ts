// Paid room tickets: refund window, automatic refund, payout hold and transfer status rules, as pure functions so the
// server (the gate) and the client (which only mirrors them to decide what to offer) agree. All times are epoch ms;
// all amounts are integer kobo.

export type Check<C extends string> = { ok: true } | { ok: false; code: C };

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A buyer may ask for their money back until this long before the start time (and only if the host allowed it). */
export const BUYER_REFUND_CUTOFF_MS = 60 * MIN;
/** A scheduled room with sold tickets that has not started this long after its start time is cancelled and refunded. */
export const NEVER_STARTED_GRACE_MS = 60 * MIN;
/** A ticketed room with no start time that is still not started this long after it was created counts as never started. */
export const NO_START_TIME_GRACE_MS = 24 * HOUR;
/** The host is paid this long after the room ends (the window for complaints and refunds). */
export const PAYOUT_HOLD_MS = 48 * HOUR;
/** Settlement gives up on a payout (status failed, admin alert) after this many failed attempts. */
export const MAX_PAYOUT_ATTEMPTS = 5;
/** Unconfirmed provider refunds are retried automatically for this long; after that only an admin follows up. */
export const REFUND_RETRY_FOR_MS = 24 * HOUR;
/** Both jobs run this often. */
export const MONEY_JOB_EVERY_MS = 5 * MIN;

export type RefundReason = "buyer" | "host_cancelled" | "never_started" | "oversold";
export const REFUND_REASONS: readonly RefundReason[] = ["buyer", "host_cancelled", "never_started", "oversold"];
export type RefundResult = "refunded" | "already" | "not_allowed";

export type BuyerRefundCode = "ROOM_NOT_SCHEDULED" | "NO_REFUNDS" | "NO_START_TIME" | "WINDOW_CLOSED";

/**
 * May a ticket holder get their own money back now? Only while the room is still scheduled (never once it started or
 * ended), only when the host kept "refunds before start" on, and only until 60 minutes before the start time.
 * A room with no start time gives the buyer no self refund (they are covered by host cancel and the never-started rule).
 */
export function buyerRefundCheck(room: { status: string; refundBeforeStart: boolean; scheduledForMs: number | null }, nowMs: number): Check<BuyerRefundCode> {
  if (room.status !== "scheduled") return { ok: false, code: "ROOM_NOT_SCHEDULED" };
  if (!room.refundBeforeStart) return { ok: false, code: "NO_REFUNDS" };
  if (room.scheduledForMs === null || !Number.isFinite(room.scheduledForMs)) return { ok: false, code: "NO_START_TIME" };
  return nowMs < room.scheduledForMs - BUYER_REFUND_CUTOFF_MS ? { ok: true } : { ok: false, code: "WINDOW_CLOSED" };
}

/** The last moment a buyer can refund, or null when there is no self refund for this room. For the client's copy. */
export function buyerRefundDeadline(room: { refundBeforeStart: boolean; scheduledForMs: number | null }): number | null {
  if (!room.refundBeforeStart || room.scheduledForMs === null) return null;
  return room.scheduledForMs - BUYER_REFUND_CUTOFF_MS;
}

/** Non-buyer reasons are always allowed by policy; only the payout guard (money already released to the host) stops them. */
export function reasonNeedsBuyerWindow(reason: RefundReason): boolean {
  return reason === "buyer";
}

/** A scheduled room (never started) whose start time is this far behind us: the refund job cancels it and refunds everyone. */
export function isNeverStarted(room: { status: string; scheduledForMs: number | null; createdAtMs: number }, nowMs: number): boolean {
  if (room.status !== "scheduled") return false;
  const deadline = room.scheduledForMs !== null ? room.scheduledForMs + NEVER_STARTED_GRACE_MS : room.createdAtMs + NO_START_TIME_GRACE_MS;
  return nowMs >= deadline;
}

/** When the host's money is released. */
export function payoutReleaseAt(endedAtMs: number): number {
  return endedAtMs + PAYOUT_HOLD_MS;
}

/** A refund may touch a room's money only while the payout is still held (or does not exist yet). */
export function refundAllowedByPayout(payoutStatus: string | null): boolean {
  return payoutStatus === null || payoutStatus === "held";
}

/**
 * What a Paystack transfer status means for us. "success" pays; "pending"-like ones wait (never re-sent: same reference);
 * "otp" needs a person (the Paystack account asks for an OTP; it must be off for automatic payouts); the rest are final
 * failures that need an admin (money is never re-sent automatically after a final failure).
 */
export type TransferOutcome = "paid" | "wait" | "needs_otp" | "final_failure";
export function classifyTransferStatus(status: string | null | undefined): TransferOutcome {
  switch ((status ?? "").toLowerCase()) {
    case "success": return "paid";
    case "pending": case "received": case "processing": case "queued": return "wait";
    case "otp": return "needs_otp";
    case "failed": case "reversed": case "abandoned": case "blocked": case "rejected": return "final_failure";
    default: return "wait"; // unknown: never assume failure (that could lead to paying twice), never assume success
  }
}

/** After a failed attempt: how many attempts now, and whether the payout is given up (failed + alert). */
export function afterFailedAttempt(attempts: number): { attempts: number; giveUp: boolean } {
  const next = attempts + 1;
  return { attempts: next, giveUp: next >= MAX_PAYOUT_ATTEMPTS };
}

/** The deterministic references. Paystack transfer references must be lowercase alphanumeric with - or _, at least 16 long. */
export const payoutReference = (roomId: string) => `room-payout-${roomId.toLowerCase()}`;
export const ticketRefundReference = (ticketId: string) => `ticket-refund-${ticketId.toLowerCase()}`;
export function isValidTransferReference(ref: string): boolean {
  return ref.length >= 16 && ref.length <= 100 && /^[a-z0-9_-]+$/.test(ref);
}

/** "₦5,000" or "₦5,000.50" from kobo. Plain, for notifications. */
export function nairaText(kobo: number): string {
  const whole = Math.trunc(kobo / 100);
  const rest = Math.abs(kobo % 100);
  return `₦${whole.toLocaleString("en-NG")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

const REASON_LINE: Record<RefundReason, string> = {
  buyer: "You asked for this refund.",
  host_cancelled: "The host cancelled the room.",
  never_started: "The room did not start.",
  oversold: "The room was already full.",
};

/** The buyer's refund notification. Amount in naira, the room title, the reason. Never card or bank data. */
export function refundNotice(amountKobo: number, roomTitle: string, reason: RefundReason): { title: string; message: string } {
  return {
    title: "Ticket refunded",
    message: `Your ${nairaText(amountKobo)} ticket for "${roomTitle}" was refunded. ${REASON_LINE[reason]} It can take a few working days to reach your account.`,
  };
}

/** Errors stored in room_payouts.last_error / payment_issues: no digit runs that could be an account number, short. */
export function sanitizeMoneyError(raw: unknown): string {
  const s = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "unknown error";
  return s.replace(/\d{6,}/g, "[number]").replace(/[\r\n\t]+/g, " ").slice(0, 200);
}
