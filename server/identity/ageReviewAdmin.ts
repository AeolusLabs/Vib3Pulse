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
import { normaliseLegalName, openProposedName, sealProposedName } from "./verifiedName";
import { clearNameAndMatchTx, storeNameTx } from "./payoutNameGuard";

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
  /** The full name on the document; only for a request that asked for payouts. Never logged, audited or returned. */
  legalName?: string;
};
export type RequestCtx = {
  id: string; user_id: string; method: "upload" | "live"; status: string; document_type: string | null;
  registered_dob_snapshot: string | null; more_requests: number; reviewer_id: string | null; proposed_dob: string | null; wants_payouts?: boolean;
  /** The name the person typed for their payouts check (decrypted); null when none was given. The reviewer only confirms it against the ID. */
  claimedName?: string | null;
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
  /** Set when a super_admin knowingly verified a document that already verified another account. */
  overrideReason: string | null;
  /** The normalised legal name to store with the verification (verify only). */
  storeName: string | null;
  /** The name to hold, sealed, until the second approval (birthdate_change only). */
  holdName: string | null;
  deleteName: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A live check has no code selfie, so codeMatches is not required there. */
export const requiredChecklist = (method: string): readonly string[] => (method === "live" ? CHECKLIST_KEYS.filter((k) => k !== "codeMatches") : CHECKLIST_KEYS);

/** Lower case, no +tag, and no dots for Gmail: the usual ways one mailbox is written as several addresses. */
export function normalizeEmail(e: string): string {
  const [local0, domain0 = ""] = e.trim().toLowerCase().split("@");
  let local = local0.split("+")[0], domain = domain0;
  if (domain === "gmail.com" || domain === "googlemail.com") { local = local.replace(/\./g, ""); domain = "gmail.com"; }
  return `${local}@${domain}`;
}

export function isSelfReview(admin: AdminRef, user: UserCtx): boolean {
  return !!user.email && !!admin.email && normalizeEmail(admin.email) === normalizeEmail(user.email);
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
    fingerprint: null, documentType: null, bumpMore: false, deleteEvidence: true, notify: null, overrideReason: null, storeName: null, holdName: null, deleteName: false,
  };

  // A name is asked for exactly when the user asked for payouts.
  const nameFor = (useClaimed = false): string | null => {
    const sent = typeof body.legalName === "string" && body.legalName.trim().length > 0;
    if (!req.wants_payouts) {
      if (sent) throw new AgeReviewError(400, "NAME_NOT_REQUESTED", "This person did not ask to receive money, so no name is recorded.");
      return null;
    }
    const given = sent ? body.legalName : useClaimed ? req.claimedName : null;
    if (!given) throw new AgeReviewError(400, "NAME_REQUIRED", "Enter the full name on the document.");
    const n = normaliseLegalName(given);
    if (!n) throw new AgeReviewError(400, "BAD_REQUEST", "That is not a usable name.");
    return n;
  };

  const checklistFull = () => requiredChecklist(req.method).every((k) => body.checklist?.[k] === true);
  let overrideReason: string | null = null;
  // A live check shows the ID on camera and the user uploaded no document, so there is no type or number to record and no
  // duplicate check (upload reviews keep both).
  const fingerprintFor = async (): Promise<{ fp: string | null; type: string | null }> => {
    if (req.method === "live") return { fp: null, type: null };
    const type = req.document_type ?? body.documentType ?? null;
    if (!type || !body.documentNumber?.trim()) throw new AgeReviewError(400, "BAD_REQUEST", "The document type and number are required.");
    const fp = documentFingerprint(type, body.documentNumber);
    if (await a.isDuplicate(fp)) {
      if (!body.overrideDuplicate) throw new AgeReviewError(409, "DUPLICATE_DOCUMENT", "This document already verified another account.");
      if (admin.role !== "super_admin") throw new AgeReviewError(403, "NOT_ALLOWED", "Only a super admin can override a duplicate document.");
      overrideReason = body.overrideDuplicate.reason;
    }
    return { fp, type };
  };

  switch (body.outcome) {
    case "verify": {
      // Kept simple on purpose: the reviewer looks at the ID and the selfie, enters the ID birthdate (it must equal the registered one), and verifies.
      // Verify is one click: the reviewer saw the registered birthdate and the typed name next to the ID. An ID birthdate sent anyway must still match.
      const idDob = body.idBirthdate ? needBirthdate(body) : (req.registered_dob_snapshot ?? "").slice(0, 10);
      if (!req.registered_dob_snapshot || user.dateOfBirth?.slice(0, 10) !== req.registered_dob_snapshot.slice(0, 10)) {
        throw new AgeReviewError(409, "WRONG_STATE", "The registered birthdate changed since this request started.");
      }
      const age = ageFromDob(idDob, now);
      if (idDob !== req.registered_dob_snapshot.slice(0, 10) || age === null || age < 18) {
        throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate does not match the registered one or is under 18. Use teen correction or birthdate change.");
      }
      const storeName = nameFor(true);
      return { ...base, storeName, finalStatus: "approved", outcome: "verified", account: { kind: "verify", method: req.method === "live" ? "admin_live" : "admin_upload" }, dobMatch: true, notify: "approved" };
    }
    case "teen_correction": {
      const idDob = needBirthdate(body);
      const age = ageFromDob(idDob, now);
      if (age === null || age >= 18) throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate does not make this person under 18.");
      return { ...base, finalStatus: "declined", outcome: "teen_correction", account: { kind: "correct_dob", dob: idDob, reason: "age review: ID shows under 18" }, dobMatch: false, notify: "teen_moved", deleteName: true };
    }
    case "birthdate_change": {
      // Checked as fully as verify, so the second approver is approving a complete case.
      if (!checklistFull()) throw new AgeReviewError(400, "CHECKLIST_INCOMPLETE", "Tick every item on the checklist first.");
      const idDob = needBirthdate(body);
      const age = ageFromDob(idDob, now);
      if (age === null || age < 18) throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate must be an adult birthdate. Use teen correction.");
      if (idDob === req.registered_dob_snapshot?.slice(0, 10)) throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID birthdate matches the registered one. Use verify.");
      const holdName = nameFor();
      const { fp, type } = await fingerprintFor();
      // Evidence and the proposed name stay until the second approver has decided.
      return { ...base, holdName, finalStatus: "pending_second_approval", outcome: "birthdate_change", proposedDob: idDob, fingerprint: fp, documentType: type, deleteEvidence: false, overrideReason };
    }
    case "needs_more":
      if (req.method !== "upload") throw new AgeReviewError(409, "WRONG_STATE", "A live check cannot ask for more photos.");
      if (req.more_requests >= MAX_NEEDS_MORE_ROUNDS) throw new AgeReviewError(409, "WRONG_STATE", "You already asked for more twice. Decline instead.");
      return { ...base, finalStatus: "needs_more", outcome: "needs_more", bumpMore: true, deleteEvidence: false, notify: "needs_more" };
    case "decline":
      if (!body.declineReason || !DECLINE_REASONS.includes(body.declineReason)) throw new AgeReviewError(400, "REASON_REQUIRED", "Choose a reason for declining.");
      return { ...base, finalStatus: "declined", outcome: "declined", declineReason: body.declineReason, notify: "declined" };
    case "not_eligible_minor": {
      // Only for an ID that matches the registered birthdate and shows under 18; it must not be a way to dump any request.
      const idDob = needBirthdate(body);
      const age = ageFromDob(idDob, now);
      if (idDob !== req.registered_dob_snapshot?.slice(0, 10) || age === null || age >= 18) throw new AgeReviewError(400, "BIRTHDATE_MISMATCH", "The ID must match the registered birthdate and show under 18.");
      return { ...base, finalStatus: "closed_minor", outcome: "not_eligible_minor", dobMatch: true, notify: "declined" };
    }
  }
}

