// The live money rates (rooms rates plan). getRates() is what a spray start and a ticket issue read: the saved values over the
// defaults in shared/money.ts. Cached 5 s per process (cleared on a write here), like the pause switches. setRate() validates, then
// changes the value and appends the log row in one transaction, under a per-key lock so two admins saving at once chain cleanly.
import { pool } from "../storage";
import { DEFAULT_RATES, RATE_KEYS, isRateKey, validateRate, type RateKey, type Rates } from "@shared/money";

const CACHE_MS = 5000;
let cache: { rates: Rates; at: number } | null = null;

export async function getRates(): Promise<Rates> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rates;
  const rows = (await pool.query(`select key, value::float8 as value from room_rates`)).rows as { key: string; value: number }[];
  const rates: Rates = { ...DEFAULT_RATES };
  for (const r of rows) if (isRateKey(r.key)) rates[r.key] = r.value;
  cache = { rates, at: Date.now() };
  return rates;
}

/** Throws RangeError for an unknown key or a value outside the limits; nothing is saved then. */
export async function setRate(p: { key: RateKey; value: number; adminId: string; reason: string }): Promise<{ changed: boolean; before: number; after: number }> {
  const v = validateRate(p.key, p.value);
  if (!v.ok) throw new RangeError(v.reason);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`room_rate:${p.key}`]);
    const row = (await c.query(`select value::float8 as value from room_rates where key = $1`, [p.key])).rows[0] as { value: number } | undefined;
    const before = row?.value ?? DEFAULT_RATES[p.key];
    if (before === v.value) { await c.query("ROLLBACK"); return { changed: false, before, after: v.value }; }
    // clock_timestamp(), not now(): the lock orders the writers, and now() is the transaction START, which can run backwards.
    await c.query(
      `insert into room_rates (key, value, updated_by, updated_at) values ($1, $2, $3, clock_timestamp())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = clock_timestamp()`,
      [p.key, v.value, p.adminId],
    );
    await c.query(
      `insert into room_rate_changes (key, before_value, after_value, reason, admin_id, created_at) values ($1, $2, $3, $4, $5, clock_timestamp())`,
      [p.key, before, v.value, p.reason, p.adminId],
    );
    await c.query("COMMIT");
    cache = null;
    return { changed: true, before, after: v.value };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export interface RateChange { id: string; key: RateKey; before: number; after: number; reason: string; adminId: string; adminName: string; at: string }

export async function listRateChanges(limit = 50): Promise<RateChange[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const rows = (await pool.query(
    `select c.id, c.key, c.before_value::float8 as before, c.after_value::float8 as after, c.reason, c.admin_id, c.created_at,
            coalesce(a.display_name, a.username) as admin_name
       from room_rate_changes c left join admin_users a on a.id::text = c.admin_id
      order by c.created_at desc, c.id desc limit $1`, [n],
  )).rows as { id: string; key: string; before: number; after: number; reason: string; admin_id: string; created_at: Date; admin_name: string | null }[];
  return rows.filter((r) => isRateKey(r.key)).map((r) => ({
    id: r.id, key: r.key as RateKey, before: r.before, after: r.after, reason: r.reason, adminId: r.admin_id,
    adminName: r.admin_name ?? "Unknown admin", at: new Date(r.created_at).toISOString(),
  }));
}

export { RATE_KEYS };
