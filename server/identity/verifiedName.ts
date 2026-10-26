// The legal name a reviewer read off the ID of someone who chose to receive money. Stored encrypted (AAD name:<userId>), read only
// by the payout name check, never returned by a route and never written to a log, error, audit row or notification.
import { decryptEvidence, encryptEvidence } from "./evidenceCrypto";

type Db = { query: (q: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const nameAad = (userId: string) => `name:${userId}`;
const proposedAad = (requestId: string) => `proposed-name:${requestId}`;

/** 3..120 characters of letters (any script), spaces, hyphen, apostrophe and dot; whitespace collapsed. null when it is not a usable name. */
export function normaliseLegalName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (n.length < 3 || n.length > 120) return null;
  // Letters of the scripts our users write (Latin with accents, Greek, Cyrillic, Arabic, Hebrew, Indic, CJK), combining marks, and . ' ’ - between words.
  const ok = (ch: string) => {
    if (/[A-Za-z]/.test(ch)) return true;
    const c = ch.charCodeAt(0);
    return (c >= 0xc0 && c <= 0x2af && c !== 0xd7 && c !== 0xf7) || (c >= 0x300 && c <= 0x36f) || (c >= 0x370 && c <= 0x1fff) || (c >= 0x3040 && c <= 0x9fff);
  };
  const punct = (ch: string) => ch === " " || ch === "." || ch === "'" || ch === "’" || ch === "-";
  for (let i = 0; i < n.length; i++) if (!ok(n[i]) && !punct(n[i])) return null;
  return ok(n[0]) ? n : null;
}

async function getPool(): Promise<Db> { return (await import("../storage")).pool as unknown as Db; }

/** Upsert (idempotent). Pass the transaction client to store it inside the same transaction as the verification. */
export async function setVerifiedName(db: Db, userId: string, name: string, requestId: string | null, adminId: string | null): Promise<void> {
  const clean = normaliseLegalName(name);
  if (!clean) throw new Error("setVerifiedName: not a usable name");
  await db.query(
    `insert into user_verified_names (user_id, name_enc, request_id, set_by) values ($1, $2, $3, $4)
     on conflict (user_id) do update set name_enc = excluded.name_enc, request_id = excluded.request_id, set_by = excluded.set_by, created_at = now()`,
    [userId, encryptEvidence(Buffer.from(clean, "utf8"), nameAad(userId)), requestId, adminId],
  );
}

/** The name, or null when none is stored or it cannot be decrypted (that logs an ALERT without any personal data). */
export async function getVerifiedLegalName(userId: string, db?: Db): Promise<string | null> {
  const row = ((await (db ?? (await getPool())).query(`select name_enc from user_verified_names where user_id = $1`, [userId])).rows[0]) as { name_enc: Buffer } | undefined;
  if (!row) return null;
  try { return decryptEvidence(row.name_enc, nameAad(userId)).toString("utf8"); }
  catch { console.error("[AGE-REVIEW] ALERT a stored verified name could not be decrypted"); return null; }
}

/** True only if a stored name can actually be decrypted: an unreadable row counts as no name (and logs the ALERT), so the UI offers the verify-name step. */
export async function hasVerifiedName(userId: string, db?: Db): Promise<boolean> {
  return (await getVerifiedLegalName(userId, db)) !== null;
}

export async function deleteVerifiedName(userId: string, db?: Db): Promise<boolean> {
  const r = await (db ?? (await getPool())).query(`delete from user_verified_names where user_id = $1`, [userId]);
  return (r.rowCount ?? 0) > 0;
}

/** A name held on a birthdate-change request until the second approval; bound to the request, not the user. */
export function sealProposedName(name: string, requestId: string): Buffer {
  const clean = normaliseLegalName(name);
  if (!clean) throw new Error("sealProposedName: not a usable name");
  return encryptEvidence(Buffer.from(clean, "utf8"), proposedAad(requestId));
}

export function openProposedName(enc: Buffer, requestId: string): string {
  return decryptEvidence(enc, proposedAad(requestId)).toString("utf8");
}
