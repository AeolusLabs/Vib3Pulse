// Tells live rooms their spray state changed (room:settings with sprayOn). Goes through the room's ordered settings queue,
// so it can never overtake or be overtaken by a host settings write. Never throws: the change it announces is already committed.
import type { Room } from "@shared/schema";
import { pool } from "../storage";
import * as rs from "./roomStorage";
import { roomHub } from "./RoomHub";
import { writeRoomSettings } from "./roomSocket";
import { roomFeatures } from "./features";

/** Re-reads the row (fresh pause / freeze / block values) and sends room:settings to a live room. Call AFTER the change committed. */
export async function broadcastSprayState(roomId: string): Promise<void> {
  if (!roomFeatures.spray) return; // flag off: no new frame ever reaches a client
  try {
    await writeRoomSettings(roomId, async () => (await rs.getRoom(roomId)) as Room);
  } catch (e) {
    console.error("[rooms] spray state broadcast failed:", roomId, (e as Error)?.message ?? e);
  }
}

/** Rooms per batch in a platform-wide fan-out (each broadcast re-reads the row and does several queries). */
export const BROADCAST_CHUNK = 10;

/**
 * Platform pause / resume: every room with someone in it, in this process. Returns the number of rooms at once and sends in
 * the background in chunks of BROADCAST_CHUNK, so the admin's request never waits for (or hogs the pool with) the fan-out.
 */
export function broadcastSprayStateAll(): number {
  if (!roomFeatures.spray) return 0;
  const ids = roomHub.roomIds();
  void (async () => {
    for (let i = 0; i < ids.length; i += BROADCAST_CHUNK) await Promise.all(ids.slice(i, i + BROADCAST_CHUNK).map(broadcastSprayState));
  })().catch((e) => console.error("[rooms] spray state fan-out failed:", (e as Error)?.message ?? e));
  return ids.length;
}

/** Host freeze / unfreeze: that host's live rooms that have someone in them. */
export async function broadcastSprayStateForHost(hostId: string): Promise<void> {
  if (!roomFeatures.spray) return;
  try {
    const rows = (await pool.query(`select id from rooms where host_id = $1 and status = 'live'`, [hostId])).rows as { id: string }[];
    await Promise.all(rows.filter((r) => roomHub.count(r.id) > 0).map((r) => broadcastSprayState(r.id)));
  } catch (e) {
    console.error("[rooms] host spray state broadcast failed:", hostId, (e as Error)?.message ?? e);
  }
}
