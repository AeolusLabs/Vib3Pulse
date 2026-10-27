// Changing or removing a person's verified name must also stop an account that was name-checked against the old one. Every such
// change takes the same per-user lock the bank-account link takes (LOCK_ACCOUNT_CHANGE), so it cannot interleave with a link,
// and clears the account's match in the same transaction. The account stays linked but is unpayable until relinked and re-checked.
import { AgeReviewError } from "./ageReviewService";
import { deleteVerifiedName, getVerifiedLegalName, normaliseLegalName, setVerifiedName } from "./verifiedName";

/** Advisory lock namespace for a payout account change (refunds.ts 41001 / 41002, spray.ts 41003). Key: the user id. */
export const LOCK_ACCOUNT_CHANGE = 41004;

type Tx = { query: (q: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Waits up to 8 s for a link in progress, then BUSY (409). Must be called inside an open transaction. */
export async function lockAccountChange(c: Tx, userId: string): Promise<void> {
  await c.query(`set local lock_timeout = '8s'`);
  try {
    await c.query(`select pg_advisory_xact_lock($1::int, hashtext($2::text))`, [LOCK_ACCOUNT_CHANGE, userId]);
  } catch (e) {
    if ((e as { code?: string })?.code === "55P03") throw new AgeReviewError(409, "BUSY", "Their bank account is being saved right now. Try again in a moment.");
    throw e;
  }
  await c.query(`set local lock_timeout = 0`);
}

/** Unpayable until relinked and name-checked again (PAYABLE_ACCOUNT_SQL needs both columns). */
async function clearMatch(c: Tx, userId: string): Promise<void> {
  await c.query(
    `update organizer_payment_accounts set room_verified_subaccount_code = null, name_matched_at = null
      where user_id = $1 and provider = 'paystack' and (room_verified_subaccount_code is not null or name_matched_at is not null)`,
    [userId],
  );
}

/** Inside the caller's transaction: lock, delete the name, clear the match. */
export async function clearNameAndMatchTx(c: Tx, userId: string): Promise<void> {
  await lockAccountChange(c, userId);
  await deleteVerifiedName(userId, c);
  await clearMatch(c, userId);
}

/** Support: its own transaction. The account stays linked but cannot be paid until the host relinks it and is name-checked again. */
export async function resetPayoutMatch(userId: string): Promise<void> {
  const { pool } = await import("../storage");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockAccountChange(client, userId);
    await clearMatch(client, userId);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** Its own transaction. */
export async function clearNameAndMatch(userId: string): Promise<void> {
  const { pool } = await import("../storage");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await clearNameAndMatchTx(client, userId);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * Inside the caller's transaction: store the name; if it replaces a DIFFERENT name (or none; case ignored) the match is cleared so the account must be
 * relinked against the new name. Storing the same normalised name again leaves the match alone.
 */
export async function storeNameTx(c: Tx, userId: string, name: string, requestId: string | null, adminId: string | null): Promise<void> {
  await lockAccountChange(c, userId);
  const clean = normaliseLegalName(name);
  if (!clean) throw new Error("storeNameTx: not a usable name");
  const existing = await getVerifiedLegalName(userId, c);
  await setVerifiedName(c, userId, clean, requestId, adminId);
  // Case and spacing do not make a different person: the bank-name check (namesMatch) ignores them too.
  if (existing === null || existing.toLowerCase() !== clean.toLowerCase()) await clearMatch(c, userId);
}
