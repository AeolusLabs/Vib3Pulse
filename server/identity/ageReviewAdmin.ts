// Reviewer side of manual age review: queue, detail, decisions, second approval.
// planDecision is pure (no database) so every rule is unit-tested; the executors below only do the I/O the plan describes.
// Evidence bytes are never selected here: the detail lists only id, kind, mime and size.
import { ageFromDob } from "../../shared/age";
import {
  CHECKLIST_KEYS, DECISION_OUTCOMES, DECLINE_REASONS, MAX_NEEDS_MORE_ROUNDS,
  type DecisionOutcome, type DeclineReason,
} from "../../shared/ageReview";
import { AgeReviewError } from "./ageReviewService";
import { documentFingerprint } from "./evidenceCrypto";

export type AdminRef = { id: string; email: string; role: string };
export type DecideBody = {
  outcome: DecisionOutcome;
  checklist?: Record<string, boolean>;
  idBirthdate?: string;
  documentNumber?: string;
  documentType?: string;
  declineReason?: DeclineReason;
  note?: string;
  overrideDuplicate?: { reason: string };
};
export type RequestCtx = {
  id: string; user_id: string; method: "upload" | "live"; status: string; document_type: string | null;
  registered_dob_snapshot: string | null; more_requests: number; reviewer_id: string | null; proposed_dob: string | null;
};
export type UserCtx = { email: string | null; dateOfBirth: string | null };

