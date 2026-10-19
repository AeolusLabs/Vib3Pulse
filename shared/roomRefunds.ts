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
/**
 * A refund the PROVIDER REJECTED is retried automatically for this long after the first rejection; after that only an
 * admin follows up. A lookup outage is never capped (the job keeps asking until the provider answers).
 */
export const REFUND_RETRY_FOR_MS = 24 * HOUR;
/** A refund still owed (provider not confirmed) this long raises one finance alert (payment_issues refund_overdue). */
export const REFUND_OVERDUE_MS = 24 * HOUR;
/** A refused charge (S2 auto_* row) younger than this is left to the request that refused it; the job only picks up stragglers. */
export const AUTO_REFUND_JOB_DELAY_MS = 10 * MIN;
/** A payout whose bank could not be matched is tried again at most this often (and that attempt is counted only once). */
export const BANK_UNRESOLVED_RETRY_MS = HOUR;

/** A payout an admin put on hold: release_at is pushed to this sentinel (no new status or column). */
export const PAYOUT_HOLD_SENTINEL_ISO = "9999-12-31T00:00:00.000Z";
export const PAYOUT_HOLD_SENTINEL_MS = Date.parse(PAYOUT_HOLD_SENTINEL_ISO);
/** release_at at (or past) the sentinel = held by an admin. */
export function isAdminHold(releaseAtMs: number | null | undefined): boolean {
  return releaseAtMs !== null && releaseAtMs !== undefined && Number.isFinite(releaseAtMs) && releaseAtMs >= PAYOUT_HOLD_SENTINEL_MS;
}
/** last_error prefix of an admin hold (followed by the admin's reason, sanitized). */
export const ADMIN_HOLD_NOTE = "ADMIN_HOLD";

/** Refused charges (lane S2) are stored as room_tickets rows with refund_reason auto_*: never a ticket, never host money. */
export function isAutoRefundReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("auto_");
}

/**
 * Why a room that ended must NOT pay its host (its paid tickets are refunded with host_cancelled instead), or null.
 * minors' room (never ticketed by the rules; fail safe if one is), moderation not approved, closed for a host review, or a
 * host who may not host it any more (under 18, age unknown, or below the room's age limit after a birthdate correction).
 */
export type PayoutBlock = "MINORS_ROOM" | "NOT_APPROVED" | "HOST_REVIEW" | "HOST_NOT_ELIGIBLE";
export function payoutBlockReason(r: { minorsRoom: boolean; moderationStatus: string | null; hostReview?: boolean; hostAge: number | null; minAge: number }): PayoutBlock | null {
  if (r.minorsRoom) return "MINORS_ROOM";
  if ((r.moderationStatus ?? "approved") !== "approved") return "NOT_APPROVED";
  if (r.hostReview) return "HOST_REVIEW";
  if (r.hostAge === null || r.hostAge < 18 || r.hostAge < r.minAge) return "HOST_NOT_ELIGIBLE";
  return null;
}
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

/**
 * The deterministic references. Paystack transfer references must be lowercase alphanumeric with - or _, at least 16 long.
 * A payout is first sent as `room-payout-<roomId>`. Only after Paystack gave a CONCLUSIVE failure (failed, reversed...) and
 * an admin requeued it does it get a new generation `room-payout-<roomId>-r<n>` (a new reference is a new transfer, so it
 * is never used while an earlier one might still go through).
 */
export const payoutReference = (roomId: string, generation = 1) =>
  generation <= 1 ? `room-payout-${roomId.toLowerCase()}` : `room-payout-${roomId.toLowerCase()}-r${generation}`;
/** The generation of a payout reference for this room, or null when it is not one of this room's references. */
export function payoutGeneration(roomId: string, ref: string | null | undefined): number | null {
  if (!ref) return null;
  const base = `room-payout-${roomId.toLowerCase()}`;
  if (ref === base) return 1;
  const m = ref.startsWith(`${base}-r`) ? /^(\d{1,4})$/.exec(ref.slice(base.length + 2)) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 2 ? n : null;
}
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

/**
 * The buyer's refund notification. Amount in naira, the room title, the reason. Never card or bank data.
 * stage "pending": the provider accepted the refund but has not processed it ("on its way"); "processed": the provider
 * reports it done ("refunded"). Never says "refunded" before the provider does.
 */
export function refundNotice(amountKobo: number, roomTitle: string, reason: RefundReason, stage: "pending" | "processed" = "processed"): { title: string; message: string } {
  if (stage === "pending") {
    return {
      title: "Refund on its way",
      message: `Your refund of ${nairaText(amountKobo)} for "${roomTitle}" is on its way. ${REASON_LINE[reason]} It can take a few working days to reach your account.`,
    };
  }
  return {
    title: "Ticket refunded",
    message: `Your ${nairaText(amountKobo)} ticket for "${roomTitle}" was refunded. ${REASON_LINE[reason]} It can take a few working days to reach your account.`,
  };
}

/**
 * A payment we did not turn into a ticket (lane S2 refused it: sold out, amount mismatch, not eligible, duplicate) is
 * returned. Never "the host cancelled": the host had nothing to do with it.
 */
export function returnedPaymentNotice(amountKobo: number, stage: "pending" | "processed"): { title: string; message: string } {
  return stage === "pending"
    ? { title: "Payment on its way back", message: `Your payment of ${nairaText(amountKobo)} for the ticket is on its way back to you. It can take a few working days to reach your account.` }
    : { title: "Payment returned", message: `Your payment of ${nairaText(amountKobo)} for the ticket was returned. It can take a few working days to reach your account.` };
}

/** The deterministic key stored in notifications.related_entity_id so a retry can never notify twice. */
export const refundNoticeKey = (ticketId: string, stage: "pending" | "processed") => `${ticketRefundReference(ticketId)}:${stage}`;

/** Errors stored in room_payouts.last_error / payment_issues: no digit runs that could be an account number, short. */
export function sanitizeMoneyError(raw: unknown): string {
  const s = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "unknown error";
  return s.replace(/\d{6,}/g, "[number]").replace(/[\r\n\t]+/g, " ").slice(0, 200);
}
