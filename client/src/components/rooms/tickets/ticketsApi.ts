// Network for paid room tickets (task 4.7). The client never sends a price: checkout posts an empty body and the server
// charges its stored price. Every call keeps the status and the server's code, so the screens word refusals themselves.
// Checkout, refund, cancel and the summary are gated on canViewRoom(room, user, ?token=), so an invite-only room's token
// rides along on each of them (withToken). Verify needs none: the reference is MAC-bound to this buyer and room.
// Dev note: there is no browser mock payment provider. An end-to-end run in development needs Paystack TEST keys, or the
// /dev/room-fixture?ticket=... scenes (a fake fetch, no network).
import { call, type Call } from "../create/createRoomApi";
import type { RoomTicketSummary } from "@/lib/roomsApi";
import { parseSummary, withToken } from "@/lib/roomTickets";

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;

/** POST checkout. Body is {} on purpose: the amount comes from the room row on the server, never from here. */
export const startCheckout = (roomId: string, token?: string): Promise<Call<{ url: string; reference: string }>> =>
  call<{ url: string; reference: string }>("POST", `${base(roomId)}/tickets/checkout${withToken(token)}`, {});

// One verify per reference at a time, across remounts (React strict mode runs effects twice in development, and a
// reload or a second tab may land on the same return URL). The server is idempotent on the reference anyway.
// The body is read by verifyOutcome (roomTickets.ts): only a ticket with status "paid" is "You are in".
const inFlight = new Map<string, Promise<Call<unknown>>>();
export function verifyTicket(roomId: string, reference: string): Promise<Call<unknown>> {
  const key = `${roomId}:${reference}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = call<unknown>("POST", `${base(roomId)}/tickets/verify`, { reference })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/** POST refund (the caller's own ticket only). The body is read by refundOutcome: refunded, already, or still on its way. */
export const refundMyTicket = (roomId: string, token?: string): Promise<Call<unknown>> =>
  call<unknown>("POST", `${base(roomId)}/tickets/refund${withToken(token)}`, {});

export const cancelTicketedRoom = (roomId: string, token?: string): Promise<Call<unknown>> =>
  call<unknown>("POST", `${base(roomId)}/cancel${withToken(token)}`, {});

/** GET summary (host only), `{ summary: {...} }`. A body that is not the expected shape is reported as a failure, never drawn. */
export async function fetchTicketSummary(roomId: string, token?: string): Promise<Call<RoomTicketSummary>> {
  const r = await call<unknown>("GET", `${base(roomId)}/tickets/summary${withToken(token)}`);
  if (!r.ok) return r;
  const s = parseSummary(r.body);
  return s ? { ok: true, body: s } : { ok: false, status: 500 };
}
