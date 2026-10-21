// Admin money controls: the global "pause sprays / pause ticket sales" switches and per-host freezes (rooms admin plan).
// A freeze stops NEW money only; a charge already taken still delivers or refunds (sprayGate's deliver phase ignores the
// switch). Global switches are cached for 5 s per process (cleared on a write here); host freezes are never cached because
// they guard money.
import { pool } from "../storage";
import { roomFeatures } from "./features";

export type ControlKey = "sprays_paused" | "tickets_paused";
export const CONTROL_KEYS: readonly ControlKey[] = ["sprays_paused", "tickets_paused"];

const CACHE_MS = 5000;
const cache = new Map<ControlKey, { v: boolean; at: number }>();

export async function getControl(key: ControlKey): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const row = (await pool.query(`select enabled from room_controls where key = $1`, [key])).rows[0] as { enabled: boolean } | undefined;
  const v = row?.enabled === true;
  cache.set(key, { v, at: Date.now() });
  return v;
}

/** Changed is true only when the stored value actually differs (a missing row counts as off). */
export async function setControl(p: { key: ControlKey; on: boolean; adminId: string; reason: string }): Promise<{ changed: boolean }> {
  const r = await pool.query(
    `with prev as (select enabled from room_controls where key = $1),
          up as (insert into room_controls (key, enabled, reason, updated_by, updated_at) values ($1, $2, $3, $4, now())
                 on conflict (key) do update set enabled = excluded.enabled, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now()
                 returning enabled)
     select coalesce((select enabled from prev), false) as was from up`,
    [p.key, p.on, p.reason, p.adminId],
  );
  cache.delete(p.key);
  return { changed: (r.rows[0]?.was === true) !== p.on };
}

export async function sprayAllowed(): Promise<boolean> {
  return roomFeatures.spray === true && !(await getControl("sprays_paused"));
}

export async function ticketSalesAllowed(): Promise<boolean> {
  return roomFeatures.paidRooms === true && !(await getControl("tickets_paused"));
}

export async function freezeHost(p: { hostId: string; adminId: string; reason: string }): Promise<{ changed: boolean }> {
  const r = await pool.query(
    `insert into room_host_freezes (host_id, reason, frozen_by) values ($1, $2, $3) on conflict (host_id) do nothing returning host_id`,
    [p.hostId, p.reason, p.adminId],
  );
  return { changed: (r.rowCount ?? 0) > 0 };
}

export async function unfreezeHost(p: { hostId: string; adminId: string }): Promise<{ changed: boolean }> {
  const r = await pool.query(`delete from room_host_freezes where host_id = $1 returning host_id`, [p.hostId]);
  return { changed: (r.rowCount ?? 0) > 0 };
}

export async function isHostFrozen(hostId: string): Promise<boolean> {
  return ((await pool.query(`select 1 from room_host_freezes where host_id = $1`, [hostId])).rowCount ?? 0) > 0;
}

export async function listFrozenHosts(): Promise<{ hostId: string; username: string; reason: string; frozenAt: string; adminId: string }[]> {
  const rows = (await pool.query(
    `select f.host_id, u.username, f.reason, f.frozen_at, f.frozen_by from room_host_freezes f join users u on u.id = f.host_id order by f.frozen_at desc`,
  )).rows as { host_id: string; username: string; reason: string; frozen_at: Date; frozen_by: string }[];
  return rows.map((r) => ({ hostId: r.host_id, username: r.username, reason: r.reason, frozenAt: new Date(r.frozen_at).toISOString(), adminId: r.frozen_by }));
}
