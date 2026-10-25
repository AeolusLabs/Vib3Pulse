// Tells live rooms their spray state changed (room:settings with sprayOn). Goes through the room's ordered settings queue,
// so it can never overtake or be overtaken by a host settings write. Never throws: the change it announces is already committed.
import type { Room } from "@shared/schema";
import { pool } from "../storage";
import * as rs from "./roomStorage";
import { roomHub } from "./RoomHub";
import { writeRoomSettings } from "./roomSocket";

/** Re-reads the row (fresh pause / freeze / block values) and sends room:settings to a live room. Call AFTER the change committed. */
export async function broadcastSprayState(roomId: string): Promise<void> {
  try {
    await writeRoomSettings(roomId, async () => (await rs.getRoom(roomId)) as Room);
  } catch (e) {
    console.error("[rooms] spray state broadcast failed:", roomId, (e as Error)?.message ?? e);
  }
}

/** Platform pause / resume: every room with someone in it, in this process. */
export async function broadcastSprayStateAll(): Promise<number> {
  const ids = roomHub.roomIds();
  await Promise.all(ids.map(broadcastSprayState));
  return ids.length;
}

/** Host freeze / unfreeze: that host's live rooms that have someone in them. */
export async function broadcastSprayStateForHost(hostId: string): Promise<void> {
  try {
    const rows = (await pool.query(`select id from rooms where host_id = $1 and status = 'live'`, [hostId])).rows as { id: string }[];
    await Promise.all(rows.filter((r) => roomHub.count(r.id) > 0).map((r) => broadcastSprayState(r.id)));
  } catch (e) {
    console.error("[rooms] host spray state broadcast failed:", hostId, (e as Error)?.message ?? e);
  }
}
