// The one answer to "is spraying on in this room right now". Everything that shows or gates spraying reads it.
import type { Room } from "@shared/schema";
import { pool } from "../storage";
import { roomFeatures } from "./features";
import { getControl, isHostFrozen } from "./roomControls";

export type SprayOffReason = "FEATURE_OFF" | "PAUSED" | "HOST_OFF" | "ADMIN_BLOCKED" | "HOST_FROZEN";
export type SprayEffective = { on: boolean; reason: null | SprayOffReason };

/** First failing reason wins, in this order. Phase "deliver" of an already charged spray never asks (see sprayGate). */
export async function sprayEffectiveFor(room: Pick<Room, "hostId" | "sprayEnabled" | "sprayAdminBlocked">): Promise<SprayEffective> {
  const off = (reason: SprayOffReason): SprayEffective => ({ on: false, reason });
  if (roomFeatures.spray !== true) return off("FEATURE_OFF");
  if (await getControl("sprays_paused")) return off("PAUSED");
  if (room.sprayEnabled !== true) return off("HOST_OFF");
  if (room.sprayAdminBlocked === true) return off("ADMIN_BLOCKED");
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
/** found false: no such room. changed false: already in that state (nothing written). */
export async function setRoomSprayBlock(p: { roomId: string; on: boolean; adminId: string; reason: string }): Promise<{ found: boolean; ended: boolean; changed: boolean }> {
  const cur = (await pool.query(`select status from rooms where id = $1`, [p.roomId])).rows[0] as { status: string } | undefined;
  if (!cur) return { found: false, ended: false, changed: false };
  if (cur.status === "ended") return { found: true, ended: true, changed: false };
  const r = p.on
    ? await pool.query(
      `update rooms set spray_admin_blocked = true, spray_block_reason = $2, spray_blocked_by = $3, spray_blocked_at = now()
        where id = $1 and spray_admin_blocked = false returning id`, [p.roomId, p.reason, p.adminId])
    : await pool.query(
      `update rooms set spray_admin_blocked = false, spray_block_reason = null, spray_blocked_by = null, spray_blocked_at = null
        where id = $1 and spray_admin_blocked = true returning id`, [p.roomId]);
  return { found: true, ended: false, changed: (r.rowCount ?? 0) > 0 };
}

export interface SprayStatus {
  platformFlag: boolean; paused: boolean; frozenHosts: number; liveRoomsSprayOn: number;
  blockedRooms: { roomId: string; title: string; reason: string | null; byAdminId: string | null; at: string | null }[];
}

export async function sprayStatus(): Promise<SprayStatus> {
  const paused = await getControl("sprays_paused");
  const [frozen, live, blocked] = await Promise.all([
    pool.query(`select count(*)::int as n from room_host_freezes`),
    roomFeatures.spray && !paused
      ? pool.query(`select count(*)::int as n from rooms r where r.status = 'live' and r.spray_enabled and not r.spray_admin_blocked
                    and not exists (select 1 from room_host_freezes f where f.host_id = r.host_id)`)
      : Promise.resolve({ rows: [{ n: 0 }] }),
    pool.query(`select id, title, spray_block_reason, spray_blocked_by, spray_blocked_at from rooms
                 where spray_admin_blocked and status <> 'ended' order by spray_blocked_at desc nulls last`),
  ]);
  return {
    platformFlag: roomFeatures.spray === true, paused,
    frozenHosts: frozen.rows[0].n, liveRoomsSprayOn: live.rows[0].n,
    blockedRooms: blocked.rows.map((r: any) => ({
      roomId: r.id, title: r.title, reason: r.spray_block_reason ?? null, byAdminId: r.spray_blocked_by ?? null,
      at: r.spray_blocked_at ? new Date(r.spray_blocked_at).toISOString() : null,
    })),
  };
}
