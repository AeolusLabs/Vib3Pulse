// User side of manual age review. Raw SQL on the shared pool (imported lazily so this module loads without a database).
// Evidence never leaves this module as JSON: the user API only ever reports which kinds exist.
import { fileTypeFromBuffer } from "file-type";
import {
  CONSENT_VERSION, CODE_TTL_MS, REQUEST_EXPIRY_MS, DOCUMENT_TYPES, EVIDENCE_MAX_BYTES, EVIDENCE_MIMES, CANCELLABLE_STATUSES,
  attemptState, generateCode, isOpenStatus, registeredEligibility,
} from "../../shared/ageReview";
import { encryptEvidence } from "./evidenceCrypto";
import { ageReviewPaused } from "./ageReviewFeatures";
import { hasVerifiedName, normaliseLegalName, sealProposedName } from "./verifiedName";

export class AgeReviewError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

async function getPool() { return (await import("../storage")).pool; }

type Row = {
  id: string; user_id: string; method: "upload" | "live"; status: string; document_type: string | null; code: string | null;
  code_expires_at: Date | null; decline_reason: string | null; live_invite_expires_at: Date | null; consented_at: Date | null;
  submitted_at: Date | null; decided_at: Date | null; created_at: Date; expires_at: Date; wants_payouts?: boolean;
};
type Queryable = { query: (q: string, p?: any[]) => Promise<any> };
const COLS = `id, user_id, method, status, document_type, code, code_expires_at, decline_reason, live_invite_expires_at, consented_at, submitted_at, decided_at, created_at, expires_at, wants_payouts`;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function toRequestDto(r: Row, kinds: string[], now: Date = new Date()) {
  const open = isOpenStatus(r.status);
  const codeLive = open && r.method === "upload" && !!r.code;
  return {
    id: r.id,
    method: r.method,
    status: r.status,
    documentType: r.document_type,
    canCancel: (CANCELLABLE_STATUSES as readonly string[]).includes(r.status),
    needsMore: r.status === "needs_more",
    hasDocument: kinds.includes("document"),
    hasSelfie: kinds.includes("selfie"),
    code: codeLive ? r.code : null,
    codeExpiresAt: codeLive ? iso(r.code_expires_at) : null,
    liveInviteExpiresAt: open && r.live_invite_expires_at && new Date(r.live_invite_expires_at) > now ? iso(r.live_invite_expires_at) : null,
    submittedAt: iso(r.submitted_at),
    declineReason: r.status === "declined" ? r.decline_reason : null,
    consentedAt: iso(r.consented_at),
    wantsPayouts: r.wants_payouts === true,
  };
}

async function loadOwned(userId: string, id: string, client?: Queryable, forUpdate = false): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  const exec = client ?? (await getPool());
  const r = (await exec.query(`select ${COLS} from age_review_requests where id = $1 ${forUpdate ? "for update" : ""}`, [id])).rows[0] as Row | undefined;
  if (!r) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  if (r.user_id !== userId) throw new AgeReviewError(403, "NOT_ALLOWED", "Not allowed");
  return r;
}

async function kindsOf(id: string, exec?: Queryable): Promise<string[]> {
  const q = exec ?? (await getPool());
  return (await q.query(`select kind from age_review_evidence where request_id = $1`, [id])).rows.map((x: { kind: string }) => x.kind);
}

