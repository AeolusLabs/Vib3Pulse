// Rooms phase 6, task 6.2: the viewer's own earnings, read from stored rows and summed by computeEarnings
// (shared/roomEarnings.ts, pure and property-tested). Every query is keyed on the viewer's id from the session: the host of
// the room (tickets, payouts), the host or recipient of a spray, the beneficiary of a clawback. Nothing here takes another
// user's id, and no payer identity is ever read (no payer_id / user_id of a buyer is selected).
// A person who lost ID verification keeps their history: reading needs only a signed-in account. Receiving new money is
// gated elsewhere (phase 5 spray gate, hostCanSellNow), unchanged.
import { pool } from "../storage";
import { computeEarnings, type EarningsInput, type EarningsRange, type RoomEarnings } from "@shared/roomEarnings";

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";
/** Rows of a query on a table a later migration creates: none while that migration has not been applied. */
async function rowsOrNone(text: string, values: unknown[]): Promise<any[]> {
  try { return (await pool.query(text, values)).rows; }
  catch (e) { if (isMissingTable(e)) return []; throw e; }
}
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Everything computeEarnings needs for this viewer, and nothing about anyone else. */
export async function loadEarningsInput(viewerId: string): Promise<EarningsInput> {
  const [tickets, sprays, payouts, clawbacks] = await Promise.all([
    rowsOrNone(
      `select t.id, t.room_id, r.host_id, t.host_kobo, t.status, round(extract(epoch from t.created_at) * 1000)::float8 as created_ms
         from room_tickets t join rooms r on r.id = t.room_id
        where r.host_id = $1 and t.status = 'paid'`,
      [viewerId],
    ),
    rowsOrNone(
      `select id, room_id, host_id, recipient_id, host_kobo, guest_kobo, status,
              round(extract(epoch from delivered_at) * 1000)::float8 as delivered_ms,
              round(extract(epoch from coalesce(paid_at, created_at)) * 1000)::float8 as paid_ms
         from spray_payments
        where (host_id = $1 or recipient_id = $1)
          and ((delivered_at is not null and status in ('delivered', 'disputed'))
               or status in ('reversing', 'reversed', 'disputed'))`,
      [viewerId],
    ),
    rowsOrNone(
      `select room_id, host_id, status, amount_kobo, round(extract(epoch from release_at) * 1000)::float8 as release_ms
         from room_payouts where host_id = $1`,
      [viewerId],
    ),
    rowsOrNone(
      `select beneficiary_id, amount_kobo, recovered_kobo, status from host_clawbacks where beneficiary_id = $1 and status = 'open'`,
      [viewerId],
    ),
  ]);
  const roomIds = Array.from(new Set<string>([...tickets.map((t) => t.room_id as string), ...sprays.map((s) => s.room_id as string)]));
  const rooms = roomIds.length
    ? (await pool.query(`select id, title from rooms where id = any($1::varchar[])`, [roomIds])).rows as { id: string; title: string }[]
    : [];
  return {
    viewerId,
    rooms: rooms.map((r) => ({ id: r.id, title: r.title ?? "" })),
    tickets: tickets.map((t) => ({
      id: String(t.id), roomId: t.room_id, hostId: t.host_id, hostKobo: num(t.host_kobo), status: t.status, createdAtMs: num(t.created_ms),
    })),
    sprays: sprays.map((s) => ({
      id: String(s.id), roomId: s.room_id, hostId: s.host_id, recipientId: s.recipient_id, hostKobo: num(s.host_kobo),
      guestKobo: s.guest_kobo === null || s.guest_kobo === undefined ? null : num(s.guest_kobo), status: s.status, deliveredAtMs: msOrNull(s.delivered_ms),
      // A charged spray (refunded or disputed) was split at charge time; a dispute can arrive without our paid_at, so the
      // row's created_at stands in for it.
      paidAtMs: msOrNull(s.paid_ms),
    })),
    payouts: payouts.map((p) => ({ roomId: p.room_id, hostId: p.host_id, status: p.status, amountKobo: num(p.amount_kobo), releaseAtMs: num(p.release_ms) })),
    clawbacks: clawbacks.map((c) => ({ beneficiaryId: c.beneficiary_id, amountKobo: num(c.amount_kobo), recoveredKobo: num(c.recovered_kobo), status: c.status })),
  };
}

/** GET /api/users/me/room-earnings for the session's user. */
export async function earningsFor(viewerId: string, range: EarningsRange, nowMs: number = Date.now()): Promise<RoomEarnings> {
  return computeEarnings(await loadEarningsInput(viewerId), { range, nowMs });
}
