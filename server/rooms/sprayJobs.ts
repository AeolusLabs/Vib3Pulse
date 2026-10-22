// Spraying (phase 5, rule B7): the sweep. Every 15 seconds, on every process at once (safe: finalizeSpray takes the
// reference's advisory lock and every status change is conditional; a reference another process holds is skipped).
//  1. paid: delivered if still deliverable, reversed once DELIVERY_DEADLINE_MS has passed since payment was detected (a
//     server restart between payment and finalize ends here; a recipient this process's hub does not see yet is waited for
//     until the deadline);
//  2. reversing: the provider refund is looked up and finished; 'reversed' only once the provider says processed;
//  3. created / pending older than 10 minutes: re-verified with the provider. Paid => finalized as above; anything else =>
//     failed (TIMEOUT) and the reserved spend given back (no spray is pending for ever);
//  4. failed in the last 24 hours: re-verified (at most every 10 minutes each) so a payment that lands late is refunded
//     (LATE_PAYMENT) even when its webhook never arrives.
// Fairness (review I3 / owner ruling 10): each category lists the least recently checked rows first and skips rows whose
// backoff (next_check_at) has not passed, so rows stuck for good can never fill every batch; each check records an attempt
// and a backoff. Each category has its own quota (40 rows per pass in all), so a pile-up never turns into a burst of provider
// calls and one category can never starve another.
// Runs whatever the spray flag says: money already taken must still be delivered or given back.
import { sanitizeMoneyError } from "@shared/roomRefunds";
import type { SprayBatch, SprayPayment } from "@shared/schema";
import * as ss from "./sprayStorage";
import * as bs from "./sprayBatchStorage";
import "./teamSpray"; // registers the batch finalizer: the sweep drives team sprays through the same finalizeSpray
import { finalizeSpray, sprayClock, UNPAID_EXPIRY_MS, type FinalizeOutcome } from "./spray";

export const sprayJobTuning = {
  everyMs: 15_000,
  /**
   * Rows per category per pass (review r4 m2: each category has its OWN quota, so a pile of paid or reversing rows can
   * never starve the expiries and the late-payment re-checks). The total, 40 rows, bounds provider calls per pass.
   */
  quota: { paid: 15, reversing: 10, unpaid: 10, failed: 5 },
  /** Backoff for created / pending / reversing rows a check did not finish: 15 s doubling per attempt, at most 10 minutes. */
  baseBackoffMs: 15_000,
  maxBackoffMs: 10 * 60_000,
  /** Failed rows are re-verified for late payments for this long after they were created, at most every recheck period. */
  failedWindowMs: 24 * 3_600_000,
  failedRecheckMs: 10 * 60_000,
  /** A failed row is first re-checked this long after it failed (the webhook usually comes first). */
  failedMinAgeMs: 2 * 60_000,
};

export interface SprayPassResult { checked: number; outcomes: Record<string, FinalizeOutcome | "error"> }

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";
let warnedMissing = false;

/** When to look at this row again. paid rows: every pass (the delivery deadline bounds them anyway). */
export function nextCheckDelayMs(row: Pick<SprayPayment, "status" | "checkAttempts">): number {
  if (row.status === "paid") return 0;
  if (row.status === "failed") return sprayJobTuning.failedRecheckMs;
  const attempts = Math.max(0, Math.min(Number(row.checkAttempts) || 0, 20));
  return Math.min(sprayJobTuning.baseBackoffMs * 2 ** attempts, sprayJobTuning.maxBackoffMs);
}

