// Expiry sweep and account-deletion purge for age review. The pool is imported lazily so this loads without a database.
import { ageReviewEnabled } from "./ageReviewFeatures";

let lastSweepAt: Date | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Task 4 reads this for the health strip. */
export function ageReviewSweepStatus(): { lastSweepAt: string | null } {
  return { lastSweepAt: lastSweepAt ? lastSweepAt.toISOString() : null };
}

/** Open requests past expires_at become expired and their evidence goes, in ONE transaction. Returns the affected users. */
export async function sweepExpiredAgeReviews(): Promise<{ expired: number; userIds: string[]; evidenceDeleted: number; staleFound?: number }> {
  const { pool } = await import("../storage");
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Counted BEFORE this run cleans up: evidence that survived its request (final, or 2 hours past expiry = a missed sweep) means a bug.
    const staleFound = Number((await client.query(
      `select count(*)::int n from age_review_evidence e join age_review_requests r on r.id = e.request_id
        where r.status in ('approved', 'declined', 'expired', 'cancelled', 'closed_minor') or r.expires_at < now() - interval '2 hours'`)).rows[0].n);
    const exp = (await client.query(
      // Rows are locked in id order (as the emergency purge does) so the two can never deadlock; a row someone else holds waits for the next sweep.
      `update age_review_requests set status = 'expired', proposed_dob = null, decided_at = now()
       where id in (select id from age_review_requests where expires_at < now() and status in ('draft', 'submitted', 'in_review', 'needs_more', 'pending_second_approval') order by id for update skip locked)
       returning id, user_id`,
    )).rows as { id: string; user_id: string }[];
    const del = await client.query(
      `delete from age_review_evidence e using age_review_requests r
       where e.request_id = r.id and (r.status in ('expired', 'cancelled', 'approved', 'declined', 'closed_minor') or r.expires_at < now())`,
    );
    await client.query(`delete from age_review_reveal_nonces where expires_at < now()`);
    await client.query("commit");
    lastSweepAt = new Date();
    return { expired: exp.length, userIds: Array.from(new Set(exp.map((r) => r.user_id))), evidenceDeleted: del.rowCount ?? 0, staleFound };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

type SweepDeps = {
  sweep: () => Promise<{ expired: number; userIds: string[]; evidenceDeleted: number; staleFound?: number }>;
  notify: (userId: string, kind: "expired") => Promise<void>;
  closeRooms: () => Promise<unknown>;
};
const realDeps: SweepDeps = {
  sweep: sweepExpiredAgeReviews,
  notify: async (id, kind) => (await import("./ageReviewNotify")).notifyAgeReview(id, kind),
  closeRooms: async () => (await import("./ageReviewLive")).closeStaleAgeCheckRooms(),
};

/** Exported for tests. Closing live rooms is housekeeping: it runs last, in its own try, and can never skip the expiry notices. */
export async function runSweepWith(d: SweepDeps = realDeps): Promise<void> {
  try {
    const r = await d.sweep();
    if (r.expired || r.evidenceDeleted) console.log(`[AGE-REVIEW] sweep: expired ${r.expired}, evidence rows deleted ${r.evidenceDeleted}`);
    if (r.staleFound) console.error(`[AGE-REVIEW] ALERT age review evidence outlived its request: ${r.staleFound}`);
    for (const id of r.userIds) await d.notify(id, "expired");
  } catch {
    console.error("[AGE-REVIEW] ALERT sweep failed");
  }
  try { await d.closeRooms(); } catch { console.error("[AGE-REVIEW] closing stale live rooms failed"); }
}
const runSweep = () => runSweepWith();

/** One sweep now, then hourly. Only when the flag is on. */
// With the flag off nothing here runs on purpose: no reveal token can be issued, so age_review_reveal_nonces stays empty. If the
// flag is switched off after use, the few leftover rows (tens of bytes each) wait for the next time it is on.
export function startAgeReviewSweep(): void {
  if (!ageReviewEnabled() || timer) return;
  void runSweep();
  timer = setInterval(() => void runSweep(), 60 * 60 * 1000);
  timer.unref?.();
}

/** Account deletion: removes the user's requests and (through the foreign key) all their evidence. */
export async function purgeUserAgeReview(userId: string): Promise<number> {
  const { pool } = await import("../storage");
  const r = await pool.query(`delete from age_review_requests where user_id = $1`, [userId]);
  return r.rowCount ?? 0;
}
