// Spray event log: ONE helper, recordSprayEvent, writes a spray_events row at every spray / team-spray status change
// (sprayStorage.ts, sprayBatchStorage.ts and the raw-SQL transitions in spray.ts, teamSpray.ts, clawbacks.ts).
// A failed log write must never fail the money path: it is swallowed here and console.error'd with an ALERT prefix.
// `detail` is a short note, never a secret: no card, authorization code, bank detail or token (sanitized and capped here).
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../storage";
import { sprayEvents } from "@shared/schema";

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
type DrizzleExec = typeof db;
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
 * Inside a transaction a failing INSERT would abort the whole transaction, so the write runs in a SAVEPOINT: only the log
 * row can be lost, never the status change or the ledger rows beside it. Returns whether the row was written.
 */
export async function recordSprayEvent(ev: SprayEventInput, exec?: SprayEventExec): Promise<boolean> {
  const source = ev.source ?? currentSpraySource();
  const row = {
    sprayId: ev.sprayId ?? null, batchId: ev.batchId ?? null, roomId: ev.roomId, fromStatus: ev.from ?? null,
    toStatus: ev.to, source, detail: cleanDetail(ev.detail),
  };
  try {
    if (!row.sprayId && !row.batchId) throw new Error("spray event needs a spray or a batch");
    if (sprayEventTestHooks.failWrite?.()) throw new Error("injected spray event failure (test)");
    if (isPg(exec)) {
      await exec.query("SAVEPOINT spray_event");
      try {
        await exec.query(
          `insert into spray_events (spray_id, batch_id, room_id, from_status, to_status, source, detail) values ($1, $2, $3, $4, $5, $6, $7)`,
          [row.sprayId, row.batchId, row.roomId, row.fromStatus, row.toStatus, row.source, row.detail],
        );
        await exec.query("RELEASE SAVEPOINT spray_event");
      } catch (e) {
        await exec.query("ROLLBACK TO SAVEPOINT spray_event").catch(() => {});
        throw e;
      }
    } else {
      // db.transaction on a transaction is a savepoint; on db it is a tiny transaction of its own.
      await ((exec as DrizzleExec | undefined) ?? db).transaction(async (t) => { await t.insert(sprayEvents).values(row); });
    }
    return true;
  } catch (e) {
    console.error(`[rooms:spray] ALERT spray event not recorded spray=${row.sprayId ?? "-"} batch=${row.batchId ?? "-"} ${row.fromStatus ?? "-"}->${row.toStatus} source=${source}:`,
      e instanceof Error ? e.message.slice(0, 200) : "unknown error");
    return false;
  }
}

/** One batch event plus one per share row that moved with it (shares carry batch_id so either timeline finds them). */
export async function recordBatchTransition(
  batch: { id: string; roomId: string }, shareIds: readonly string[], from: string | null, to: string, detail: string | null, exec: SprayEventExec,
): Promise<void> {
  await recordSprayEvent({ batchId: batch.id, roomId: batch.roomId, from, to, detail }, exec);
  for (const id of shareIds) await recordSprayEvent({ sprayId: id, batchId: batch.id, roomId: batch.roomId, from, to, detail }, exec);
}