/** One pass. Never throws for one spray; a whole-pass failure (database down) throws to the caller (logged by the timer). */
export async function sweepPendingSprays(now: number = sprayClock.now()): Promise<SprayPassResult> {
  const out: SprayPassResult = { checked: 0, outcomes: {} };
  const t = sprayJobTuning;
  try {
    const dueAt = new Date(now);
    // listStaleSprays ages a row by refund_requested_at, else paid_at, else created_at.
    const [paid, reversing, unpaid, failed] = await Promise.all([
      ss.listStaleSprays(["paid"], new Date(now + 1000), t.quota.paid, { dueAt }),                 // every paid row
      ss.listStaleSprays(["reversing"], new Date(now + 1000), t.quota.reversing, { dueAt }),       // every unfinished refund
      ss.listStaleSprays(["created", "pending"], new Date(now - UNPAID_EXPIRY_MS), t.quota.unpaid, { dueAt }),
      ss.listStaleSprays(["failed"], new Date(now - t.failedMinAgeMs), t.quota.failed, { dueAt, createdSince: new Date(now - t.failedWindowMs) }),
    ]);
    // Team spray (teamSpray.ts): one charge = one batch row, finalized by its reference exactly like a single spray. Same
    // categories and quotas (share rows are never listed on their own: listStaleSprays leaves out rows with a batch_id).
    const [bPaid, bReversing, bUnpaid, bFailed] = await Promise.all([
      bs.listStaleBatches(["paid"], new Date(now + 1000), t.quota.paid, { dueAt }),
      bs.listStaleBatches(["reversing"], new Date(now + 1000), t.quota.reversing, { dueAt }),
      bs.listStaleBatches(["created", "pending"], new Date(now - UNPAID_EXPIRY_MS), t.quota.unpaid, { dueAt }),
      bs.listStaleBatches(["failed"], new Date(now - t.failedMinAgeMs), t.quota.failed, { dueAt, createdSince: new Date(now - t.failedWindowMs) }),
    ]);
    const runBatch = async (row: SprayBatch, expireUnpaid: boolean) => {
      const ref = row.providerRef;
      out.checked++;
      try { out.outcomes[ref] = await finalizeSpray(ref, { expireUnpaid, waitMs: 0 }); }
      catch (e) {
        out.outcomes[ref] = "error";
        console.error(`[rooms:spray] sweep: team ref=${ref.slice(0, 12)}... failed, a later pass retries:`, sanitizeMoneyError(e));
      }
      await bs.noteBatchChecked(row.id, new Date(now), new Date(now + nextCheckDelayMs(row)))
        .catch((e) => console.error("[rooms:spray] sweep: recording a team check failed:", sanitizeMoneyError(e)));
    };
    const run = async (row: SprayPayment, expireUnpaid: boolean) => {
      const ref = row.providerRef;
      out.checked++;
      try { out.outcomes[ref] = await finalizeSpray(ref, { expireUnpaid, waitMs: 0 }); }
      catch (e) {
        out.outcomes[ref] = "error";
        console.error(`[rooms:spray] sweep: ref=${ref.slice(0, 12)}... failed, a later pass retries:`, sanitizeMoneyError(e));
      }
      // Bookkeeping only (never a status): one more attempt and the backoff. A row that moved on is simply listed (or not)
      // by its new status next time.
      await ss.noteSprayChecked(row.id, new Date(now), new Date(now + nextCheckDelayMs(row)))
        .catch((e) => console.error("[rooms:spray] sweep: recording a check failed:", sanitizeMoneyError(e)));
    };
    // Deadline-bound money first (paid, then refunds), then expiries, then the late-payment re-checks.
    const queue: Array<[SprayPayment, boolean]> = [
      ...paid.map((r): [SprayPayment, boolean] => [r, false]),
      ...reversing.map((r): [SprayPayment, boolean] => [r, false]),
      ...unpaid.map((r): [SprayPayment, boolean] => [r, true]),
      ...failed.map((r): [SprayPayment, boolean] => [r, false]),
    ];
    for (const [row, expire] of queue) await run(row, expire); // already bounded by the per-category quotas
    const bQueue: Array<[SprayBatch, boolean]> = [
      ...bPaid.map((r): [SprayBatch, boolean] => [r, false]),
      ...bReversing.map((r): [SprayBatch, boolean] => [r, false]),
      ...bUnpaid.map((r): [SprayBatch, boolean] => [r, true]),
      ...bFailed.map((r): [SprayBatch, boolean] => [r, false]),
    ];
    for (const [row, expire] of bQueue) await runBatch(row, expire);
  } catch (e) {
    if (isMissingTable(e)) {
      if (!warnedMissing) { warnedMissing = true; console.warn("[rooms:spray] sweep: spray tables are not there yet (migration not applied); skipping"); }
      return out;
    }
    throw e;
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Every 15 seconds. Safe to call twice; never keeps the process alive; one pass at a time per process. */
export function startSprayJob(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepPendingSprays()
      .catch((e) => console.error("[rooms:spray] sweep pass failed:", sanitizeMoneyError(e)))
      .finally(() => { running = false; });
  }, sprayJobTuning.everyMs);
  timer.unref();
}

/** Tests drive passes by hand (sweepPendingSprays with their own clock). */
export function stopSprayJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
