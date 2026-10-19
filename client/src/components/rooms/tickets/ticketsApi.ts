// Network for paid room tickets (task 4.7). The client never sends a price: checkout posts an empty body and the server
// charges its stored price. Every call keeps the status and the server's code, so the screens word refusals themselves.
import { call, type Call } from "../create/createRoomApi";
import type { RoomTicketSummary, RoomTicketView } from "@/lib/roomsApi";
import { parseSummary } from "@/lib/roomTickets";

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;

/** POST checkout. Body is {} on purpose: the amount comes from the room row on the server, never from here. */
export const startCheckout = (roomId: string): Promise<Call<{ url: string; reference: string }>> =>
  call<{ url: string; reference: string }>("POST", `${base(roomId)}/tickets/checkout`, {});

// One verify per reference at a time, across remounts (React strict mode runs effects twice in development, and a
// reload or a second tab may land on the same return URL). The server is idempotent on the reference anyway.
const inFlight = new Map<string, Promise<Call<{ ticket: RoomTicketView }>>>();
export function verifyTicket(roomId: string, reference: string): Promise<Call<{ ticket: RoomTicketView }>> {
  const key = `${roomId}:${reference}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = call<{ ticket: RoomTicketView }>("POST", `${base(roomId)}/tickets/verify`, { reference })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

export type RefundResult = "refunded" | "already" | "not_allowed";
export async function refundMyTicket(roomId: string): Promise<Call<{ result: RefundResult }>> {
  return call<{ result: RefundResult }>("POST", `${base(roomId)}/tickets/refund`, {});
}

export const cancelTicketedRoom = (roomId: string): Promise<Call<unknown>> => call<unknown>("POST", `${base(roomId)}/cancel`, {});

/** GET summary (host only). A body that is not the expected shape is reported as a failure, never drawn. */
export async function fetchTicketSummary(roomId: string): Promise<Call<RoomTicketSummary>> {
  const r = await call<unknown>("GET", `${base(roomId)}/tickets/summary`);
  if (!r.ok) return r;
  const s = parseSummary(r.body);
  return s ? { ok: true, body: s } : { ok: false, status: 500 };
}