export type Plan = {
  outcome: string;
  finalStatus: "approved" | "declined" | "closed_minor" | "needs_more" | "pending_second_approval";
  account: { kind: "verify"; method: "admin_upload" | "admin_live" } | { kind: "correct_dob"; dob: string; reason: string } | null;
  declineReason: DeclineReason | null;
  dobMatch: boolean;
  proposedDob: string | null;
  fingerprint: string | null;
  documentType: string | null;
  bumpMore: boolean;
  deleteEvidence: boolean;
  notify: "approved" | "declined" | "needs_more" | "teen_moved" | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isSelfReview(admin: AdminRef, user: UserCtx): boolean {
  return !!user.email && !!admin.email && admin.email.trim().toLowerCase() === user.email.trim().toLowerCase();
}

function needBirthdate(b: DecideBody): string {
  if (!b.idBirthdate || !ISO_DATE.test(b.idBirthdate) || ageFromDob(b.idBirthdate) === null) throw new AgeReviewError(400, "BAD_REQUEST", "The birthdate on the ID is required (YYYY-MM-DD).");
  return b.idBirthdate;
}

/** Applies every decision rule. `isDuplicate(fingerprint)` answers whether ANOTHER account already has an approved request with it. */
export async function planDecision(a: {
  admin: AdminRef; req: RequestCtx; user: UserCtx; body: DecideBody; isDuplicate: (fp: string) => Promise<boolean>; now?: Date;
}): Promise<Plan> {
  const { admin, req, user, body } = a;
  const now = a.now ?? new Date();
  if (isSelfReview(admin, user)) throw new AgeReviewError(403, "SELF_REVIEW", "You cannot review your own age check.");
  if (!["submitted", "in_review"].includes(req.status)) throw new AgeReviewError(409, "WRONG_STATE", "This request is not waiting for a decision.");
  if (!DECISION_OUTCOMES.includes(body.outcome)) throw new AgeReviewError(400, "BAD_REQUEST", "Unknown outcome.");
  const base: Plan = {
    outcome: body.outcome, finalStatus: "declined", account: null, declineReason: null, dobMatch: false, proposedDob: null,
    fingerprint: null, documentType: null, bumpMore: false, deleteEvidence: true, notify: null,
  };

  const fingerprintFor = async (): Promise<{ fp: string; type: string }> => {
    const type = req.document_type ?? body.documentType ?? null;
    if (!type || !body.documentNumber?.trim()) throw new AgeReviewError(400, "BAD_REQUEST", "The document type and number are required.");
    const fp = documentFingerprint(type, body.documentNumber);
    if (await a.isDuplicate(fp)) {
      if (!body.overrideDuplicate) throw new AgeReviewError(409, "DUPLICATE_DOCUMENT", "This document already verified another account.");
      if (admin.role !== "super_admin") throw new AgeReviewError(403, "NOT_ALLOWED", "Only a super admin can override a duplicate document.");
    }
    return { fp, type };
  };

  switch (body.outcome) {
    case "verify": {
      if (!CHECKLIST_KEYS.every((k) => body.checklist?.[k] === true)) throw new AgeReviewError(400, "CHECKLIST_INCOMPLETE", "Tick every item on the checklist first.");
      const idDob = needBirthdate(body);
      if (!req.registered_dob_snapshot || user.dateOfBirth?.slice(0, 10) !== req.registered_dob_snapshot.slice(0, 10)) {
        throw new AgeReviewError(409, "WRONG_STATE", "The registered birthdate changed since this request started.");
      }
      const age = ageFromDob(idDob, now);
      if (idDob !== req.registered_dob_snapshot.slice(0, 10) || age === null || age < 18) {
        throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate does not match the registered one or is under 18. Use teen correction or birthdate change.");
      }
      const { fp, type } = await fingerprintFor();
      return { ...base, finalStatus: "approved", outcome: "verified", account: { kind: "verify", method: req.method === "live" ? "admin_live" : "admin_upload" }, dobMatch: true, fingerprint: fp, documentType: type, notify: "approved" };
    }
    case "teen_correction": {
      const idDob = needBirthdate(body);
      const age = ageFromDob(idDob, now);
      if (age === null || age >= 18) throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate does not make this person under 18.");
      return { ...base, finalStatus: "declined", outcome: "teen_correction", account: { kind: "correct_dob", dob: idDob, reason: "age review: ID shows under 18" }, dobMatch: false, notify: "teen_moved" };
    }
    case "birthdate_change": {
      const idDob = needBirthdate(body);
      const age = ageFromDob(idDob, now);
      if (age === null || age < 18) throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate must be an adult birthdate. Use teen correction.");
      if (idDob === req.registered_dob_snapshot?.slice(0, 10)) throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate matches the registered one. Use verify.");
      let fp: string | null = null, type: string | null = req.document_type ?? body.documentType ?? null;
      if (body.documentNumber?.trim()) ({ fp, type } = await fingerprintFor());
      // Evidence stays until the second approver has decided.
      return { ...base, finalStatus: "pending_second_approval", outcome: "birthdate_change", proposedDob: idDob, fingerprint: fp, documentType: type, deleteEvidence: false };
    }
    case "needs_more":
      if (req.method !== "upload") throw new AgeReviewError(409, "WRONG_STATE", "A live check cannot ask for more photos.");
      if (req.more_requests >= MAX_NEEDS_MORE_ROUNDS) throw new AgeReviewError(409, "WRONG_STATE", "You already asked for more twice. Decline instead.");
      return { ...base, finalStatus: "needs_more", outcome: "needs_more", bumpMore: true, deleteEvidence: false, notify: "needs_more" };
    case "decline":
      if (!body.declineReason || !DECLINE_REASONS.includes(body.declineReason)) throw new AgeReviewError(400, "REASON_REQUIRED", "Choose a reason for declining.");
      return { ...base, finalStatus: "declined", outcome: "declined", declineReason: body.declineReason, notify: "declined" };
    case "not_eligible_minor":
      return { ...base, finalStatus: "closed_minor", outcome: "not_eligible_minor", dobMatch: true, notify: "declined" };
  }
}

// ------------------------------------------------------------------ I/O
async function getPool() { return (await import("../storage")).pool; }
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
export const QUEUE_DEFAULT_STATUSES = ["submitted", "in_review", "needs_more", "pending_second_approval"] as const;
const ALL_STATUSES = ["draft", ...QUEUE_DEFAULT_STATUSES, "approved", "declined", "expired", "cancelled", "closed_minor"];
const TS = `to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

type ItemRow = {
  id: string; created_at: Date; submitted_at: Date | null; method: string; status: string; user_id: string; display_name: string | null; username: string;
  document_type: string | null; registered_dob_snapshot: string | null; more_requests: number; ck?: string;
};
const itemOf = (r: ItemRow, now = new Date()) => ({
  id: r.id, createdAt: iso(r.created_at)!, submittedAt: iso(r.submitted_at), method: r.method, status: r.status, userId: r.user_id,
  displayName: r.display_name || r.username, documentType: r.document_type,
  registeredAge: ageFromDob(r.registered_dob_snapshot, now), needsMore: r.status === "needs_more", awaitingSecondApproval: r.status === "pending_second_approval",
});

function encodeCursor(ck: string, id: string) { return Buffer.from(JSON.stringify({ k: ck, id }), "utf8").toString("base64url"); }
function decodeCursor(c: string): { k: string; id: string } | null {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { k?: unknown; id?: unknown };
    return typeof o.k === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(o.k) && typeof o.id === "string" && isUuid(o.id) ? { k: o.k, id: o.id } : null;
  } catch { return null; }
}

export async function listQueue(q: { status?: string; cursor?: string; limit?: number }) {
  const pool = await getPool();
  const limit = Math.min(Math.max(Math.trunc(q.limit || 25), 1), 100);
  if (q.status && !ALL_STATUSES.includes(q.status)) throw new AgeReviewError(400, "BAD_REQUEST", "Unknown status.");
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cur) throw new AgeReviewError(400, "BAD_REQUEST", "Bad cursor.");
  const statuses = q.status ? [q.status] : [...QUEUE_DEFAULT_STATUSES];
  const rows = (await pool.query(
    `select r.id, r.created_at, r.submitted_at, r.method, r.status, r.user_id, u.display_name, u.username, r.document_type, r.registered_dob_snapshot, r.more_requests, ${TS} as ck
       from age_review_requests r join users u on u.id = r.user_id
      where r.status = any($1::text[]) and ($2::text is null or (${TS}, r.id::text) > ($2::text, $3::text))
      order by r.created_at asc, r.id asc limit $4`,
    [statuses, cur?.k ?? null, cur?.id ?? null, limit + 1],
  )).rows as ItemRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => itemOf(r)), nextCursor: rows.length > limit && last ? encodeCursor(last.ck!, last.id) : null };
}

/** Detail for a reviewer. Opening a submitted request claims it (moves to in_review, records the reviewer). Never returns evidence bytes. */
export async function getDetail(admin: AdminRef, id: string) {
  const pool = await getPool();
  const row = (await pool.query(
    `select r.*, u.display_name, u.username, u.email as user_email from age_review_requests r join users u on u.id = r.user_id where r.id = $1`, [id],
  )).rows[0] as (ItemRow & Record<string, any>) | undefined;
  if (!row) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  const self = isSelfReview(admin, { email: row.user_email, dateOfBirth: null });
  if (row.status === "submitted" && !self) {
    const u = await pool.query(`update age_review_requests set status = 'in_review', reviewer_id = $2 where id = $1 and status = 'submitted' returning reviewer_id`, [id, admin.id]);
    if (u.rowCount) { row.status = "in_review"; row.reviewer_id = admin.id; }
  }
  const evidence = self ? [] : (await pool.query(`select id, kind, mime, greatest(octet_length(bytes_enc) - 31, 0) as bytes from age_review_evidence where request_id = $1 order by kind`, [id])).rows
    .map((e: { id: string; kind: string; mime: string; bytes: string | number }) => ({ id: e.id, kind: e.kind, mime: e.mime, bytes: Number(e.bytes) }));
  const open = row.status === "submitted" || row.status === "in_review";
  return {
    request: {
      ...itemOf(row),
      registeredDob: row.registered_dob_snapshot ?? "",
      code: row.method === "upload" ? row.code ?? null : null,
      codeExpiresAt: row.method === "upload" ? iso(row.code_expires_at) : null,
      moreRequests: Number(row.more_requests),
      consentRecorded: !!row.consent_version && !!row.consented_at,
      liveInviteExpiresAt: iso(row.live_invite_expires_at),
    },
    evidence,
    checklist: [...CHECKLIST_KEYS],
    canDecide: open && !self,
    canSecondApprove: row.status === "pending_second_approval" && admin.role === "super_admin" && row.reviewer_id !== admin.id && !self,
  };
}

async function withLock<T>(id: string, fn: (c: { query: (q: string, p?: any[]) => Promise<any> }) => Promise<T>): Promise<T> {
  const client = await (await getPool()).connect();
  try {
    await client.query(`select pg_advisory_lock(hashtext($1))`, [`age_review:${id}`]);
    return await fn(client);
  } finally {
    await client.query(`select pg_advisory_unlock(hashtext($1))`, [`age_review:${id}`]).catch(() => {});
    client.release();
  }
}

async function loadLocked(c: { query: (q: string, p?: any[]) => Promise<any> }, id: string) {
  const r = (await c.query(
    `select r.id, r.user_id, r.method, r.status, r.document_type, r.registered_dob_snapshot, r.more_requests, r.reviewer_id, r.proposed_dob, r.second_approver_id,
            u.email as user_email, u.date_of_birth as user_dob
       from age_review_requests r join users u on u.id = r.user_id where r.id = $1`, [id])).rows[0] as (RequestCtx & { user_email: string | null; user_dob: string | null }) | undefined;
  if (!r) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  return r;
}

/** The account-level change comes first and is idempotent; if it succeeded but the request update fails, the request stays open and a retry converges. */
async function applyAccount(adminId: string, userId: string, account: NonNullable<Plan["account"]>, ip?: string) {
  const { storage } = await import("../storage");
  if (account.kind === "verify") {
    await storage.setAgeVerification(userId, { verified: true, method: account.method });
    return;
  }
  const user = await storage.getUser(userId);
  if (user?.dateOfBirth?.slice(0, 10) !== account.dob) {
    const { correctDateOfBirth } = await import("../services/dobCorrection");
    const r = await correctDateOfBirth({ adminId, userId, dateOfBirth: account.dob, reason: account.reason, ip });
    if (!r.ok) throw new AgeReviewError(r.status === 404 ? 404 : 400, "BAD_REQUEST", r.message);
    if (r.roomsFailed) console.error(`[AGE-REVIEW] ALERT birthdate saved but applying it to rooms failed (request user ${userId})`);
  } else {
    // Retry after a partial failure: the birthdate is already corrected, but verification must still be cleared.
    await storage.setAgeVerification(userId, { verified: false });
  }
}

async function audit(adminId: string, action: string, id: string, details: string, ip?: string) {
  const { storage } = await import("../storage");
  await storage.logAdminActivity({ adminId, action, targetType: "age_review_request", targetId: id, details, reason: details, ipAddress: ip })
    .catch(() => console.error(`[AGE-REVIEW] ALERT ${action} took effect but the audit row failed (${id})`));
}

export async function decide(admin: AdminRef, id: string, body: DecideBody, ip?: string) {
  const result = await withLock(id, async (c) => {
    const r = await loadLocked(c, id);
    const plan = await planDecision({
      admin, req: r, user: { email: r.user_email, dateOfBirth: r.user_dob }, body,
      isDuplicate: async (fp) => ((await c.query(`select 1 from age_review_requests where document_fingerprint = $1 and status = 'approved' and user_id <> $2 limit 1`, [fp, r.user_id])).rowCount ?? 0) > 0,
    });
    if (plan.account) await applyAccount(admin.id, r.user_id, plan.account, ip);
    try {
      await c.query("begin");
      if (plan.deleteEvidence) await c.query(`delete from age_review_evidence where request_id = $1`, [id]);
      await c.query(
        `update age_review_requests set status = $2, outcome = $3, decline_reason = $4, dob_match = $5, proposed_dob = coalesce($6, proposed_dob),
                document_fingerprint = coalesce($7, document_fingerprint), document_type = coalesce(document_type, $8), reviewer_id = $9,
                more_requests = more_requests + $10, decided_at = case when $2 in ('needs_more', 'pending_second_approval') then decided_at else now() end
          where id = $1`,
        [id, plan.finalStatus, plan.outcome, plan.declineReason, plan.dobMatch, plan.proposedDob, plan.fingerprint, plan.documentType, admin.id, plan.bumpMore ? 1 : 0],
      );
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      if (plan.account) console.error(`[AGE-REVIEW] ALERT account change applied but the request update failed (${id}); request left open for retry`);
      throw e;
    }
    return { plan, userId: r.user_id };
  });
  await audit(admin.id, "age_review.decide", id, `outcome=${result.plan.outcome} request=${id}`, ip);
  if (result.plan.notify) { const { notifyAgeReview } = await import("./ageReviewNotify"); await notifyAgeReview(result.userId, result.plan.notify); }
  return (await getDetailRequestOnly(id));
}

export async function secondApprove(admin: AdminRef, id: string, body: { approve: boolean; reason: string }, ip?: string) {
  const result = await withLock(id, async (c) => {
    const r = await loadLocked(c, id);
    if (admin.role !== "super_admin") throw new AgeReviewError(403, "NOT_ALLOWED", "Only a super admin can give a second approval.");
    if (isSelfReview(admin, { email: r.user_email, dateOfBirth: null })) throw new AgeReviewError(403, "SELF_REVIEW", "You cannot review your own age check.");
    if (r.status !== "pending_second_approval" || !r.proposed_dob) throw new AgeReviewError(409, "WRONG_STATE", "This request is not waiting for a second approval.");
    if (r.reviewer_id === admin.id) throw new AgeReviewError(403, "SECOND_APPROVER_MUST_DIFFER", "A different super admin must give the second approval.");
    if (body.approve) {
      await applyAccount(admin.id, r.user_id, { kind: "correct_dob", dob: r.proposed_dob, reason: `age review second approval: ${body.reason}`.slice(0, 300) }, ip);
      const { storage } = await import("../storage");
      await storage.setAgeVerification(r.user_id, { verified: true, method: r.method === "live" ? "admin_live" : "admin_upload" });
    }
    try {
      await c.query("begin");
      await c.query(`delete from age_review_evidence where request_id = $1`, [id]);
      await c.query(
        `update age_review_requests set status = $2, outcome = $3, second_approver_id = $4, decided_at = now() where id = $1`,
        [id, body.approve ? "approved" : "declined", body.approve ? "birthdate_changed" : "birthdate_rejected", admin.id],
      );
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      if (body.approve) console.error(`[AGE-REVIEW] ALERT account change applied but the request update failed (${id}); request left open for retry`);
      throw e;
    }
    return r.user_id;
  });
  await audit(admin.id, "age_review.second_approve", id, `approve=${body.approve} request=${id}`, ip);
  const { notifyAgeReview } = await import("./ageReviewNotify");
  await notifyAgeReview(result, body.approve ? "approved" : "declined");
  return getDetailRequestOnly(id);
}

async function getDetailRequestOnly(id: string) {
  const pool = await getPool();
  const row = (await pool.query(`select r.*, u.display_name, u.username from age_review_requests r join users u on u.id = r.user_id where r.id = $1`, [id])).rows[0] as ItemRow & Record<string, any>;
  return {
    ...itemOf(row),
    registeredDob: row.registered_dob_snapshot ?? "",
    code: null, codeExpiresAt: null,
    moreRequests: Number(row.more_requests),
    consentRecorded: !!row.consent_version && !!row.consented_at,
    liveInviteExpiresAt: iso(row.live_invite_expires_at),
  };
}
