// Evidence reveal: single-use 60 second tokens, the image response headers and the per-reviewer reveal limit.
// Tokens are HMAC signed (key derived from AGE_EVIDENCE_KEY with its own HKDF info string). Single use is enforced in the
// DATABASE (age_review_reveal_nonces): a restart or a second server instance cannot replay a consumed token.
import crypto from "crypto";
import { EVIDENCE_MIMES, REVEAL_LIMIT_PER_HOUR, REVEAL_TOKEN_TTL_SEC } from "../../shared/ageReview";
import { AgeReviewError } from "./ageReviewService";
import { EVIDENCE_KEY_MISSING, decryptEvidence, parseEvidenceKey } from "./evidenceCrypto";

const TOKEN_INFO = "vib3pulse:age-review:reveal-token:v1";
export type RevealClaims = { adminId: string; requestId: string; evidenceId: string };

/** claim() is true exactly once per nonce. */
export interface NonceStore { claim(nonce: string, expiresAtMs: number): Promise<boolean> }

const dbStore: NonceStore = {
  async claim(nonce, expiresAtMs) {
    const { pool } = await import("../storage");
    const r = await pool.query(`insert into age_review_reveal_nonces (nonce, expires_at) values ($1, $2) on conflict do nothing returning nonce`, [nonce, new Date(expiresAtMs)]);
    return (r.rowCount ?? 0) > 0;
  },
};
let store: NonceStore = dbStore;
/** Test hook: an in-memory store, or null to go back to the database. */
export function setNonceStoreForTests(s: NonceStore | null): void { store = s ?? dbStore; }

function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const k = parseEvidenceKey(env);
  if (!k) throw new Error(EVIDENCE_KEY_MISSING);
  return Buffer.from(crypto.hkdfSync("sha256", k, Buffer.alloc(0), TOKEN_INFO, 32));
}
const sign = (body: string) => crypto.createHmac("sha256", tokenKey()).update(body).digest("base64url");

export function issueRevealToken(c: RevealClaims, now: number = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...c, exp: now + REVEAL_TOKEN_TTL_SEC * 1000, nonce: crypto.randomBytes(16).toString("hex") }), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Throws TOKEN_INVALID unless signature, expiry, admin and ids all match; a valid token is consumed on first use ("no row inserted" = replay). */
export async function consumeRevealToken(token: unknown, expect: RevealClaims, now: number = Date.now()): Promise<void> {
  const bad = () => new AgeReviewError(403, "TOKEN_INVALID", "This link is no longer valid.");
  if (typeof token !== "string" || token.length > 1024) throw bad();
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) throw bad();
  const want = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw bad();
  let p: { adminId?: unknown; requestId?: unknown; evidenceId?: unknown; exp?: unknown; nonce?: unknown };
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw bad(); }
  if (typeof p.exp !== "number" || p.exp <= now || typeof p.nonce !== "string") throw bad();
  if (p.adminId !== expect.adminId || p.requestId !== expect.requestId || p.evidenceId !== expect.evidenceId) throw bad();
  if (!(await store.claim(p.nonce, p.exp))) throw bad();
}

/** Pure: the limit check. */
export function revealLimitReached(revealsLastHour: number): boolean {
  return revealsLastHour >= REVEAL_LIMIT_PER_HOUR;
}

type Tx = { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * Counts this reviewer's reveals in the last hour and records the new one in ONE transaction under a per-reviewer advisory lock,
 * so 60 parallel requests cannot all pass the count. The audit row is the record the count reads. Returns false at the limit.
 */
export async function claimReveal(db: { connect: () => Promise<Tx & { release: () => void }> }, a: { adminId: string; requestId: string; kind: string; ip?: string }): Promise<boolean> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`age-review-reveal:${a.adminId}`]);
    const n = Number((await c.query(`select count(*)::int as n from admin_activity_logs where admin_id = $1 and action = 'age_review.reveal' and created_at > now() - interval '1 hour'`, [a.adminId])).rows[0].n);
    if (revealLimitReached(n)) { await c.query("rollback"); return false; }
    const details = `request=${a.requestId} kind=${a.kind}`;
    await c.query(
      `insert into admin_activity_logs (admin_id, action, target_type, target_id, details, reason, ip_address) values ($1, 'age_review.reveal', 'age_review_request', $2, $3, $3, $4)`,
      [a.adminId, a.requestId, details, a.ip ?? null],
    );
    await c.query("commit");
    return true;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally { c.release(); }
}

/** Headers for an evidence image. null when the stored type is not one of the three allowed image types. */
export function evidenceHeaders(mime: string): Record<string, string> | null {
  if (!(EVIDENCE_MIMES as readonly string[]).includes(mime)) return null;
  return {
    "Content-Type": mime,
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": 'inline; filename="evidence"',
    "Content-Security-Policy": "sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

type Resp = { status: (c: number) => Resp; setHeader: (k: string, v: string) => unknown; removeHeader: (k: string) => unknown; end: (b?: Buffer) => unknown; json: (b: unknown) => unknown };

/** Decrypts with the row-bound AAD and writes the image. Any failure sends nothing from the row. */
export function sendEvidence(res: Resp, row: { id: string; request_id: string; kind: string; mime: string; bytes_enc: Buffer }): void {
  const headers = evidenceHeaders(row.mime);
  if (!headers) { res.status(500).json({ message: "Evidence unavailable", code: "EVIDENCE_UNAVAILABLE" }); return; }
  let plain: Buffer;
  try { plain = decryptEvidence(row.bytes_enc, `${row.request_id}:${row.kind}`); }
  catch { console.error("[AGE-REVIEW] ALERT evidence could not be decrypted"); res.status(500).json({ message: "Evidence unavailable", code: "EVIDENCE_UNAVAILABLE" }); return; }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.removeHeader("ETag"); res.removeHeader("Last-Modified");
  res.status(200).end(plain);
}
