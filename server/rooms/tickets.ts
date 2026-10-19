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
import { rooms, roomTickets, type RoomTicket } from "@shared/schema";
import { ticketBreakdown } from "@shared/money";
import { checkPurchase, refusalOf, ticketCode, type RoomTicketRefusal, type RoomTicketView } from "@shared/roomTickets";
import { refundPayment, type VerifiedSession } from "../payments/index";
import { recordTransaction } from "../payments/ledger";
import { isBlockedEitherWay } from "../utils/blocks";
import * as rs from "./roomStorage";
import { ticketReferenceBelongsTo, ticketReferenceSecret } from "./ticketReference";

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
const AUTO_REASON = {
  SOLD_OUT: "auto_sold_out",
  AMOUNT_MISMATCH: "auto_amount_mismatch",
  INELIGIBLE: "auto_ineligible",
  DUPLICATE: "auto_duplicate",
} as const;
const FROM_AUTO = new Map<string, RoomTicketRefusal | "DUPLICATE">(
  (Object.entries(AUTO_REASON) as Array<[RoomTicketRefusal | "DUPLICATE", string]>).map(([k, v]) => [v, k]),
);

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

/**
 * Refund a refused charge. Called only by the call that inserted its 'refunded' row, so at most once per reference.
 * Under the ticket's advisory lock and with the deterministic note (lane S3's refund job / webhook take the same lock and
 * look the note up first), so this and the job can never both send a refund for the row.
 */
async function refundRefusedCharge(row: RoomTicket, reference: string, outcome: string): Promise<void> {
  try {
    const { withAdvisoryLock, LOCK_TICKET, BUSY } = await import("./refunds");
    const { ticketRefundReference } = await import("@shared/roomRefunds");
    const sent = await withAdvisoryLock(LOCK_TICKET, row.id, async () => {
      await refundPayment(reference, "paystack", { note: ticketRefundReference(row.id) });
      return true;
    }, 8000);
    if (sent === BUSY) { logOutcome(reference, row.roomId, row.userId, `refund_left_to_job:${outcome}`); return; } // the job holds it: it looks up, then refunds
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
  | { kind: "refused"; row: RoomTicket; reason: RoomTicketRefusal | "DUPLICATE"; heldTicket: RoomTicket | null }
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

  // Inputs that do not race with other buyers: read before taking the lock, to keep the locked section short.
  const bound = ticketReferenceBelongsTo(reference, roomId, userId, ticketReferenceSecret());
  const [buyer, roomPeek, member] = await Promise.all([storage.getUser(userId), rs.getRoom(roomId), rs.getMember(roomId, userId)]);
  const blocked = roomPeek ? await isBlockedEitherWay(userId, roomPeek.hostId) : false;

  const decision = await db.transaction(async (tx): Promise<Decision> => {
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
      buyerId: userId, buyer, room, bannedOrBlocked: !!member?.banned || blocked,
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

    const reason: RoomTicketRefusal | "DUPLICATE" = check.code === "ALREADY_TICKETED" ? "DUPLICATE" : refusalOf(check.code);
    const heldTicket = reason === "DUPLICATE"
      ? ((await tx.select().from(roomTickets)
          .where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.userId, userId), eq(roomTickets.status, "paid"))).limit(1))[0] ?? null)
      : null;
    // The record of a refused charge: what the provider charged, no split, never counted as a seat or a payout.
    const charged = Number.isSafeInteger(opts.verifiedAmountKobo) && opts.verifiedAmountKobo > 0 ? opts.verifiedAmountKobo : 0;
    const [row] = await tx.insert(roomTickets).values({
      roomId, userId,
      amountKobo: charged, vatKobo: 0, feeKobo: 0, reserveKobo: 0, platformKobo: 0, hostKobo: 0,
      provider: "paystack", providerRef: reference, status: "refunded", refundReason: AUTO_REASON[reason],
    }).onConflictDoNothing().returning();
    if (!row) throw new Error("refused-charge insert conflicted under the room lock");
    return { kind: "refused", row, reason, heldTicket };
  });

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
      return { refunded: true, reason: decision.reason };
    }
  }
}

/**
 * A verified Paystack charge for a room ticket, from the webhook or the verify route. Returns null (and does nothing)
 * when the verified transaction is not a paid room charge for exactly this reference.
 */
export async function handleRoomTicketCharge(reference: string, verified: VerifiedSession): Promise<IssueRoomTicketResult | null> {
  const roomId = verified.metadata.roomId;
  const userId = verified.metadata.userId;
  if (!verified.paid || verified.provider !== "paystack" || verified.providerPaymentId !== reference || !roomId || !userId) {
    logOutcome(reference, roomId ?? "?", userId ?? "?", "ignored:not_a_paid_room_charge");
    return null;
  }
  return issueRoomTicket({
    roomId, userId, reference, provider: "paystack",
    verifiedAmountKobo: verified.amountSmallestUnit, currency: verified.currency,
  });
}
