// Spraying (phase 5, rule B7): the sweep. Every 15 seconds, on every process at once (safe: finalizeSpray takes the
// reference's advisory lock and every status change is conditional; a reference another process holds is skipped).
//  1. paid: delivered if still deliverable, reversed once DELIVERY_DEADLINE_MS has passed since payment was detected (a
//     server restart between payment and finalize ends here);
//  2. created / pending older than 10 minutes: re-verified with the provider. Paid => finalized as above; anything else =>
//     failed (TIMEOUT) and the reserved spend given back (no spray is pending for ever);
//  3. reversing: the provider refund is looked up and finished; 'reversed' only once the provider says processed.
// Runs whatever the spray flag says: money already taken must still be delivered or given back.
import { sanitizeMoneyError } from "@shared/roomRefunds";
import * as ss from "./sprayStorage";
import { finalizeSpray, sprayClock, UNPAID_EXPIRY_MS, type FinalizeOutcome } from "./spray";

export const sprayJobTuning = { everyMs: 15_000, batch: 50 };

export interface SprayPassResult { checked: number; outcomes: Record<string, FinalizeOutcome | "error"> }

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";
let warnedMissing = false;

/** One pass. Never throws for one spray; a whole-pass failure (database down) throws to the caller (logged by the timer). */
export async function sweepPendingSprays(now: number = sprayClock.now()): Promise<SprayPassResult> {
  const out: SprayPassResult = { checked: 0, outcomes: {} };
  try {
    // listStaleSprays ages a row by refund_requested_at, else paid_at, else created_at.
    const [paid, unpaid, reversing] = await Promise.all([
      ss.listStaleSprays(["paid"], new Date(now + 1000), sprayJobTuning.batch),           // every paid row
      ss.listStaleSprays(["created", "pending"], new Date(now - UNPAID_EXPIRY_MS), sprayJobTuning.batch),
      ss.listStaleSprays(["reversing"], new Date(now + 1000), sprayJobTuning.batch),      // every unfinished refund
    ]);
    const run = async (ref: string, expireUnpaid: boolean) => {
      out.checked++;
      try { out.outcomes[ref] = await finalizeSpray(ref, { expireUnpaid, waitMs: 0 }); }
      catch (e) {
        out.outcomes[ref] = "error";
        console.error(`[rooms:spray] sweep: ref=${ref.slice(0, 12)}... failed, next pass retries:`, sanitizeMoneyError(e));
      }
    };
    for (const r of paid) await run(r.providerRef, false);
    for (const r of unpaid) await run(r.providerRef, true);
    for (const r of reversing) await run(r.providerRef, false);
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