async function inTx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
  const client = await (await getPool()).connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function getMe(userId: string, now: Date = new Date()) {
  const pool = await getPool();
  const user = (await pool.query(`select date_of_birth, age_verified_at, age_verified_method from users where id = $1`, [userId])).rows[0] as
    { date_of_birth: string | null; age_verified_at: Date | null; age_verified_method: string | null } | undefined;
  if (!user) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  const paused = await ageReviewPaused();
  const rows = (await pool.query(`select ${COLS} from age_review_requests where user_id = $1 order by created_at desc limit 20`, [userId])).rows as Row[];
  const { attemptsLeft, retryAfter } = attemptState(rows.map((r) => ({ status: r.status, decidedAt: r.decided_at })), now);
  const hasPayoutName = await hasVerifiedName(userId, pool);
  const base = { enabled: true as const, paused, consentVersion: CONSENT_VERSION, attemptsLeft, hasPayoutName };
  const eligibility = registeredEligibility(user.date_of_birth, now);
  const verifiedAdult = !!user.age_verified_at && eligibility === "ok";
  const m = user.age_verified_method;
  const verifiedInfo = verifiedAdult ? { method: (m === "admin_upload" || m === "admin_live" ? m : "admin") as "admin" | "admin_upload" | "admin_live", at: new Date(user.age_verified_at!).toISOString() } : null;

  // Only an open PAYOUTS review decides the state for someone already verified; for everyone else the older order stands.
  const openAny = rows.find((r) => isOpenStatus(r.status));
  const openState = async (open: Row) => {
    const state = open.status === "draft" ? "none" : open.status === "needs_more" ? "needs_more" : "in_review"; // a draft is the user still mid-flow
    return { ...base, state: state as "none" | "needs_more" | "in_review", verified: verifiedInfo, request: toRequestDto(open, await kindsOf(open.id), now), retryAfter: null };
  };
  if (eligibility === "ok" && openAny?.wants_payouts === true) return openState(openAny);
  // A verified person whose last check was declined still has to wait before the next one (a payouts check): say so up front.
  if (verifiedInfo) return { ...base, state: "verified" as const, verified: verifiedInfo, request: null, retryAfter: retryAfter && retryAfter > now ? retryAfter.toISOString() : null };
  const none = { verified: null, request: null, retryAfter: null };
  if (eligibility !== "ok") return { ...base, state: "not_offered" as const, ...none };
  if (openAny) return openState(openAny);

  const last = rows[0];
  if (last && last.status === "declined") {
    const cooling = retryAfter !== null && retryAfter > now;
    return { ...base, state: (cooling ? "cooldown" : "declined") as "cooldown" | "declined", verified: null, request: toRequestDto(last, [], now), retryAfter: cooling ? retryAfter!.toISOString() : null };
  }
  if (retryAfter && retryAfter > now) return { ...base, state: "cooldown" as const, ...none, retryAfter: retryAfter.toISOString() };
  return { ...base, state: "none" as const, ...none };
}

/**
 * A request that was answered must be closed. When an admin verifies someone another way (the Mark verified override), a request that
 * did not ask for payouts has nothing left to decide: it is closed as approved and its photos are deleted. One that asked for payouts
 * stays open, because the name on the ID is still to be recorded. Returns the closed requests (the live ones also need their room closed).
 */
export async function closeAnsweredRequests(userId: string): Promise<{ id: string; method: string }[]> {
  const pool = await getPool();
  const rows = (await pool.query(
    `with gone as (
       select id from age_review_requests
        where user_id = $1 and wants_payouts = false and status in ('draft', 'submitted', 'in_review', 'needs_more', 'pending_second_approval')
          for update
     ), wipe as (delete from age_review_evidence where request_id in (select id from gone))
     update age_review_requests set status = 'approved', outcome = 'verified', proposed_dob = null, proposed_legal_name_enc = null,
            code = null, code_expires_at = null, decided_at = now()
      where id in (select id from gone) returning id, method`,
    [userId],
  )).rows as { id: string; method: string }[];
  for (const r of rows) if (r.method === "live") { try { await (await import("./ageReviewLive")).closeAgeCheckRoom(r.id); } catch { /* the timer and the sweep close it too */ } }
  return rows;
}

