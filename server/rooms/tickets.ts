// Room tickets: the single code path that turns a verified Paystack charge into a ticket, or into a refund.
// Used by the client's verify call (ticketRoutes.ts) and by the Paystack webhook (payment-routes.ts), in either order,
// any number of times, concurrently.
//
// Idempotency design (see the task 4.3 report for the long form):
// - room_tickets.provider_ref is UNIQUE. Every charge that reaches issueRoomTicket ends as exactly one row keyed by its
//   reference: status 'paid' (a ticket) or status 'refunded' with an auto_* refund_reason (a charge we refused).
// - All issuing for one room is serialised by a row lock on the room (SELECT ... FOR UPDATE). Under that lock we re-read
//   the reference, count the paid tickets, decide, insert, and write the ledger row in the same transaction. So the
//   capacity check and the insert cannot race (the last seat goes to exactly one buyer), and a webhook and a verify
//   for the same reference cannot both insert.
// - The ledger row is written inside that transaction (recordTransaction with { tx }): a ticket never exists without
//   its one ledger row, and a replay never writes a second one (it finds the row and returns it).
// - A refused charge is refunded only by the call that inserted its 'refunded' row, after the commit. Replays find the
//   row and never call the provider again, so there is no double refund. refunded_at is set once the provider accepts
//   the refund; a provider failure leaves refunded_at null and writes a payment_issues row for a person (or a retry job)
//   to finish.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { paymentIssues, rooms, roomTickets, type RoomTicket } from "@shared/schema";
import { ticketBreakdown } from "@shared/money";
import { checkPurchase, refusalOf, ticketCode, type RoomTicketRefusal, type RoomTicketView } from "@shared/roomTickets";
import { refundPayment, type VerifiedSession } from "../payments/index";
import { recordTransaction } from "../payments/ledger";
import { isBlockedEitherWay } from "../utils/blocks";
import * as rs from "./roomStorage";
import { ticketReferenceBelongsTo, ticketReferenceSecret } from "./ticketReference";
import { hostCanSellNow } from "./ticketStorage";
import { createKeyedQueue } from "./keyedQueue";

export { QueueFullError as IssueQueueFullError } from "./keyedQueue";

/**
 * Issuing is serialised per room IN THIS PROCESS before a pool connection is taken (see keyedQueue.ts): at most one
 * issue transaction per room holds a connection here, the others wait in memory. Beyond ISSUE_QUEUE_MAX waiting for one
 * room, issueRoomTicket throws IssueQueueFullError at once: the webhook answers 503 (Paystack retries) and the client's
 * verify answers 503 with Retry-After. Correctness does not depend on this queue: the room row lock still serialises
 * issuing across server instances, and everything stays idempotent on the reference.
 */
export const ISSUE_QUEUE_MAX = 10;
const issueQueue = createKeyedQueue({ maxPending: ISSUE_QUEUE_MAX });

/** Thrown by issueRoomTicket for a verified amount that is not a positive integer: no row can record it (CHECK amount > 0). */
export class UnrecordableChargeError extends Error {
  constructor(public reference: string) { super(`room ticket charge ${reference} has no positive integer amount`); this.name = "UnrecordableChargeError"; }
}

export { ticketCode } from "@shared/roomTickets";
export type { RoomTicketView } from "@shared/roomTickets";

export interface IssueRoomTicketOpts {
  roomId: string;
  userId: string;
  reference: string;
  provider: "paystack";
  /** The amount the PROVIDER says was charged (verify call), never a client or webhook-payload value. */
  verifiedAmountKobo: number;
  /** The provider's currency for the charge. Anything but NGN is refunded as AMOUNT_MISMATCH. Omitted: NGN. */
  currency?: string;
}

export type IssueRoomTicketResult =
  /** duplicateRefunded: this charge was a second payment by someone who already held a ticket; it was refunded and their ticket is returned. */
  | { ticket: RoomTicket; duplicateRefunded?: true }
  | { refunded: true; reason: RoomTicketRefusal };

