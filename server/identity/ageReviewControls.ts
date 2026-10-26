// Guardrail controls for age review: the health strip, the intake pause and the emergency purge.
// Nothing here ever selects evidence bytes; audit rows carry counts and a free-text reason only.
import { OPEN_STATUSES } from "../../shared/ageReview";
import { AgeReviewError } from "./ageReviewService";
import { ageReviewPaused, setAgeReviewPaused } from "./ageReviewFeatures";
import { ageReviewSweepStatus } from "./ageReviewSweep";

const FINAL = `'approved', 'declined', 'expired', 'cancelled', 'closed_minor'`;
const OPEN = OPEN_STATUSES.map((s) => `'${s}'`).join(", ");
/** Evidence that should already be gone: its request is final, or it is more than 7 days old. */
export const STALE_EVIDENCE_WHERE = `(r.status in (${FINAL}) or r.created_at < now() - interval '7 days')`;

async function getPool() { return (await import("../storage")).pool; }

async function audit(adminId: string, action: string, details: string, reason: string, ip?: string) {
  const { storage } = await import("../storage");
  await storage.logAdminActivity({ adminId, action, targetType: "age_review", targetId: "all", details, reason, ipAddress: ip })
    .catch(() => console.error(`[AGE-REVIEW] ALERT ${action} took effect but the audit row failed`));
}

export async function getHealth() {
  const pool = await getPool();
  const [pending, stale, oldest, reveals, paused] = await Promise.all([
    pool.query(`select count(*)::int n from age_review_evidence e join age_review_requests r on r.id = e.request_id where r.status in (${OPEN})`),
    pool.query(`select count(*)::int n from age_review_evidence e join age_review_requests r on r.id = e.request_id where ${STALE_EVIDENCE_WHERE}`),
    pool.query(`select extract(epoch from (now() - min(created_at))) / 3600 as h from age_review_evidence`),
    pool.query(
      `select a.username as reviewer, count(*)::int as count from admin_activity_logs l join admin_users a on a.id = l.admin_id
        where l.action = 'age_review.reveal' and l.created_at >= date_trunc('day', now() at time zone 'utc') group by a.username order by count desc, a.username`),
    ageReviewPaused(),
  ]);
  const h = oldest.rows[0]?.h;
  return {
    paused,
    pendingEvidence: Number(pending.rows[0].n),
    staleEvidence: Number(stale.rows[0].n),
    oldestEvidenceAgeHours: h === null || h === undefined ? null : Math.round(Number(h) * 10) / 10,
    lastSweepAt: ageReviewSweepStatus().lastSweepAt,
    revealsToday: reveals.rows.map((r: { reviewer: string; count: number }) => ({ reviewer: r.reviewer, count: Number(r.count) })),
  };
}

/** Anyone with the role may pause; only a super_admin resumes (same shape as the other admin-off switches). */
export async function setPause(admin: { id: string; role: string }, b: { on: boolean; reason: string }, ip?: string) {
  if (!b.on && admin.role !== "super_admin") throw new AgeReviewError(403, "NOT_ALLOWED", "Only a super admin can resume age checks.");
  const { changed } = await setAgeReviewPaused({ on: b.on, adminId: admin.id, reason: b.reason });
  if (changed) await audit(admin.id, b.on ? "age_review.pause" : "age_review.resume", b.on ? "intake paused" : "intake resumed", b.reason, ip);
  return { paused: b.on, changed };
}

/**
 * Deletes ALL evidence in one transaction. Submitted or in-review uploads that lost their photos go back to needs_more
 * (without counting as a "more" round) so the user can upload again; each affected user gets the neutral notice.
 */
export async function emergencyPurge(admin: { id: string; role: string }, reason: string, ip?: string) {
  if (admin.role !== "super_admin") throw new AgeReviewError(403, "NOT_ALLOWED", "Only a super admin can purge evidence.");
  const client = await (await getPool()).connect();
  let deleted = 0;
  let userIds: string[] = [];
  try {
    await client.query("begin");
    // Every open request is locked first (putEvidence needs the same row lock), so no upload can land mid-purge: it either
    // finished before this point and is deleted below, or waits and is stored after the commit.
    const locked = (await client.query(`select id, user_id, status from age_review_requests where status in (${OPEN}) order by id for update`)).rows as { id: string; user_id: string; status: string }[];
    const del = (await client.query(`delete from age_review_evidence returning request_id`)).rows as { request_id: string }[];
    deleted = del.length;
    const had = new Set(del.map((d) => d.request_id));
    const affected = locked.filter((l) => had.has(l.id));
    const ids = affected.map((l) => l.id);
    if (ids.length) {
      await client.query(
        `update age_review_requests set proposed_dob = case when status = 'pending_second_approval' then null else proposed_dob end,
                proposed_legal_name_enc = case when status = 'pending_second_approval' then null else proposed_legal_name_enc end,
                status = case when status in ('submitted', 'in_review', 'pending_second_approval') then 'needs_more' else status end
          where id = any($1::uuid[])`, [ids]);
    }
    userIds = Array.from(new Set(affected.map((l) => l.user_id)));
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
  await audit(admin.id, "age_review.emergency_purge", `deleted=${deleted}`, reason, ip);
  const { notifyAgeReview } = await import("./ageReviewNotify");
  // The purge has happened and is audited: a notice that fails must never turn it into an error.
  for (const id of userIds) {
    try { await notifyAgeReview(id, "update"); } catch { console.error("[AGE-REVIEW] ALERT a purge notice could not be sent"); }
  }
  return { deleted };
}
