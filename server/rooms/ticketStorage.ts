// Paid rooms (phase 4): the reads the door and the room routes need from room_tickets, the host payout-account check, and
// the one room write that must not race a ticket sale. Ticket rows are WRITTEN elsewhere (server/rooms/tickets.ts issues
// them, server/rooms/refunds.ts refunds them); nothing here creates or changes a ticket.
import { and, eq, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { rooms, roomTickets, type Room } from "@shared/schema";
import { roomPatchSet, type RoomPatch } from "./roomStorage";

/** True when this person holds a PAID ticket for this room (a refunded ticket is not a ticket). */
export async function hasPaidTicket(roomId: string, userId: string): Promise<boolean> {
  const rows = await db.select({ id: roomTickets.id }).from(roomTickets)
    .where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.userId, userId), eq(roomTickets.status, "paid"))).limit(1);
  return rows.length > 0;
}

/** How many PAID tickets the room has (refunded ones do not count). */
export async function countPaidTickets(roomId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(roomTickets)
    .where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.status, "paid")));
  return Number(row?.n ?? 0);
}

/**
 * The host can be paid: a Paystack row in organizer_payment_accounts (made by the existing organizer onboarding,
 * server/organizer-payments-routes.ts) with a subaccount code and payouts enabled. Never reads or returns bank details.
 */
export async function hasVerifiedPayoutAccount(userId: string): Promise<boolean> {
  const acct = await storage.getOrganizerPaymentAccount(userId, "paystack");
  return !!acct && acct.payoutsEnabled === true && !!acct.paystackSubaccountCode;
}

export type TicketGuardCode = "TICKETS_SOLD" | "CAPACITY_BELOW_SOLD";
/** Thrown (inside the transaction, so nothing is written) when a ticket-guarded room change is refused. */
export class TicketGuardError extends Error {
  constructor(public code: TicketGuardCode, public sold: number) { super(code); }
}

/**
 * Applies a room patch that touches the ticket settings, in one transaction that first locks the room row:
 *  - `lockedBySale`: the change is not allowed once any ticket is sold (price, free/paid switch, age limit of a ticketed
 *    room, taking back the refund promise);
 *  - `capacity`: the new ticket capacity, never below the tickets already sold.
 * The paid-ticket count is read under the room row lock. A ticket issuer that locks the same row (SELECT ... FOR UPDATE or
 * an UPDATE of the rooms row) in the transaction that inserts the ticket is serialised with this write.
 */
export async function updateRoomWithTicketGuard(roomId: string, patch: RoomPatch, guard: { lockedBySale: boolean; capacity: number | null }): Promise<Room> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`);
    const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(roomTickets)
      .where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.status, "paid")));
    const sold = Number(c?.n ?? 0);
    if (guard.lockedBySale && sold > 0) throw new TicketGuardError("TICKETS_SOLD", sold);
    if (guard.capacity !== null && guard.capacity < sold) throw new TicketGuardError("CAPACITY_BELOW_SOLD", sold);
    const [row] = await tx.update(rooms).set(roomPatchSet(patch) as Partial<Room>).where(eq(rooms.id, roomId)).returning();
    return row;
  });
}
