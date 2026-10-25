// Spray event log: ONE helper, recordSprayEvent, writes a spray_events row at every spray / team-spray status change
// (sprayStorage.ts, sprayBatchStorage.ts and the raw-SQL transitions in spray.ts, teamSpray.ts, clawbacks.ts).
// A failed log write must never fail the money path: it is swallowed here and console.error'd with an ALERT prefix.
// `detail` is a short note, never a secret: no card, authorization code, bank detail or token (sanitized and capped here).
import { AsyncLocalStorage } from "node:async_hooks";

export const SPRAY_EVENT_SOURCES = ["api", "callback", "sweep", "admin", "system"] as const;
export type SprayEventSource = (typeof SPRAY_EVENT_SOURCES)[number];

export interface SprayEventInput {
  sprayId?: string | null;
  batchId?: string | null;
  roomId: string;
  from?: string | null;
  to: string;
  /** Omitted: the ambient source set by withSpraySource (webhook, sweep, admin route, request), else 'system'. */
  source?: SprayEventSource;
  detail?: string | null;
}

// Who is driving the current call chain. Set once at each entry point (webhook, sweep, admin, request) so the deep
// status-change helpers need no extra parameter threaded through every function.
const sourceStore = new AsyncLocalStorage<SprayEventSource>();
export function withSpraySource<T>(source: SprayEventSource, fn: () => T): T { return sourceStore.run(source, fn); }
export const currentSpraySource = (): SprayEventSource => sourceStore.getStore() ?? "system";

/** A node-postgres client (the raw-SQL transitions run on one). */
export interface PgLikeClient { query(text: string, values?: unknown[]): Promise<unknown> }
type DrizzleExec = typeof import("../storage").db;
export type SprayEventExec = DrizzleExec | PgLikeClient | { query?: never };

const isPg = (e: unknown): e is PgLikeClient =>
  !!e && typeof (e as PgLikeClient).query === "function" && typeof (e as { insert?: unknown }).insert !== "function";

const SECRETISH = /\b(?:AUTH_[A-Za-z0-9]+|sk_(?:live|test)_\w+|ACCT_\w+|\d{10,})\b/g;
export function cleanDetail(d: string | null | undefined): string | null {
  if (typeof d !== "string" || !d) return null;
  return d.replace(SECRETISH, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300) || null;
}

/** Test seam: make the next writes fail. */
export const sprayEventTestHooks: { failWrite?: () => boolean } = {};

/**
 * Writes all of one call's events with ONE multi-row INSERT under ONE savepoint (3 round trips whatever the count): this
 * runs inside transactions that hold advisory locks, so per-event round trips would eat the lock wait. A failing INSERT
 * would abort the surrounding transaction, so it runs in a SAVEPOINT: only the log rows can be lost, never the status
 * change beside them. Returns whether the rows were written.
 */
export async function recordSprayEvents(evs: readonly SprayEventInput[], exec?: SprayEventExec): Promise<boolean> {
  if (evs.length === 0) return true;
  const rows = evs.map((ev) => ({
    sprayId: ev.sprayId ?? null, batchId: ev.batchId ?? null, roomId: ev.roomId, fromStatus: ev.from ?? null,
    toStatus: ev.to, source: ev.source ?? currentSpraySource(), detail: cleanDetail(ev.detail),
  }));
  try {
    if (rows.some((r) => !r.sprayId && !r.batchId)) throw new Error("spray event needs a spray or a batch");
    if (sprayEventTestHooks.failWrite?.()) throw new Error("injected spray event failure (test)");
    if (isPg(exec)) {
      const values: unknown[] = [];
      const tuples = rows.map((r) => {
        values.push(r.sprayId, r.batchId, r.roomId, r.fromStatus, r.toStatus, r.source, r.detail);
        const n = values.length;
        return `($${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await exec.query("SAVEPOINT spray_event");
      try {
        await exec.query(`insert into spray_events (spray_id, batch_id, room_id, from_status, to_status, source, detail) values ${tuples.join(", ")}`, values);
        await exec.query("RELEASE SAVEPOINT spray_event");
      } catch (e) {
        await exec.query("ROLLBACK TO SAVEPOINT spray_event").catch(() => {});
        throw e;
      }
    } else {
      // db.transaction on a transaction is a savepoint; on db it is a tiny transaction of its own. Lazy import: the pg path needs no database module.
      const { db } = await import("../storage");
      const { sprayEvents } = await import("@shared/schema");
      await ((exec as typeof db | undefined) ?? db).transaction(async (t) => { await t.insert(sprayEvents).values(rows); });
    }
    return true;
  } catch (e) {
    const first = rows[0];
    console.error(`[rooms:spray] ALERT spray event not recorded spray=${first.sprayId ?? "-"} batch=${first.batchId ?? "-"} ${first.fromStatus ?? "-"}->${first.toStatus} source=${first.source} count=${rows.length}:`,
      e instanceof Error ? e.message.slice(0, 200) : "unknown error");
    return false;
  }
}

export const recordSprayEvent = (ev: SprayEventInput, exec?: SprayEventExec): Promise<boolean> => recordSprayEvents([ev], exec);

/** One batch event plus one per share row that moved with it (shares carry batch_id so either timeline finds them). */
export async function recordBatchTransition(
  batch: { id: string; roomId: string }, shareIds: readonly string[], from: string | null, to: string, detail: string | null, exec: SprayEventExec,
): Promise<void> {
  await recordSprayEvents([
    { batchId: batch.id, roomId: batch.roomId, from, to, detail },
    ...shareIds.map((id) => ({ sprayId: id, batchId: batch.id, roomId: batch.roomId, from, to, detail })),
  ], exec);
}