// Stored in room_tickets.refund_reason for charges we refused. Distinct from lane S3's refund reasons
// ("buyer" | "host_cancelled" | "never_started" | "oversold"), which belong to real tickets refunded later.
// HOST_INELIGIBLE: the host lost ID verification or their payout account while the buyer was paying (answered to the
// buyer as INELIGIBLE, the contract code; kept apart in the row so finance can tell why).
type AutoReason = RoomTicketRefusal | "DUPLICATE" | "HOST_INELIGIBLE";
const AUTO_REASON: Record<AutoReason, string> = {
  SOLD_OUT: "auto_sold_out",
  AMOUNT_MISMATCH: "auto_amount_mismatch",
  INELIGIBLE: "auto_ineligible",
  DUPLICATE: "auto_duplicate",
  HOST_INELIGIBLE: "auto_host_ineligible",
};
const FROM_AUTO = new Map<string, RoomTicketRefusal | "DUPLICATE">([
  [AUTO_REASON.SOLD_OUT, "SOLD_OUT"],
  [AUTO_REASON.AMOUNT_MISMATCH, "AMOUNT_MISMATCH"],
  [AUTO_REASON.INELIGIBLE, "INELIGIBLE"],
  [AUTO_REASON.DUPLICATE, "DUPLICATE"],
  [AUTO_REASON.HOST_INELIGIBLE, "INELIGIBLE"],
]);

/** For the buyer only. Never the payment reference or the split. */
export function toTicketView(t: RoomTicket): RoomTicketView {
  return {
    id: t.id,
    roomId: t.roomId,
    code: ticketCode(t.id),
    amountKobo: t.amountKobo,
    status: t.status === "refunded" ? "refunded" : "paid",
    createdAt: new Date(t.createdAt).toISOString(),
  };
}

/** Reference, room, user and outcome only. Never amounts, card data, authorization codes or bank numbers. */
function logOutcome(reference: string, roomId: string, userId: string, outcome: string): void {
  console.log(`[rooms:tickets] ref=${reference} room=${roomId} user=${userId} outcome=${outcome}`);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export async function findTicketByReference(reference: string): Promise<RoomTicket | null> {
  const [row] = await db.select().from(roomTickets).where(eq(roomTickets.providerRef, reference)).limit(1);
  return row ?? null;
}

async function paidTicketOf(roomId: string, userId: string): Promise<RoomTicket | null> {
  const [row] = await db.select().from(roomTickets)
    .where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.userId, userId), eq(roomTickets.status, "paid"))).limit(1);
  return row ?? null;
}

/** Paid tickets in the room, and how many of them this user holds (0 or 1). Not locked: advisory, for checkout only. */
export async function ticketCountsFor(roomId: string, userId: string): Promise<{ paid: number; mine: number }> {
  const [c] = await db.select({
    paid: sql<number>`count(*)::int`,
    mine: sql<number>`(count(*) filter (where ${roomTickets.userId} = ${userId}))::int`,
  }).from(roomTickets).where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.status, "paid")));
  return { paid: Number(c?.paid ?? 0), mine: Number(c?.mine ?? 0) };
}

/**
 * What a reference that already has a row means now. A row for a different room or user than asked is never handed
 * out (cannot happen while references are bound by MAC; fail closed if it ever does).
 */
async function outcomeOfRow(row: RoomTicket, roomId: string, userId: string): Promise<IssueRoomTicketResult> {
  if (row.roomId !== roomId || row.userId !== userId) {
    logOutcome(row.providerRef ?? "?", roomId, userId, "reference_owned_by_other_ticket");
    throw new Error("This payment reference belongs to another ticket");
  }
  const auto = row.status === "refunded" && row.refundReason ? FROM_AUTO.get(row.refundReason) : undefined;
  if (auto === "DUPLICATE") {
    const paid = await paidTicketOf(roomId, userId);
    return paid ? { ticket: paid, duplicateRefunded: true } : { refunded: true, reason: "INELIGIBLE" };
  }
  if (auto) return { refunded: true, reason: auto };
  // A real ticket: paid, or refunded later by lane S3 (the view then shows status "refunded").
  return { ticket: row };
}

