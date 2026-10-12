import { addHours, format, isToday, isTomorrow } from "date-fns";
import type { Event, Ticket, Venue, VenueEntryNight, VenueTicket } from "@shared/schema";
import { formatMoney } from "@/lib/currency";
import { shortCodeOf } from "@shared/ticketCode";

export type EventTicketRow = Ticket & { event: Event; tier?: { id: string; name: string } | null };
export type VenueTicketRow = VenueTicket & { entryNight: VenueEntryNight; venue: Venue };

export type TicketState = "valid" | "checked_in" | "not_used" | "pending" | "cancelled";

/** One ticket from either source, in the shape the wallet and the pass both draw. */
export interface WalletTicket {
  id: string;
  kind: "event" | "venue";
  /** events.id or venue_entry_nights.id */
  targetId: string;
  title: string;
  place: string;
  startsAt: Date;
  endsAt: Date | null;
  doorsAt: Date | null;
  imageUrl: string | null;
  tierName: string | null;
  priceLabel: string;
  validationCode: string;
  shortCode: string;
  checkedInAt: Date | null;
  status: string;
  detailPath: string;
  directionsUrl: string | null;
  address: string | null;
  policy: { age: number | null; dress: string | null } | null;
  /** Tickets for the same event and tier are shown as "2 tickets". */
  groupKey: string;
  purchasedAt: Date;
}

const mapsLink = (lat?: number | null, lon?: number | null, query?: string | null) =>
  lat != null && lon != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
    : query
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
      : null;

function fromEvent(t: EventTicketRow): WalletTicket {
  const e = t.event;
  const startsAt = new Date(e.eventDate);
  return {
    id: t.id,
    kind: "event",
    targetId: e.id,
    title: e.title,
    place: e.venueName ? `${e.venueName} · ${e.location}` : e.location,
    startsAt,
    endsAt: e.eventEndDate ? new Date(e.eventEndDate) : null,
    doorsAt: e.doorsOpenAt ? new Date(e.doorsOpenAt) : null,
    imageUrl: e.imageUrl ?? null,
    tierName: t.tier?.name ?? null,
    priceLabel: t.amountPaid > 0 ? formatMoney(t.amountPaid, t.currency) : "Free",
    validationCode: t.validationCode,
    shortCode: shortCodeOf(t.validationCode),
    checkedInAt: t.checkedInAt ? new Date(t.checkedInAt) : null,
    status: t.status,
    detailPath: `/event/${e.id}`,
    directionsUrl: mapsLink(e.latitude, e.longitude, e.location),
    address: e.location,
    policy: null,
    groupKey: `event:${e.id}:${t.tier?.id ?? ""}`,
    purchasedAt: new Date(t.purchaseDate),
  };
}

function fromVenue(t: VenueTicketRow): WalletTicket {
  const n = t.entryNight;
  const v = t.venue;
  const startsAt = new Date(n.date);
  const address = [v.address, v.city].filter(Boolean).join(", ") || v.location;
  return {
    id: t.id,
    kind: "venue",
    targetId: n.id,
    title: n.name,
    place: `${v.name}${v.city ? ` · ${v.city}` : ""}`,
    startsAt,
    endsAt: n.endTime ? new Date(n.endTime) : null,
    doorsAt: null,
    imageUrl: n.imageUrl ?? v.coverImageUrl ?? v.imageUrl ?? null,
    tierName: "Entry",
    priceLabel: t.amountPaid > 0 ? formatMoney(t.amountPaid, t.currency) : "Free",
    validationCode: t.validationCode,
    shortCode: shortCodeOf(t.validationCode),
    checkedInAt: t.checkedInAt ? new Date(t.checkedInAt) : null,
    status: t.status,
    detailPath: `/venue-events/${n.id}`,
    directionsUrl: mapsLink(v.latitude, v.longitude, address),
    address,
    policy: v.ageRestriction || v.dressCode ? { age: v.ageRestriction ?? null, dress: v.dressCode ?? null } : null,
    groupKey: `venue:${n.id}`,
    purchasedAt: new Date(t.purchaseDate),
  };
}

export function buildWalletTickets(eventRows: EventTicketRow[], venueRows: VenueTicketRow[]): WalletTicket[] {
  return [...eventRows.map(fromEvent), ...venueRows.map(fromVenue)];
}

/** A ticket stays "upcoming" until the event ends (or 6 hours after it starts when no end is set), so it does not vanish mid-event. */
export function endOf(t: WalletTicket): Date {
  return t.endsAt ?? addHours(t.startsAt, 6);
}

export const isPast = (t: WalletTicket, now = new Date()) => endOf(t) < now;

export function ticketState(t: WalletTicket, now = new Date()): TicketState {
  if (t.status === "pending_approval") return "pending";
  // Venue tickets flip to "checked_in" when scanned; that is still a good ticket.
  if (t.status !== "confirmed" && t.status !== "checked_in") return "cancelled";
  if (t.checkedInAt) return "checked_in";
  return isPast(t, now) ? "not_used" : "valid";
}

export const stateLabel: Record<TicketState, { label: string; tone: "ok" | "muted" | "warn" | "bad" }> = {
  valid: { label: "Ready", tone: "ok" },
  checked_in: { label: "Attended", tone: "muted" },
  not_used: { label: "Not used", tone: "warn" },
  pending: { label: "Awaiting approval", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "bad" },
};

/** "Happening now", "Tonight · in 3 h", "Tomorrow", or "Sat 17 Oct". */
export function whenLabel(t: WalletTicket, now = new Date()): { label: string; live: boolean } {
  if (now >= t.startsAt && now < endOf(t)) return { label: "Happening now", live: true };
  if (isToday(t.startsAt)) {
    const hrs = Math.ceil((+t.startsAt - +now) / 3600e3);
    return { label: hrs > 0 && hrs <= 12 ? `Tonight · in ${hrs} h` : "Tonight", live: true };
  }
  if (isTomorrow(t.startsAt)) return { label: "Tomorrow", live: false };
  return { label: format(t.startsAt, "EEE d MMM"), live: false };
}

/** Collapse tickets for the same event and tier into one row with a quantity. */
export function groupTickets(list: WalletTicket[]): Array<{ key: string; lead: WalletTicket; tickets: WalletTicket[] }> {
  const groups = new Map<string, WalletTicket[]>();
  for (const t of list) groups.set(t.groupKey, [...(groups.get(t.groupKey) ?? []), t]);
  return Array.from(groups.entries()).map(([key, tickets]) => ({ key, lead: tickets[0], tickets }));
}
