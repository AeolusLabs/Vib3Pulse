// Door check-in persistence: short-code lookup, admit/undo with an audit log, stats.
// Everything works on a `kind` ('event' = tickets table, 'venue' = venue_tickets table) so the
// event and venue-night flows share one implementation.
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  tickets,
  venueTickets,
  ticketTiers,
  users,
  checkInLog,
  eventStaffAccessCodes,
  venueStaffAccessCodes,
  type Ticket,
  type VenueTicket,
} from "@shared/schema";
import { db } from "./storage";

export type DoorKind = "event" | "venue";
export type DoorTicket = Ticket | VenueTicket;

/** Who is admitting / undoing: a redeemed staff code, or the owning organiser's session. */
export interface DoorActor {
  type: "staff" | "organizer";
  staffCodeId: string | null;
  name: string;
  /** The organiser's user id; stored as checkedInBy so the audit trail links to an account. */
  organizerId: string;
}

export interface TicketInfo {
  id: string;
  holderName: string;
  tierName: string | null;
  checkedInAt: Date | null;
  checkedInByName: string | null;
}

/** Venue tickets flip to 'checked_in' on admit, so both count as holding a valid ticket. */
const VENUE_LIVE = ["confirmed", "checked_in"];

/** Tickets in one event/night whose validationCode starts with the 8 hex chars. Capped at 2: we only need 0 / 1 / many. */
export async function findTicketsByShortCode(kind: DoorKind, scopeId: string, hex8: string): Promise<DoorTicket[]> {
  // hex8 comes from normalizeShortCode (hex only), so it is safe to splice into a LIKE pattern.
  const pattern = `${hex8}%`;
  if (kind === "event") {
    return db.select().from(tickets)
      .where(and(eq(tickets.eventId, scopeId), sql`${tickets.validationCode} LIKE ${pattern}`))
      .limit(2);
  }
  return db.select().from(venueTickets)
    .where(and(eq(venueTickets.venueEntryNightId, scopeId), sql`${venueTickets.validationCode} LIKE ${pattern}`))
    .limit(2);
}

/** holderName = displayName || username || guestName || "Guest"; tierName from the tier join (events only). */
export async function getHolderAndTier(kind: DoorKind, ticket: DoorTicket): Promise<{ holderName: string; tierName: string | null }> {
  let user: { displayName: string | null; username: string } | undefined;
  if (ticket.userId) {
    [user] = await db.select({ displayName: users.displayName, username: users.username })
      .from(users).where(eq(users.id, ticket.userId));
  }
  const guestName = kind === "event" ? (ticket as Ticket).guestName : null;
  const holderName = user?.displayName || user?.username || guestName || "Guest";

  let tierName: string | null = null;
  if (kind === "event" && (ticket as Ticket).ticketTierId) {
    const [tier] = await db.select({ name: ticketTiers.name }).from(ticketTiers)
      .where(eq(ticketTiers.id, (ticket as Ticket).ticketTierId!));
    tierName = tier?.name ?? null;
  }
  return { holderName, tierName };
}

/** The `ticketInfo` object returned on valid / already_used validate results. */
export async function buildTicketInfo(kind: DoorKind, ticket: DoorTicket): Promise<TicketInfo> {
  const { holderName, tierName } = await getHolderAndTier(kind, ticket);
  let checkedInByName: string | null = null;
  if (ticket.checkedInAt) {
    // Staff check-ins carry the staff name in the log; organiser check-ins fall back to their display name.
    const [last] = await db.select({ actorName: checkInLog.actorName }).from(checkInLog)
      .where(and(eq(checkInLog.ticketId, ticket.id), eq(checkInLog.action, "admit")))
      .orderBy(desc(checkInLog.createdAt)).limit(1);
    if (last) {
      checkedInByName = last.actorName;
    } else if (ticket.checkedInBy) {
      const [by] = await db.select({ displayName: users.displayName, username: users.username })
        .from(users).where(eq(users.id, ticket.checkedInBy));
      checkedInByName = by?.displayName || by?.username || null;
    }
  }
  return { id: ticket.id, holderName, tierName, checkedInAt: ticket.checkedInAt ?? null, checkedInByName };
}