/**
 * The answer for a reference that was already processed, without calling the provider. null when nothing is stored for
 * it yet (the caller then verifies with the provider and calls issueRoomTicket).
 */
export async function replayRoomTicket(reference: string, roomId: string, userId: string): Promise<IssueRoomTicketResult | null> {
  const row = await findTicketByReference(reference);
  return row ? outcomeOfRow(row, roomId, userId) : null;
}

/** Refund a refused charge. Called only by the call that inserted its 'refunded' row, so at most once per reference. */
async function refundRefusedCharge(row: RoomTicket, reference: string, outcome: string): Promise<void> {
  try {
    await refundPayment(reference, "paystack");
  } catch (e) {
    logOutcome(reference, row.roomId, row.userId, `refund_failed:${outcome}`);
    await storage.createPaymentIssue({
      ticketId: row.id, providerPaymentId: reference, provider: "paystack", reason: "refund_failed", errorMessage: errText(e),
    }).catch((e2) => console.error(`[rooms:tickets] ref=${reference} could not record the failed refund, needs a person:`, errText(e2)));
    return;
  }
  logOutcome(reference, row.roomId, row.userId, `refunded:${outcome}`);
  // Separate from the refund itself: if only this write fails, the money is back and nothing must refund it again.
  await db.update(roomTickets).set({ refundedAt: new Date() })
    .where(and(eq(roomTickets.id, row.id), isNull(roomTickets.refundedAt)))
    .catch((e) => console.error(`[rooms:tickets] ref=${reference} refunded, but marking refunded_at failed:`, errText(e)));
}

type Decision =
  | { kind: "existing"; row: RoomTicket }
  | { kind: "issued"; ticket: RoomTicket }
  | { kind: "refused"; row: RoomTicket; reason: AutoReason; heldTicket: RoomTicket | null }
  | { kind: "no_row" }; // the room or the buyer's account no longer exists: nothing to attach a row to

/**
 * The single path from a verified charge to a ticket or a refund. Idempotent on `reference`; safe to call concurrently
 * from the webhook and the verify route (and from many buyers at once for the last seat).
 *
 * Callers must have verified the charge with the provider (paid, and this reference). verifiedAmountKobo is the
 * provider's amount; the price used is the room's stored price, read under the lock; the split is ticketBreakdown(price).
 */
