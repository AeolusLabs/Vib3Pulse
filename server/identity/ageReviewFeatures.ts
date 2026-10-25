// Age review switches: the AGE_REVIEW env flag and the admin intake pause (room_controls key age_review_paused).
// The pool is imported lazily so the flag can be unit-tested without a database.
// The pause is cached 5 s per process and the cache is cleared on a write, same pattern as server/rooms/roomControls.ts.
import { parseFlag } from "../rooms/features";

export const AGE_REVIEW_PAUSED_KEY = "age_review_paused";
const CACHE_MS = 5000;
let cache: { v: boolean; at: number } | null = null;

/** Exactly "1" or "true" turns it on; read each call so tests can flip it. */
export function ageReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.AGE_REVIEW, false);
}

export async function ageReviewPaused(): Promise<boolean> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.v;
  const { pool } = await import("../storage");
  const row = (await pool.query(`select enabled from room_controls where key = $1`, [AGE_REVIEW_PAUSED_KEY])).rows[0] as { enabled: boolean } | undefined;
  const v = row?.enabled === true;
  cache = { v, at: Date.now() };
  return v;
}

/** Changed is true only when the stored value actually differs (a missing row counts as off). */
export async function setAgeReviewPaused(p: { on: boolean; adminId: string; reason: string }): Promise<{ changed: boolean }> {
  const { pool } = await import("../storage");
  const r = await pool.query(
    `with prev as (select enabled from room_controls where key = $1),
          up as (insert into room_controls (key, enabled, reason, updated_by, updated_at) values ($1, $2, $3, $4, now())
                 on conflict (key) do update set enabled = excluded.enabled, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now()
                 returning enabled)
     select coalesce((select enabled from prev), false) as was from up`,
    [AGE_REVIEW_PAUSED_KEY, p.on, p.reason, p.adminId],
  );
  cache = null;
  return { changed: (r.rows[0]?.was === true) !== p.on };
}