/**
 * Atomic admit + log row (+ staff scan count) in one transaction.
 * Returns null if a concurrent request admitted the ticket first.
 */
export async function admitTicket(kind: DoorKind, scopeId: string, ticket: DoorTicket, actor: DoorActor): Promise<DoorTicket | null> {
  const { holderName, tierName } = await getHolderAndTier(kind, ticket);
  return db.transaction(async (tx) => {
    const updated = kind === "event"
      ? (await tx.update(tickets)
          .set({ checkedInAt: new Date(), checkedInBy: actor.organizerId })
          .where(and(eq(tickets.id, ticket.id), sql`${tickets.checkedInAt} IS NULL`))
          .returning())[0]
      : (await tx.update(venueTickets)
          .set({ checkedInAt: new Date(), checkedInBy: actor.organizerId, status: "checked_in" })
          .where(and(eq(venueTickets.id, ticket.id), sql`${venueTickets.checkedInAt} IS NULL`))
          .returning())[0];
    if (!updated) return null;

    await tx.insert(checkInLog).values({
      kind, eventId: scopeId, ticketId: ticket.id, action: "admit",
      actorType: actor.type, staffCodeId: actor.staffCodeId, actorName: actor.name,
      holderName, tierName,
    });
    if (actor.staffCodeId) {
      if (kind === "event") {
        await tx.update(eventStaffAccessCodes)
          .set({ scanCount: sql`${eventStaffAccessCodes.scanCount} + 1` })
          .where(eq(eventStaffAccessCodes.id, actor.staffCodeId));
      } else {
        await tx.update(venueStaffAccessCodes)
          .set({ scanCount: sql`${venueStaffAccessCodes.scanCount} + 1` })
          .where(eq(venueStaffAccessCodes.id, actor.staffCodeId));
      }
    }
    return updated;
  });
}

export type UndoResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_checked_in" | "window_expired" };

/**
 * Clears a check-in, writes the 'undo' log row, and gives the scan back to whichever staff code
 * admitted it (found via the latest 'admit' log row; never below 0). `notBefore` is the staff
 * undo window: a check-in older than that cannot be undone.
 */
export async function undoCheckIn(
  kind: DoorKind, scopeId: string, ticketId: string, actor: DoorActor, notBefore: Date | null,
): Promise<UndoResult> {
  return db.transaction(async (tx) => {
    // Lock the row so two simultaneous undos cannot both decrement the scan count.
    const [row] = kind === "event"
      ? await tx.select().from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, scopeId))).for("update")
      : await tx.select().from(venueTickets)
          .where(and(eq(venueTickets.id, ticketId), eq(venueTickets.venueEntryNightId, scopeId))).for("update");
    if (!row) return { ok: false, reason: "not_found" } as const;
    if (!row.checkedInAt) return { ok: false, reason: "not_checked_in" } as const;
    if (notBefore && row.checkedInAt < notBefore) return { ok: false, reason: "window_expired" } as const;

    if (kind === "event") {
      await tx.update(tickets).set({ checkedInAt: null, checkedInBy: null }).where(eq(tickets.id, ticketId));
    } else {
      await tx.update(venueTickets)
        .set({ checkedInAt: null, checkedInBy: null, status: sql`CASE WHEN ${venueTickets.status} = 'checked_in' THEN 'confirmed' ELSE ${venueTickets.status} END` })
        .where(eq(venueTickets.id, ticketId));
    }

    const [admit] = await tx.select({ staffCodeId: checkInLog.staffCodeId }).from(checkInLog)
      .where(and(eq(checkInLog.ticketId, ticketId), eq(checkInLog.action, "admit")))
      .orderBy(desc(checkInLog.createdAt)).limit(1);
    if (admit?.staffCodeId) {
      if (kind === "event") {
        await tx.update(eventStaffAccessCodes)
          .set({ scanCount: sql`GREATEST(${eventStaffAccessCodes.scanCount} - 1, 0)` })
          .where(eq(eventStaffAccessCodes.id, admit.staffCodeId));
      } else {
        await tx.update(venueStaffAccessCodes)
          .set({ scanCount: sql`GREATEST(${venueStaffAccessCodes.scanCount} - 1, 0)` })
          .where(eq(venueStaffAccessCodes.id, admit.staffCodeId));
      }
    }

    const holder = await holderOf(tx, row);
    await tx.insert(checkInLog).values({
      kind, eventId: scopeId, ticketId, action: "undo",
      actorType: actor.type, staffCodeId: actor.staffCodeId, actorName: actor.name,
      holderName: holder.holderName, tierName: holder.tierName,
    });
    return { ok: true } as const;
  });
}