export async function issueRoomTicket(opts: IssueRoomTicketOpts): Promise<IssueRoomTicketResult> {
  const { roomId, userId, reference } = opts;
  if (opts.provider !== "paystack") throw new Error("Room tickets are sold through Paystack only");

  // Replays (the usual second caller) answer from the stored row, without touching the room lock.
  const prior = await findTicketByReference(reference);
  if (prior) return outcomeOfRow(prior, roomId, userId);
  // No row can hold a charge of 0 or a fraction of a kobo (CHECK amount_kobo > 0): inserting one would fail on every
  // retry for ever. The caller (handleRoomTicketCharge) records a payment issue for a person instead.
  if (!Number.isSafeInteger(opts.verifiedAmountKobo) || opts.verifiedAmountKobo <= 0) throw new UnrecordableChargeError(reference);

  // Inputs that do not race with other buyers: read before taking the lock, to keep the locked section short.
  const bound = ticketReferenceBelongsTo(reference, roomId, userId, ticketReferenceSecret());
  const [buyer, roomPeek, member] = await Promise.all([storage.getUser(userId), rs.getRoom(roomId), rs.getMember(roomId, userId)]);
  // The host may have lost ID verification or their payout account since checkout: then the charge is refunded.
  const [blocked, hostCanSell]: [boolean, boolean] = roomPeek
    ? await Promise.all([isBlockedEitherWay(userId, roomPeek.hostId), hostCanSellNow(roomPeek.hostId)])
    : [false, false];

  // One issue transaction per room at a time in this process, queued in memory BEFORE a connection is taken.
  const decision = await issueQueue.run(roomId, () => db.transaction(async (tx): Promise<Decision> => {
    // The room row lock: every issue for this room waits here, one at a time.
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update");
    const [again] = await tx.select().from(roomTickets).where(eq(roomTickets.providerRef, reference)).limit(1);
    if (again) return { kind: "existing", row: again };
    if (!room || !buyer) return { kind: "no_row" };

    const [c] = await tx.select({
      paid: sql<number>`count(*)::int`,
      mine: sql<number>`(count(*) filter (where ${roomTickets.userId} = ${userId}))::int`,
    }).from(roomTickets).where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.status, "paid")));
    const paidCount = Number(c?.paid ?? 0);
    const mine = Number(c?.mine ?? 0);

    const check = checkPurchase({
      buyerId: userId, buyer, room, bannedOrBlocked: !!member?.banned || blocked, hostCanSell,
      paidCount, buyerHasPaid: mine > 0,
      payment: { bound, amountKobo: opts.verifiedAmountKobo, currency: opts.currency ?? "NGN" },
    });

    if (check.ok) {
      const b = ticketBreakdown(room.ticketPriceKobo as number); // checkPurchase proved it a sellable integer price
      const [ticket] = await tx.insert(roomTickets).values({
        roomId, userId,
        amountKobo: b.price, vatKobo: b.vat, feeKobo: b.fee, reserveKobo: b.reserve, platformKobo: b.platform, hostKobo: b.host,
        provider: "paystack", providerRef: reference, status: "paid",
      }).onConflictDoNothing().returning();
      // Under the lock neither unique index can conflict (reference and holder were both checked above). If one does,
      // something outside this path wrote a row: roll back and let the caller retry, which then reads that row.
      if (!ticket) throw new Error("room ticket insert conflicted under the room lock");
      await recordTransaction({
        type: "room_ticket",
        provider: "paystack",
        providerPaymentId: reference,
        currency: "NGN",
        buyerUserId: userId,
        organizerId: room.hostId,
        ticketId: ticket.id,
        grossAmount: b.price,
        platformFeeAmount: b.platform,
        netToOrganizerAmount: b.host,
        status: "succeeded",
      }, { tx });
      return { kind: "issued", ticket };
    }

    const reason: AutoReason = check.code === "ALREADY_TICKETED" ? "DUPLICATE"
      : check.code === "SALES_PAUSED" ? "HOST_INELIGIBLE"
      : refusalOf(check.code);
    const heldTicket = reason === "DUPLICATE"
      ? ((await tx.select().from(roomTickets)
          .where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.userId, userId), eq(roomTickets.status, "paid"))).limit(1))[0] ?? null)
      : null;
    // The record of a refused charge: what the provider charged (a positive integer, checked above), no split, never
    // counted as a seat or a payout.
    const [row] = await tx.insert(roomTickets).values({
      roomId, userId,
      amountKobo: opts.verifiedAmountKobo, vatKobo: 0, feeKobo: 0, reserveKobo: 0, platformKobo: 0, hostKobo: 0,
      provider: "paystack", providerRef: reference, status: "refunded", refundReason: AUTO_REASON[reason],
    }).onConflictDoNothing().returning();
    if (!row) throw new Error("refused-charge insert conflicted under the room lock");
    return { kind: "refused", row, reason, heldTicket };
  }));

  switch (decision.kind) {
    case "existing":
      return outcomeOfRow(decision.row, roomId, userId);
    case "issued":
      logOutcome(reference, roomId, userId, "issued");
      return { ticket: decision.ticket };
    case "no_row":
      // No row can be written (foreign keys), so nothing records this refund: a replay would try again. The provider
      // refuses a second full refund of one transaction, so money cannot go out twice; the failure is logged.
      logOutcome(reference, roomId, userId, "refusing:room_or_buyer_gone");
      try {
        await refundPayment(reference, "paystack");
        logOutcome(reference, roomId, userId, "refunded:room_or_buyer_gone");
      } catch (e) {
        logOutcome(reference, roomId, userId, "refund_failed:room_or_buyer_gone");
        await storage.createPaymentIssue({ providerPaymentId: reference, provider: "paystack", reason: "refund_failed", errorMessage: errText(e) })
          .catch((e2) => console.error(`[rooms:tickets] ref=${reference} could not record the failed refund, needs a person:`, errText(e2)));
      }
      return { refunded: true, reason: "INELIGIBLE" };
    case "refused": {
      await refundRefusedCharge(decision.row, reference, decision.reason);
      if (decision.reason === "DUPLICATE") {
        return decision.heldTicket ? { ticket: decision.heldTicket, duplicateRefunded: true } : { refunded: true, reason: "INELIGIBLE" };
      }
      return { refunded: true, reason: decision.reason === "HOST_INELIGIBLE" ? "INELIGIBLE" : decision.reason };
    }
  }
}

