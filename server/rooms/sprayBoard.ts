// The room's spray board: the top three sprayers by V3C, and what one person has been sprayed so far in this room. Both are
// read from delivered sprays in the database (never kept in memory), so a restart or a late joiner sees the same numbers.
// An anonymous payer (any delivered spray of theirs in the room chose it) shows as "Anonymous" with no id; admins read
// spray_payments directly and always see the payer.
import { pool } from "../storage";
import { roomHub } from "./RoomHub";
import { ANON_SPRAYER_ID } from "@shared/spray";

export interface BoardRow { id: string; name: string; v3c: number; anonymous: boolean }
export interface Received { kobo: number; v3c: number }

export async function sprayBoardFor(roomId: string): Promise<BoardRow[]> {
  const r = await pool.query(
    `select p.payer_id, sum(p.v3c)::bigint as v3c, bool_or(p.anonymous) as anon, u.display_name, u.username
       from spray_payments p join users u on u.id = p.payer_id
      where p.room_id = $1 and p.status = 'delivered'
      group by p.payer_id, u.display_name, u.username
      order by sum(p.v3c) desc, min(p.delivered_at) asc
      limit 3`,
    [roomId],
  );
  return r.rows.map((x: { payer_id: string; v3c: string; anon: boolean; display_name: string | null; username: string }) => (
    x.anon ? { id: ANON_SPRAYER_ID, name: "Anonymous", v3c: Number(x.v3c), anonymous: true }
      : { id: x.payer_id, name: x.display_name || x.username || "Someone", v3c: Number(x.v3c), anonymous: false }));
}

/** What this person was sprayed in this room: their own share in naira (kobo) and the V3C. Only ever sent to them. */
export async function sprayReceivedFor(roomId: string, userId: string): Promise<Received> {
  const r = await pool.query(
    `select coalesce(sum(case when recipient_id = host_id then host_kobo else coalesce(guest_kobo, 0) end), 0)::bigint as kobo,
            coalesce(sum(v3c), 0)::bigint as v3c
       from spray_payments where room_id = $1 and recipient_id = $2 and status = 'delivered'`,
    [roomId, userId],
  );
  return { kobo: Number(r.rows[0]?.kobo ?? 0), v3c: Number(r.rows[0]?.v3c ?? 0) };
}

/** After a delivery: everyone gets the board, each recipient their own total. Never throws: it is only a display. */
export async function announceBoard(roomId: string, recipientIds: readonly string[]): Promise<void> {
  try {
    roomHub.broadcast(roomId, { type: "room:spray_board", top: await sprayBoardFor(roomId) });
    for (const id of Array.from(new Set(recipientIds))) roomHub.sendTo(id, { type: "room:spray_received", roomId, ...(await sprayReceivedFor(roomId, id)) });
  } catch (e) {
    console.error("[rooms:spray] board announcement failed:", (e as Error)?.message ?? e);
  }
}