// Same lookup as getHolderAndTier but on the transaction handle.
async function holderOf(tx: any, ticket: DoorTicket): Promise<{ holderName: string; tierName: string | null }> {
  let user: { displayName: string | null; username: string } | undefined;
  if (ticket.userId) {
    [user] = await tx.select({ displayName: users.displayName, username: users.username })
      .from(users).where(eq(users.id, ticket.userId));
  }
  const isEvent = "eventId" in ticket;
  const guestName = isEvent ? (ticket as Ticket).guestName : null;
  let tierName: string | null = null;
  if (isEvent && (ticket as Ticket).ticketTierId) {
    const [tier] = await tx.select({ name: ticketTiers.name }).from(ticketTiers)
      .where(eq(ticketTiers.id, (ticket as Ticket).ticketTierId!));
    tierName = tier?.name ?? null;
  }
  return { holderName: user?.displayName || user?.username || guestName || "Guest", tierName };
}

export interface CheckInLogEntry {
  id: string;
  action: string;
  ticketId: string;
  holderName: string;
  tierName: string | null;
  actorName: string;
  createdAt: Date;
}

/** Newest-first door log for one event / night (all staff). */
export async function getCheckInLog(kind: DoorKind, scopeId: string, limit: number): Promise<CheckInLogEntry[]> {
  return db.select({
    id: checkInLog.id,
    action: checkInLog.action,
    ticketId: checkInLog.ticketId,
    holderName: checkInLog.holderName,
    tierName: checkInLog.tierName,
    actorName: checkInLog.actorName,
    createdAt: checkInLog.createdAt,
  }).from(checkInLog)
    .where(and(eq(checkInLog.kind, kind), eq(checkInLog.eventId, scopeId)))
    .orderBy(desc(checkInLog.createdAt), desc(checkInLog.id))
    .limit(limit);
}

/** admitted = checked in; total = tickets that can still get in (confirmed, or venue 'checked_in'). */
export async function getDoorCounts(kind: DoorKind, scopeId: string): Promise<{ admitted: number; total: number }> {
  if (kind === "event") {
    const [r] = await db.select({
      admitted: sql<number>`count(*) FILTER (WHERE ${isNotNull(tickets.checkedInAt)})::int`,
      total: sql<number>`count(*)::int`,
    }).from(tickets).where(and(eq(tickets.eventId, scopeId), eq(tickets.status, "confirmed")));
    return r;
  }
  const [r] = await db.select({
    admitted: sql<number>`count(*) FILTER (WHERE ${isNotNull(venueTickets.checkedInAt)})::int`,
    total: sql<number>`count(*)::int`,
  }).from(venueTickets)
    .where(and(eq(venueTickets.venueEntryNightId, scopeId), inArray(venueTickets.status, VENUE_LIVE)));
  return r;
}
