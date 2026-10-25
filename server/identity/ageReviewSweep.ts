// Expiry sweep and account-deletion purge for age review. The pool is imported lazily so this loads without a database.
import { ageReviewEnabled } from "./ageReviewFeatures";

let lastSweepAt: Date | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Task 4 reads this for the health strip. */
export function ageReviewSweepStatus(): { lastSweepAt: string | null } {
  return { lastSweepAt: lastSweepAt ? lastSweepAt.toISOString() : null };
}

/** Open requests past expires_at become expired and their evidence goes, in ONE transaction. Returns the affected users. */
export async function sweepExpiredAgeReviews(): Promise<{ expired: number; userIds: string[]; evidenceDeleted: number }> {
  const { pool } = await import("../storage");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const exp = (await client.query(
      `update age_review_requests set status = 'expired', decided_at = now()
       where expires_at < now() and status in ('draft', 'submitted', 'in_review', 'needs_more', 'pending_second_approval')
       returning id, user_id`,
    )).rows as { id: string; user_id: string }[];
    const del = await client.query(
      `delete from age_review_evidence e using age_review_requests r
       where e.request_id = r.id and (r.status in ('expired', 'cancelled', 'approved', 'declined', 'closed_minor') or r.expires_at < now())`,
    );
    await client.query("commit");
    lastSweepAt = new Date();
    return { expired: exp.length, userIds: Array.from(new Set(exp.map((r) => r.user_id))), evidenceDeleted: del.rowCount ?? 0 };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function runSweep(): Promise<void> {
  try {
    const r = await sweepExpiredAgeReviews();
    if (r.expired || r.evidenceDeleted) console.log(`[AGE-REVIEW] sweep: expired ${r.expired}, evidence rows deleted ${r.evidenceDeleted}`);
    const { notifyAgeReview } = await import("./ageReviewNotify");
    for (const id of r.userIds) await notifyAgeReview(id, "expired");
  } catch {
    console.error("[AGE-REVIEW] ALERT sweep failed");
  }
}

/** One sweep now, then hourly. Only when the flag is on. */
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