// ------------------------------------------------------------------ I/O
async function getPool() { return (await import("../storage")).pool; }
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
export const QUEUE_DEFAULT_STATUSES = ["submitted", "in_review", "needs_more", "pending_second_approval"] as const;
const ALL_STATUSES = [...QUEUE_DEFAULT_STATUSES, "approved", "declined", "expired", "cancelled", "closed_minor"];
const TS = `to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

type ItemRow = {
  id: string; created_at: Date; submitted_at: Date | null; method: string; status: string; user_id: string; display_name: string | null; username: string;
  document_type: string | null; registered_dob_snapshot: string | null; more_requests: number; wants_payouts?: boolean; ck?: string;
};
const itemOf = (r: ItemRow, now = new Date()) => ({
  id: r.id, createdAt: iso(r.created_at)!, submittedAt: iso(r.submitted_at), method: r.method, status: r.status, userId: r.user_id,
  displayName: r.display_name || r.username, documentType: r.document_type,
  registeredAge: ageFromDob(r.registered_dob_snapshot, now), needsMore: r.status === "needs_more", awaitingSecondApproval: r.status === "pending_second_approval",
  wantsPayouts: r.wants_payouts === true,
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
  // A draft is the user still choosing what to upload: reviewers never see it, so ?status=draft is ignored.
  if (q.status === "draft") q = { ...q, status: undefined };
  if (q.status && !ALL_STATUSES.includes(q.status)) throw new AgeReviewError(400, "BAD_REQUEST", "Unknown status.");
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cur) throw new AgeReviewError(400, "BAD_REQUEST", "Bad cursor.");
  const statuses = q.status ? [q.status] : [...QUEUE_DEFAULT_STATUSES];
  const rows = (await pool.query(
    `select r.id, r.created_at, r.submitted_at, r.method, r.status, r.user_id, u.display_name, u.username, r.document_type, r.registered_dob_snapshot, r.more_requests, r.wants_payouts, ${TS} as ck
       from age_review_requests r join users u on u.id = r.user_id
      where r.status = any($1::text[]) and ($2::text is null or (${TS}, r.id::text) > ($2::text, $3::text))
      order by r.created_at asc, r.id asc limit $4`,
    [statuses, cur?.k ?? null, cur?.id ?? null, limit + 1],
  )).rows as ItemRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => itemOf(r)), nextCursor: rows.length > limit && last ? encodeCursor(last.ck!, last.id) : null };
}

/** The one condition under which a proposed birthdate is shown and a second approval offered. */
export const canSecondApproveView = (admin: AdminRef, row: { status: string; reviewer_id: string | null }, self: boolean): boolean =>
  row.status === "pending_second_approval" && admin.role === "super_admin" && row.reviewer_id !== admin.id && !self;

/** Detail for a reviewer. Opening a submitted request claims it (moves to in_review, records the reviewer). Never returns evidence bytes. */
export async function getDetail(admin: AdminRef, id: string) {
  const pool = await getPool();
  const row = (await pool.query(
    `select r.*, u.display_name, u.username, u.email as user_email from age_review_requests r join users u on u.id = r.user_id where r.id = $1`, [id],
  )).rows[0] as (ItemRow & Record<string, any>) | undefined;
  if (!row || row.status === "draft") throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  const self = isSelfReview(admin, { email: row.user_email, dateOfBirth: null });
  if (row.status === "submitted" && !self) {
    const u = await pool.query(`update age_review_requests set status = 'in_review', reviewer_id = $2 where id = $1 and status = 'submitted' returning reviewer_id`, [id, admin.id]);
    if (u.rowCount) { row.status = "in_review"; row.reviewer_id = admin.id; }
  }
  const evidence = self ? [] : (await pool.query(`select id, kind, mime, greatest(octet_length(bytes_enc) - 31, 0) as bytes from age_review_evidence where request_id = $1 order by kind`, [id])).rows
    .map((e: { id: string; kind: string; mime: string; bytes: string | number }) => ({ id: e.id, kind: e.kind, mime: e.mime, bytes: Number(e.bytes) }));
  const open = row.status === "submitted" || row.status === "in_review";
  const canSecondApprove = canSecondApproveView(admin, { status: row.status, reviewer_id: (row.reviewer_id as string | null | undefined) ?? null }, self);
  return {
    request: {
      ...itemOf(row),
      registeredDob: row.registered_dob_snapshot ?? "",
      // The second approver must see what they are approving; nobody else ever does.
      proposedDob: canSecondApprove ? row.proposed_dob ?? null : null,
      code: row.method === "upload" ? row.code ?? null : null,
      codeExpiresAt: row.method === "upload" ? iso(row.code_expires_at) : null,
      // Shown to the reviewer who decides, to compare with the ID; never to the person's own reviewer-self, never after the decision.
      claimedName: open && !self && row.wants_payouts ? claimedNameOf(row as any, id) : null,
      moreRequests: Number(row.more_requests),
      consentRecorded: !!row.consent_version && !!row.consented_at,
      liveInviteExpiresAt: iso(row.live_invite_expires_at),
    },
    evidence,
    checklist: [...CHECKLIST_KEYS],
    canDecide: open && !self,
    canSecondApprove,
  };
}

async function withLock<T>(id: string, fn: (c: { query: (q: string, p?: any[]) => Promise<any> }) => Promise<T>): Promise<T> {
  const client = await (await getPool()).connect();
  try {
    await client.query(`select pg_advisory_lock(hashtext($1))`, [`age_review:${id}`]);
    return await fn(client);
  } finally {
    // A session-level advisory lock that could not be released must not go back to the pool with the connection.
    let unlocked = true;
    await client.query(`select pg_advisory_unlock(hashtext($1))`, [`age_review:${id}`]).catch(() => { unlocked = false; });
    client.release(unlocked ? undefined : true);
  }
}

function claimedNameOf(r: { wants_payouts?: boolean; proposed_legal_name_enc?: Buffer | null }, id: string): string | null {
  if (!r.wants_payouts || !r.proposed_legal_name_enc) return null;
  try { return openProposedName(r.proposed_legal_name_enc, id); } catch { return null; }
}

async function loadLocked(c: { query: (q: string, p?: any[]) => Promise<any> }, id: string, forUpdate = false) {
  const r = (await c.query(
    `select r.id, r.user_id, r.method, r.status, r.document_type, r.registered_dob_snapshot, r.more_requests, r.reviewer_id, r.proposed_dob, r.second_approver_id, r.document_fingerprint, r.wants_payouts, r.proposed_legal_name_enc,
            u.email as user_email, u.date_of_birth as user_dob
       from age_review_requests r join users u on u.id = r.user_id where r.id = $1 ${forUpdate ? "for update of r" : ""}`, [id])).rows[0] as (RequestCtx & { user_email: string | null; user_dob: string | null; document_fingerprint: string | null; proposed_legal_name_enc: Buffer | null }) | undefined;
  if (!r) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  return r;
}

/** The account-level change comes first and is idempotent; if it succeeded but the request update fails, the request stays open and a retry converges. */
async function applyAccount(adminId: string, userId: string, account: NonNullable<Plan["account"]>, ip?: string): Promise<boolean> {
  const { storage } = await import("../storage");
  if (account.kind === "verify") {
    // A payouts-only review of someone already verified keeps the original verification (date and method); only the name is new.
    if ((await storage.getUser(userId))?.ageVerifiedAt) return false;
    await storage.setAgeVerification(userId, { verified: true, method: account.method });
    return true;
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
  return true;
}

/** Test hook (no database needed). */
export const applyAccountForTests = applyAccount;

async function audit(adminId: string, action: string, id: string, details: string, ip?: string) {
  const { storage } = await import("../storage");
  await storage.logAdminActivity({ adminId, action, targetType: "age_review_request", targetId: id, details, reason: details, ipAddress: ip })
    .catch(() => console.error(`[AGE-REVIEW] ALERT ${action} took effect but the audit row failed (${id})`));
}

export async function decide(admin: AdminRef, id: string, body: DecideBody, ip?: string) {
  const result = await withLock(id, async (c) => {
    let applied: Plan["account"] = null;
    let r: Awaited<ReturnType<typeof loadLocked>> | null = null;
    try {
      await c.query("begin");
      // The row lock is held from here to the commit: cancel, submit and the expiry sweep all need it, so none can slip in between
      // the status check, the account change and the request update.
      r = await loadLocked(c, id, true);
      const req = { ...r, claimedName: claimedNameOf(r, id) };
      const plan = await planDecision({
        admin, req, user: { email: req.user_email, dateOfBirth: req.user_dob }, body,
        isDuplicate: async (fp) => ((await c.query(`select 1 from age_review_requests where document_fingerprint = $1 and status = 'approved' and user_id <> $2 limit 1`, [fp, req.user_id])).rowCount ?? 0) > 0,
      });
      if (plan.account && (await applyAccount(admin.id, req.user_id, plan.account, ip))) applied = plan.account;
      // The name goes in on the same connection and transaction as the verification: both commit together or neither does.
      // A different new name also clears the account's match (storeNameTx); removing a name clears it too. Both under the account lock.
      if (plan.storeName) await storeNameTx(c, req.user_id, plan.storeName, id, admin.id);
      if (plan.deleteName) await clearNameAndMatchTx(c, req.user_id);
      if (plan.deleteEvidence) await c.query(`delete from age_review_evidence where request_id = $1`, [id]);
      await c.query(
        `update age_review_requests set status = $2, outcome = $3, decline_reason = $4, dob_match = $5,
                proposed_dob = case when $2 in ('approved', 'declined', 'closed_minor') then null else coalesce($6, proposed_dob) end,
                proposed_legal_name_enc = case when $2 in ('approved', 'declined', 'closed_minor') then null else coalesce($11, proposed_legal_name_enc) end,
                code = case when $2 in ('approved', 'declined', 'closed_minor') then null else code end,
                code_expires_at = case when $2 in ('approved', 'declined', 'closed_minor') then null else code_expires_at end,
                document_fingerprint = coalesce($7, document_fingerprint), document_type = coalesce(document_type, $8), reviewer_id = $9,
                more_requests = more_requests + $10, decided_at = case when $2 in ('needs_more', 'pending_second_approval') then decided_at else now() end
          where id = $1`,
        [id, plan.finalStatus, plan.outcome, plan.declineReason, plan.dobMatch, plan.proposedDob, plan.fingerprint, plan.documentType, admin.id, plan.bumpMore ? 1 : 0, plan.holdName ? sealProposedName(plan.holdName, id) : null],
      );
      await c.query("commit");
      return { plan, userId: req.user_id, method: req.method, payouts: req.wants_payouts === true };
    } catch (e) {
      await c.query("rollback").catch(() => {});
      if (applied && r) await compensateAccountChange(id, r.user_id, applied);
      throw e;
    }
  });
  await audit(admin.id, "age_review.decide", id, `outcome=${result.plan.outcome} request=${id}${result.payouts ? " payouts=true" : ""}${body.note?.trim() ? ` note=${body.note.trim().slice(0, 300)}` : ""}`, ip);
  if (result.plan.overrideReason) await audit(admin.id, "age_review.duplicate_override", id, `request=${id} reason=${result.plan.overrideReason}`, ip);
  if (result.method === "live") await closeRoomQuietly(id);
  // A payouts check that passed: say what is next and open the page where the bank account is added.
  const payoutsDone = result.payouts && result.plan.notify === "approved";
  if (result.plan.notify) await notifyQuietly(result.userId, result.plan.notify, payoutsDone ? { detail: "Next, add your bank account to get paid.", link: "/rooms/payouts" } : undefined);
  return getDetailRequestOnly(id);
}

/** The request update failed after the account was changed. Verification can be taken back; a corrected birthdate cannot, so it is flagged. */
export async function compensateAccountChange(id: string, userId: string, account: NonNullable<Plan["account"]>) {
  try {
    const { storage } = await import("../storage");
    await storage.setAgeVerification(userId, { verified: false });
    console.error(`[AGE-REVIEW] ALERT account change was undone because the request update failed (${id})`);
  } catch {
    console.error(`[AGE-REVIEW] ALERT account change could not be undone after a failed request update (${id})`);
  }
  if (account.kind === "correct_dob") console.error(`[AGE-REVIEW] ALERT birthdate correction stays applied; the request is left open (${id})`);
}

/** The decision is committed: a notice that fails must never turn it into an error. */
async function notifyQuietly(userId: string, kind: "approved" | "declined" | "needs_more" | "teen_moved", extra?: { detail: string; link: string }) {
  try { const { notifyAgeReview } = await import("./ageReviewNotify"); await notifyAgeReview(userId, kind, extra?.detail, extra?.link); }
  catch { console.error("[AGE-REVIEW] ALERT a decision notice could not be sent"); }
}

async function closeRoomQuietly(id: string) {
  try { await (await import("./ageReviewLive")).closeAgeCheckRoom(id); } catch { /* the timer and the sweep close it too */ }
}

export async function secondApprove(admin: AdminRef, id: string, body: { approve: boolean; reason: string; overrideDuplicate?: { reason: string } }, ip?: string) {
  let overrideReason: string | null = null;
  const result = await withLock(id, async (c) => {
    let applied = false;
    let r: Awaited<ReturnType<typeof loadLocked>> | null = null;
    try {
      await c.query("begin");
      r = await loadLocked(c, id, true);
      if (admin.role !== "super_admin") throw new AgeReviewError(403, "NOT_ALLOWED", "Only a super admin can give a second approval.");
      if (isSelfReview(admin, { email: r.user_email, dateOfBirth: null })) throw new AgeReviewError(403, "SELF_REVIEW", "You cannot review your own age check.");
      if (r.status !== "pending_second_approval" || !r.proposed_dob) throw new AgeReviewError(409, "WRONG_STATE", "This request is not waiting for a second approval.");
      if (r.reviewer_id === admin.id) throw new AgeReviewError(403, "SECOND_APPROVER_MUST_DIFFER", "A different super admin must give the second approval.");
      if (body.approve) {
        // Another account may have been verified with this document while the case waited.
        if (r.document_fingerprint && ((await c.query(`select 1 from age_review_requests where document_fingerprint = $1 and status = 'approved' and user_id <> $2 limit 1`, [r.document_fingerprint, r.user_id])).rowCount ?? 0) > 0) {
          // The second approver is a super_admin, the role the override needs; a reject never reaches this check.
          if (!body.overrideDuplicate) throw new AgeReviewError(409, "DUPLICATE_DOCUMENT", "This document has since verified another account.");
          overrideReason = body.overrideDuplicate.reason;
        }
        await applyAccount(admin.id, r.user_id, { kind: "correct_dob", dob: r.proposed_dob, reason: `age review second approval: ${body.reason}`.slice(0, 300) }, ip);
        applied = true;
        const { storage } = await import("../storage");
        await storage.setAgeVerification(r.user_id, { verified: true, method: r.method === "live" ? "admin_live" : "admin_upload" });
        // The name held at queue time is stored now, in the same transaction as the decision.
        if (r.wants_payouts && r.proposed_legal_name_enc) await storeNameTx(c, r.user_id, openProposedName(r.proposed_legal_name_enc, id), id, admin.id);
      }
      await c.query(`delete from age_review_evidence where request_id = $1`, [id]);
      await c.query(
        `update age_review_requests set status = $2, outcome = $3, second_approver_id = $4, proposed_dob = null, proposed_legal_name_enc = null, code = null, code_expires_at = null, decided_at = now() where id = $1`,
        [id, body.approve ? "approved" : "declined", body.approve ? "birthdate_changed" : "birthdate_rejected", admin.id],
      );
      await c.query("commit");
      return { userId: r.user_id, method: r.method };
    } catch (e) {
      await c.query("rollback").catch(() => {});
      if (applied && r) await compensateAccountChange(id, r.user_id, { kind: "correct_dob", dob: "", reason: "" });
      throw e;
    }
  });
  await audit(admin.id, "age_review.second_approve", id, `approve=${body.approve} request=${id}`, ip);
  if (overrideReason) await audit(admin.id, "age_review.duplicate_override", id, `request=${id} reason=${overrideReason}`, ip);
  if (result.method === "live") await closeRoomQuietly(id);
  await notifyQuietly(result.userId, body.approve ? "approved" : "declined");
  return getDetailRequestOnly(id);
}

async function getDetailRequestOnly(id: string) {
  const pool = await getPool();
  const row = (await pool.query(`select r.*, u.display_name, u.username from age_review_requests r join users u on u.id = r.user_id where r.id = $1`, [id])).rows[0] as ItemRow & Record<string, any>;
  // The registered birthdate and a proposed one are only ever in the detail view.
  return {
    ...itemOf(row),
    code: null, codeExpiresAt: null,
    moreRequests: Number(row.more_requests),
    consentRecorded: !!row.consent_version && !!row.consented_at,
    liveInviteExpiresAt: iso(row.live_invite_expires_at),
  };
}
