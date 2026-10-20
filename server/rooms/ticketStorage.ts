// Paid rooms (phase 4): the reads the door and the room routes need from room_tickets, the host payout-account check, and
// the one room write that must not race a ticket sale. Ticket rows are WRITTEN elsewhere (server/rooms/tickets.ts issues
// them, server/rooms/refunds.ts refunds them); nothing here creates or changes a ticket.
import { and, eq, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { rooms, roomTickets, type Room } from "@shared/schema";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import { roomPatchSet, type RoomPatch } from "./roomStorage";
import { hostPayoutReady } from "./payouts";

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
 * The host can be paid. Phase 6: kept as a name for existing callers and tests; the rule lives in ONE place,
 * hostPayoutReady (server/rooms/payouts.ts), which the spray gate and canSellTickets' input read too.
 */
export async function hasVerifiedPayoutAccount(userId: string): Promise<boolean> {
  return hostPayoutReady(userId);
}

/**
 * May this host still sell tickets right now? Re-checked at checkout and when a charge is turned into a ticket: the host
 * is an ID-verified adult (account not deleted) AND still has a verified payout account. Either one gone pauses sales.
 * Not the paidRooms switch (checkout checks that first; a charge already taken is finished whatever it says).
 */
export async function hostCanSellNow(hostId: string): Promise<boolean> {
  const host = await storage.getUser(hostId);
  if (!host || host.deletedAt || !isIdVerifiedAdult(host)) return false;
  return hasVerifiedPayoutAccount(hostId);
}

export type TicketGuardCode = "TICKETS_SOLD" | "CAPACITY_BELOW_SOLD" | "NOT_SCHEDULED";
/** Thrown (inside the transaction, so nothing is written) when a ticket-guarded room change is refused. */
export class TicketGuardError extends Error {
  constructor(public code: TicketGuardCode, public sold: number) { super(code); }
}

/**
 * Applies a room patch that touches the ticket settings, in one transaction that first locks the room row:
 *  - `lockedBySale`: the change is not allowed once any ticket is sold (price, free/paid switch, age limit of a ticketed
 *    room, taking back the refund promise);
 *  - `capacity`: the new ticket capacity, never below the tickets already sold;
 *  - `requireScheduled`: a free room becoming ticketed: only while it has not started (a live room would have people
 *    inside without tickets taking the paid seats).
 * The paid-ticket count is read under the room row lock. A ticket issuer that locks the same row (SELECT ... FOR UPDATE or
 * an UPDATE of the rooms row) in the transaction that inserts the ticket is serialised with this write.
 */
export async function updateRoomWithTicketGuard(
  roomId: string, patch: RoomPatch, guard: { lockedBySale: boolean; capacity: number | null; requireScheduled?: boolean },
): Promise<Room> {
  return db.transaction(async (tx) => {
    // The status is read under the same lock: starting a room is a conditional UPDATE of this row, so it waits for us
    // (or we see it live) and a free room can never turn ticketed after it went live.
    const [locked] = await tx.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId)).for("update");
    if (guard.requireScheduled && locked?.status !== "scheduled") throw new TicketGuardError("NOT_SCHEDULED", 0);
    const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(roomTickets)
      .where(and(eq(roomTickets.roomId, roomId), eq(roomTickets.status, "paid")));
    const sold = Number(c?.n ?? 0);
    if (guard.lockedBySale && sold > 0) throw new TicketGuardError("TICKETS_SOLD", sold);
    if (guard.capacity !== null && guard.capacity < sold) throw new TicketGuardError("CAPACITY_BELOW_SOLD", sold);
    const [row] = await tx.update(rooms).set(roomPatchSet(patch) as Partial<Room>).where(eq(rooms.id, roomId)).returning();
    return row;
  });
}