/**
 * A paid room charge we cannot turn into a ticket or a refund automatically: one unresolved payment_issues row per
 * reference (not repeated on retries), for a person to settle in Paystack. Never throws.
 */
export async function openRoomChargeIssue(reference: string, why: string): Promise<void> {
  try {
    const [open] = await db.select({ id: paymentIssues.id }).from(paymentIssues)
      .where(and(eq(paymentIssues.providerPaymentId, reference), eq(paymentIssues.reason, "room_charge_unhandled"), isNull(paymentIssues.resolvedAt)))
      .limit(1);
    if (open) return;
    await storage.createPaymentIssue({ providerPaymentId: reference, provider: "paystack", reason: "room_charge_unhandled", errorMessage: why.slice(0, 500) });
  } catch (e) {
    console.error(`[rooms:tickets] ref=${reference} could not record an unhandled room charge, needs a person:`, errText(e));
  }
}

/**
 * A verified Paystack charge for a room ticket, from the webhook or the verify route. Returns null when the verified
 * transaction is not a paid room charge for exactly this reference. A PAID charge that still cannot be handled (no room or
 * buyer in the verified metadata, another reference, an amount that is not a positive integer) gets a payment issue for a
 * person, and null: retrying would never change the answer, so the webhook can answer 200.
 */
export async function handleRoomTicketCharge(reference: string, verified: VerifiedSession): Promise<IssueRoomTicketResult | null> {
  const roomId = verified.metadata.roomId;
  const userId = verified.metadata.userId;
  if (!verified.paid || verified.provider !== "paystack") {
    logOutcome(reference, roomId ?? "?", userId ?? "?", "ignored:not_paid");
    return null;
  }
  if (verified.providerPaymentId !== reference || !roomId || !userId) {
    logOutcome(reference, roomId ?? "?", userId ?? "?", "unhandled:metadata");
    await openRoomChargeIssue(reference, "Paid room ticket charge without a usable room or buyer in the verified metadata");
    return null;
  }
  if (!Number.isSafeInteger(verified.amountSmallestUnit) || verified.amountSmallestUnit <= 0) {
    logOutcome(reference, roomId, userId, "unhandled:amount");
    await openRoomChargeIssue(reference, "Paid room ticket charge whose verified amount is not a positive whole number of kobo");
    return null;
  }
  try {
    return await issueRoomTicket({
      roomId, userId, reference, provider: "paystack",
      verifiedAmountKobo: verified.amountSmallestUnit, currency: verified.currency,
    });
  } catch (e) {
    if (e instanceof UnrecordableChargeError) { // not reachable after the check above; kept so it can never loop
      await openRoomChargeIssue(reference, "Paid room ticket charge whose verified amount is not a positive whole number of kobo");
      return null;
    }
    throw e;
  }
}
