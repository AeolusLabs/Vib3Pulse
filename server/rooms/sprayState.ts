// The one answer to "is spraying on in this room right now". Everything that shows or gates spraying reads it.
import type { Room } from "@shared/schema";
import { pool } from "../storage";
import { roomFeatures } from "./features";
import { moneyEligibleRoom } from "@shared/roomRules";
import { getControl, isHostFrozen } from "./roomControls";

export type SprayOffReason = "FEATURE_OFF" | "ROOM_NOT_ELIGIBLE" | "PAUSED" | "HOST_OFF" | "ADMIN_BLOCKED" | "HOST_FROZEN";
export type SprayEffective = { on: boolean; reason: null | SprayOffReason };

/** First failing reason wins, in this order. Phase "deliver" of an already charged spray never asks (see sprayGate). */
/** A lane room (a game room's age lane) is blocked when its game room is: a lane opened after the block must not spray. */
export async function laneParentBlocked(room: { parentRoomId?: string | null }): Promise<boolean> {
  if (!room.parentRoomId) return false;
  const r = await pool.query(`select spray_admin_blocked from rooms where id = $1`, [room.parentRoomId]);
  return r.rows[0]?.spray_admin_blocked === true;
}

export async function sprayEffectiveFor(room: Pick<Room, "hostId" | "sprayEnabled" | "sprayAdminBlocked" | "ageLimit" | "minorsRoom" | "parentRoomId">): Promise<SprayEffective> {
  const off = (reason: SprayOffReason): SprayEffective => ({ on: false, reason });
  if (roomFeatures.spray !== true) return off("FEATURE_OFF");
  if (!moneyEligibleRoom(room)) return off("ROOM_NOT_ELIGIBLE");
  if (await getControl("sprays_paused")) return off("PAUSED");
  if (room.sprayEnabled !== true) return off("HOST_OFF");
  if (room.sprayAdminBlocked === true || await laneParentBlocked(room)) return off("ADMIN_BLOCKED");
  if (await isHostFrozen(room.hostId)) return off("HOST_FROZEN");
  return { on: true, reason: null };
}

// ---------------------------------------------------------------- host toggle cooldown
/** Host flips of rooms.spray_enabled: one per room per 3 s (in this process; gone when the room ends). */
export const SPRAY_TOGGLE_COOLDOWN_MS = 3000;
const lastToggle = new Map<string, number>();
export const sprayToggleCooldown = {
  /** Milliseconds still to wait before this room may flip again (0 = now). */
  retryMs(roomId: string, now = Date.now()): number {
    const at = lastToggle.get(roomId);
    return at === undefined ? 0 : Math.max(0, at + SPRAY_TOGGLE_COOLDOWN_MS - now);
  },
  mark(roomId: string, now = Date.now()): void {
    if (lastToggle.size > 5000) lastToggle.forEach((at, id) => { if (now - at > SPRAY_TOGGLE_COOLDOWN_MS) lastToggle.delete(id); });
    lastToggle.set(roomId, now);
  },
  clear(roomId: string): void { lastToggle.delete(roomId); },
};

// ---------------------------------------------------------------- admin per-room block
/**
 * found false: no such room. changed false: already in that state (nothing written). roomIds: every room written (the room and
 * its not-ended lane children, which are separate rows where sprays actually happen).
 */
export async function setRoomSprayBlock(p: { roomId: string; on: boolean; adminId: string; reason: string }): Promise<{ found: boolean; ended: boolean; changed: boolean; roomIds: string[] }> {
  const cur = (await pool.query(`select status from rooms where id = $1`, [p.roomId])).rows[0] as { status: string } | undefined;
  if (!cur) return { found: false, ended: false, changed: false, roomIds: [] };
  if (cur.status === "ended") return { found: true, ended: true, changed: false, roomIds: [] };
  const r = p.on
    ? await pool.query(
      `update rooms set spray_admin_blocked = true, spray_block_reason = $2, spray_blocked_by = $3, spray_blocked_at = now()
        where (id = $1 or parent_room_id = $1) and status <> 'ended' and spray_admin_blocked = false returning id`, [p.roomId, p.reason, p.adminId])
    : await pool.query(
      `update rooms set spray_admin_blocked = false, spray_block_reason = null, spray_blocked_by = null, spray_blocked_at = null
        where (id = $1 or parent_room_id = $1) and status <> 'ended' and spray_admin_blocked = true returning id`, [p.roomId]);
  return { found: true, ended: false, changed: (r.rowCount ?? 0) > 0, roomIds: r.rows.map((x: { id: string }) => x.id) };
}

export interface SprayStatus {
  platformFlag: boolean; paused: boolean; frozenHosts: number; liveRoomsSprayOn: number;
  blockedRooms: { roomId: string; title: string; reason: string | null; byAdminId: string | null; byAdminName: string | null; at: string | null }[];
  /** Why the platform pause is on, who set it and when; null when not paused. */
  pausedInfo: { reason: string; byName: string | null; at: string } | null;
}

export async function sprayStatus(): Promise<SprayStatus> {
  const paused = await getControl("sprays_paused");
  const [frozen, live, blocked, pauseRow] = await Promise.all([
    pool.query(`select count(*)::int as n from room_host_freezes`),
    roomFeatures.spray && !paused
      ? pool.query(`select count(*)::int as n from rooms r where r.status = 'live' and r.spray_enabled and not r.spray_admin_blocked
                    and not exists (select 1 from room_host_freezes f where f.host_id = r.host_id)
                    and not exists (select 1 from rooms c where c.parent_room_id = r.id)
                    and not exists (select 1 from rooms p where p.id = r.parent_room_id and p.spray_admin_blocked)`)
      : Promise.resolve({ rows: [{ n: 0 }] }),
    pool.query(`select r.id, r.title, r.spray_block_reason, r.spray_blocked_by, r.spray_blocked_at, coalesce(a.display_name, a.username) as by_name
                  from rooms r left join admin_users a on a.id = r.spray_blocked_by
                 where r.spray_admin_blocked and r.status <> 'ended' order by r.spray_blocked_at desc nulls last`),
    paused
      ? pool.query(`select c.reason, c.updated_at, coalesce(a.display_name, a.username) as by_name
                      from room_controls c left join admin_users a on a.id = c.updated_by where c.key = 'sprays_paused'`)
      : Promise.resolve({ rows: [] as any[] }),
  ]);
  const pr = pauseRow.rows[0] as { reason: string | null; updated_at: Date | null; by_name: string | null } | undefined;
  return {
    platformFlag: roomFeatures.spray === true, paused,
    pausedInfo: paused ? { reason: pr?.reason ?? "", byName: pr?.by_name ?? null, at: pr?.updated_at ? new Date(pr.updated_at).toISOString() : new Date(0).toISOString() } : null,
    frozenHosts: frozen.rows[0].n, liveRoomsSprayOn: live.rows[0].n,
    blockedRooms: blocked.rows.map((r: any) => ({
      roomId: r.id, title: r.title, reason: r.spray_block_reason ?? null, byAdminId: r.spray_blocked_by ?? null, byAdminName: r.by_name ?? null,
      at: r.spray_blocked_at ? new Date(r.spray_blocked_at).toISOString() : null,
    })),
  };
}