export async function createRequest(userId: string, input: { method: "upload" | "live"; documentType?: string | null; consentVersion: string; wantsPayouts?: boolean; legalName?: string | null }, now: Date = new Date()) {
  if (input.consentVersion !== CONSENT_VERSION) throw new AgeReviewError(400, "CONSENT_REQUIRED", "Please read and accept the privacy notice first.");
  if (await ageReviewPaused()) throw new AgeReviewError(503, "AGE_REVIEW_PAUSED", "Age checks are paused right now. Please try again later.");
  const pool = await getPool();
  const user = (await pool.query(`select date_of_birth, age_verified_at from users where id = $1 and deleted_at is null`, [userId])).rows[0] as
    { date_of_birth: string | null; age_verified_at: Date | null } | undefined;
  if (!user) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  if (registeredEligibility(user.date_of_birth, now) !== "ok") throw new AgeReviewError(403, "NOT_OFFERED", "Age verification is not available for this account.");
  // A verified adult may only start a payouts review (to add the name on their ID, or to recheck it).
  if (user.age_verified_at && input.wantsPayouts !== true) throw new AgeReviewError(409, "ALREADY_VERIFIED", "Your age is already verified.");
  // Someone verified another way can still have an old request open that nothing will ever answer: close it, it must not block the payouts check.
  if (user.age_verified_at) await closeAnsweredRequests(userId);
  // Someone who wants to be paid types their own name as it is on the ID; the reviewer only checks it against the ID.
  const claimed = input.wantsPayouts === true ? normaliseLegalName(input.legalName) : null;
  if (input.wantsPayouts === true && !claimed) throw new AgeReviewError(400, "NAME_REQUIRED", "Enter your full name as it appears on your ID.");
  const upload = input.method === "upload";
  if (upload && !(DOCUMENT_TYPES as readonly string[]).includes(input.documentType ?? "")) throw new AgeReviewError(400, "BAD_REQUEST", "Choose a document type.");
  const history = (await pool.query(`select status, decided_at from age_review_requests where user_id = $1 order by created_at desc limit 50`, [userId])).rows as { status: string; decided_at: Date | null }[];
  if (history.some((h) => isOpenStatus(h.status))) throw new AgeReviewError(409, "OPEN_REQUEST_EXISTS", "You already have a request open.");
  const { attemptsLeft, retryAfter } = attemptState(history.map((h) => ({ status: h.status, decidedAt: h.decided_at })), now);
  if (retryAfter) throw new AgeReviewError(429, "RATE_LIMITED", "Please wait before trying again.", { retryAfter: retryAfter.toISOString(), attemptsLeft });
  try {
    const r = (await pool.query(
      `insert into age_review_requests (user_id, method, status, document_type, code, code_expires_at, registered_dob_snapshot, consent_version, consented_at, expires_at, wants_payouts)
       values ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLS}`,
      [userId, input.method, input.documentType ?? null, upload ? generateCode() : null,
        upload ? new Date(now.getTime() + CODE_TTL_MS) : null, user.date_of_birth, CONSENT_VERSION, now, new Date(now.getTime() + REQUEST_EXPIRY_MS), input.wantsPayouts === true],
    )).rows[0] as Row;
    if (claimed) await pool.query(`update age_review_requests set proposed_legal_name_enc = $2 where id = $1`, [r.id, sealProposedName(claimed, r.id)]);
    return toRequestDto(r, [], now);
  } catch (e: any) {
    if (e?.code === "23505") throw new AgeReviewError(409, "OPEN_REQUEST_EXISTS", "You already have a request open.");
    throw e;
  }
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export async function putEvidence(userId: string, id: string, input: { kind: string; mime: string; data: string }, now: Date = new Date()) {
  if (input.kind !== "document" && input.kind !== "selfie") throw new AgeReviewError(400, "BAD_REQUEST", "Unknown item.");
  const req = await loadOwned(userId, id);
  if (req.method !== "upload" || !["draft", "needs_more"].includes(req.status)) throw new AgeReviewError(409, "WRONG_STATE", "This request cannot take photos now.");
  if (await ageReviewPaused()) throw new AgeReviewError(503, "AGE_REVIEW_PAUSED", "Age checks are paused right now. Please try again later.");
  if (input.kind === "selfie" && req.code_expires_at && new Date(req.code_expires_at) <= now) throw new AgeReviewError(409, "CODE_EXPIRED", "Your code expired. Get a new one.");
  const b64 = typeof input.data === "string" ? input.data.replace(/^data:[^,]*,/, "") : "";
  if (Math.floor((b64.length * 3) / 4) > EVIDENCE_MAX_BYTES + 3) throw new AgeReviewError(413, "TOO_LARGE", "That photo is too large.");
  if (!b64 || !B64.test(b64)) throw new AgeReviewError(400, "BAD_FILE", "That file is not a supported image.");
  const buf = Buffer.from(b64, "base64");
  if (buf.length > EVIDENCE_MAX_BYTES) throw new AgeReviewError(413, "TOO_LARGE", "That photo is too large.");
  const detected = await fileTypeFromBuffer(buf);
  if (!detected || !(EVIDENCE_MIMES as readonly string[]).includes(detected.mime) || detected.mime !== input.mime) {
    throw new AgeReviewError(400, "BAD_FILE", "That file is not a supported image.");
  }
  const enc = encryptEvidence(buf, `${req.id}:${input.kind}`);
  // The request row is locked (the same lock cancel and submit take) and its status re-checked before the insert, so an
  // upload racing a cancel either lands first and is deleted by the cancel, or sees "cancelled" and stores nothing.
  await inTx(async (c) => {
    const locked = await loadOwned(userId, id, c, true);
    if (locked.method !== "upload" || !["draft", "needs_more"].includes(locked.status)) throw new AgeReviewError(409, "WRONG_STATE", "This request cannot take photos now.");
    await c.query(
      `insert into age_review_evidence (request_id, kind, mime, bytes_enc) values ($1, $2, $3, $4)
       on conflict (request_id, kind) do update set mime = excluded.mime, bytes_enc = excluded.bytes_enc, created_at = now()`,
      [locked.id, input.kind, detected.mime, enc],
    );
  });
  return { kind: input.kind as "document" | "selfie", received: true as const };
}

export async function submitRequest(userId: string, id: string, now: Date = new Date()) {
  return inTx(async (c) => {
    const req = await loadOwned(userId, id, c, true);
    if (!["draft", "needs_more"].includes(req.status)) throw new AgeReviewError(409, "WRONG_STATE", "This request cannot be submitted now.");
    const kinds = await kindsOf(req.id, c);
    if (req.method === "upload" && !(kinds.includes("document") && kinds.includes("selfie"))) {
      throw new AgeReviewError(400, "EVIDENCE_INCOMPLETE", "Add your document photo and your selfie first.");
    }
    const row = (await c.query(`update age_review_requests set status = 'submitted', submitted_at = $2 where id = $1 returning ${COLS}`, [req.id, now])).rows[0] as Row;
    return toRequestDto(row, kinds, now);
  });
}

export async function cancelRequest(userId: string, id: string) {
  return inTx(async (c) => {
    const req = await loadOwned(userId, id, c, true);
    if (!(CANCELLABLE_STATUSES as readonly string[]).includes(req.status)) throw new AgeReviewError(409, "WRONG_STATE", "This request cannot be cancelled now.");
    await c.query(`delete from age_review_evidence where request_id = $1`, [req.id]);
    const row = (await c.query(`update age_review_requests set status = 'cancelled', proposed_dob = null, proposed_legal_name_enc = null, code = null, code_expires_at = null, decided_at = now() where id = $1 returning ${COLS}`, [req.id])).rows[0] as Row;
    return toRequestDto(row, []);
  });
}

export async function newCode(userId: string, id: string, now: Date = new Date()) {
  return inTx(async (c) => {
    const req = await loadOwned(userId, id, c, true);
    if (req.method !== "upload" || !["draft", "needs_more"].includes(req.status) || !req.code_expires_at || new Date(req.code_expires_at) > now) {
      throw new AgeReviewError(409, "WRONG_STATE", "A new code is not needed right now.");
    }
    if (await ageReviewPaused()) throw new AgeReviewError(503, "AGE_REVIEW_PAUSED", "Age checks are paused right now. Please try again later.");
    // A selfie holding the old code is no longer valid proof, so it goes with it.
    await c.query(`delete from age_review_evidence where request_id = $1 and kind = 'selfie'`, [req.id]);
    const row = (await c.query(`update age_review_requests set code = $2, code_expires_at = $3 where id = $1 returning ${COLS}`,
      [req.id, generateCode(), new Date(now.getTime() + CODE_TTL_MS)])).rows[0] as Row;
    return toRequestDto(row, await kindsOf(req.id, c), now);
  });
}
