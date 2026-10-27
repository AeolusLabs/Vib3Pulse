// Rooms phase 6, task 6.1: the host's payout account for rooms (tickets and sprays).
//
// SECURITY RULES (read before changing anything here)
//  1. payableSubaccountOf(userId) is the ONE source for "this person can be paid" (fix round C1). It returns the Paystack
//     subaccount code ONLY when the account was name-checked through rooms and is still that same subaccount:
//     payouts_enabled, details_submitted, a code, room_verified_subaccount_code = paystack_subaccount_code and
//     name_matched_at set (PAYABLE_ACCOUNT_SQL). hostPayoutReady (canSellTickets' input, hostCanSellNow), the spray gate
//     (spray.ts subaccountOf) and the payout recipient (settlement.ts payQueued, same SQL) all read it. An organiser
//     onboarding writes a new code that is NOT verified, so it can never be paid in rooms, and a queued room payout then
//     waits with NO_PAYOUT_ACCOUNT instead of going to the new account.
//  2. The account lookup is an oracle on third parties' bank details. Linking an account therefore needs: signed in, an
//     ID-verified adult, a verified legal name on file, at most ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR bank lookups per user per
//     hour (counted in the database and shared with the organiser resolve / onboard routes, so it holds across server
//     instances and both doors), plus a per-IP limit on the route. The bank's account name is NEVER returned or logged
//     here: the answer is only whether it matches. "Not found" and "not your name" are ONE answer (NAME_MISMATCH).
//  3. Name match is strict (shared/roomEarnings.ts namesMatch). The verified legal name is the one an age reviewer recorded,
//     encrypted, when the person asked to receive money (server/identity/verifiedName.ts). Without one, linking refuses with
//     NO_VERIFIED_NAME before any lookup.
//  4. In-flight transfers are never redirected, and no transaction is held open across a Paystack call (fix round I3):
//      - the change runs under a SESSION advisory lock (LOCK_ACCOUNT_CHANGE, user id) with no transaction open;
//      - settlement takes the SHARED transaction lock on the same key before it moves a payout held -> queued or an admin
//        requeues failed -> queued, and skips (stays held / answers busy) while a change holds it;
//      - under the lock: 409 PAYOUT_IN_FLIGHT if any payout of the host is queued (none can become queued meanwhile);
//      - before an update, the row's verification is cleared (the account is not payable while Paystack is being changed:
//        fail closed). It is restored when Paystack clearly refused; on an unclear answer it stays cleared and the person
//        retries. The new verification is written in one short statement right after Paystack answered;
//      - every Paystack call has a 15 second timeout (paystack.ts).
//  5. Idempotent: a second call updates the existing subaccount (same code) instead of creating another.
//  6. Every lookup attempt and every outcome after it writes a room_payout_account_events row (the audit log) and one log
//     line with the user id and the outcome code only. Refusals decided before any lookup (no verified name, a payout in
//     flight, an unknown bank) are logged but not written, so the table only grows with the rate-limited attempts.
import { pool, storage } from "../storage";
import type { User } from "@shared/schema";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import {
  ACCOUNT_NUMBER_RE, BANK_CODE_RE, last4Of, namesMatch,
  type PayoutAccountCode, type RoomPayoutAccountResult, type RoomPayoutStatus,
} from "@shared/roomEarnings";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import {
  createPaystackSubaccountChecked, isPaystackOutage, listPaystackBanksChecked, resolvePaystackBankAccountChecked, updatePaystackSubaccount,
  type PaystackBank,
} from "../payments/paystack";
import { BUSY, LOCK_PAYOUT, withAdvisoryLock } from "./refunds";
import { getVerifiedLegalName, hasVerifiedName, sealHolderName } from "../identity/verifiedName";
import { LOCK_ACCOUNT_CHANGE } from "../identity/payoutNameGuard";

export const ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;
const lockKey = (userId: string) => `room-payout-acct:${userId}`;
const testing = () => process.env.NODE_ENV !== "production";

/** Advisory lock namespace for a payout account change (refunds.ts 41001 / 41002, spray.ts 41003). Key: the user id. Shared with the verified-name changes. */
export { LOCK_ACCOUNT_CHANGE };

// ---------------------------------------------------------------- the single "can be paid" helper

/** SQL predicate on organizer_payment_accounts (no alias): a rooms-payable, name-checked account. */
export const PAYABLE_ACCOUNT_SQL = `provider = 'paystack' and payouts_enabled = true and details_submitted = true
  and paystack_subaccount_code is not null and room_verified_subaccount_code = paystack_subaccount_code
  and name_matched_at is not null`;

type Q = { query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** The Paystack subaccount rooms may pay this person through, or null (rule 1). Never reads bank details. */
export async function payableSubaccountOf(userId: string, q: Q = pool): Promise<string | null> {
  const row = (await q.query(
    `select paystack_subaccount_code from organizer_payment_accounts where user_id = $1 and ${PAYABLE_ACCOUNT_SQL} limit 1`,
    [userId],
  )).rows[0] as { paystack_subaccount_code: string } | undefined;
  return row?.paystack_subaccount_code ?? null;
}

/** The person can be paid in rooms (a name-checked payable account). */
export async function hostPayoutReady(userId: string): Promise<boolean> {
  return (await payableSubaccountOf(userId)) !== null;
}

// ---------------------------------------------------------------- provider seam (tests replace it; refused in production)

export interface PayoutProvider {
  listBanks(): Promise<PaystackBank[]>;
  resolve(accountNumber: string, bankCode: string): Promise<{ accountNumber: string; accountName: string }>;
  createSubaccount(p: { businessName: string; bankCode: string; accountNumber: string; percentageCharge: number }): Promise<{ subaccountCode: string }>;
  updateSubaccount(code: string, p: { bankCode: string; accountNumber: string }): Promise<void>;
}
const realProvider: PayoutProvider = {
  listBanks: () => listPaystackBanksChecked(),
  resolve: (n, b) => resolvePaystackBankAccountChecked(n, b),
  createSubaccount: (p) => createPaystackSubaccountChecked(p),
  updateSubaccount: (code, p) => updatePaystackSubaccount(code, p),
};
let testProvider: Partial<PayoutProvider> | null = null;
export function setPayoutProviderForTests(p: Partial<PayoutProvider> | null): void {
  if (p && process.env.NODE_ENV === "production") throw new Error("setPayoutProviderForTests is not allowed in production");
  testProvider = p;
  bankCache = null;
}
const provider = (): PayoutProvider => ({ ...realProvider, ...(testProvider ?? {}) });

/** Test-only (ignored in production): the verified legal name a test user has. */
export const payoutTestHooks: { verifiedName?: (userId: string) => string | null } = {};

/**
 * The person's verified legal name: the encrypted name an age reviewer recorded when they asked to receive money
 * (server/identity/verifiedName.ts). null when none is stored. Tests may stand in for it with payoutTestHooks.verifiedName.
 */
export async function verifiedLegalNameOf(userId: string): Promise<string | null> {
  if (testing() && payoutTestHooks.verifiedName) return payoutTestHooks.verifiedName(userId);
  return getVerifiedLegalName(userId);
}

async function hasVerifiedNameFor(userId: string): Promise<boolean> {
  if (testing() && payoutTestHooks.verifiedName) return payoutTestHooks.verifiedName(userId) !== null;
  return hasVerifiedName(userId);
}

/** "Paystack unavailable: ..." (or any error that is not a Paystack refusal) is an outage. */
const isOutage = (e: unknown) => isPaystackOutage(e) || !(e instanceof Error && e.message.startsWith("Paystack error"));

let bankCache: { at: number; banks: PaystackBank[] } | null = null;
/** Paystack's Nigerian bank list, cached for an hour (never an empty list: that is retried). Throws on an outage. */
export async function payoutBanks(): Promise<PaystackBank[]> {
  if (bankCache && Date.now() - bankCache.at < HOUR_MS) return bankCache.banks;
  const banks = (await provider().listBanks()).filter((b) => BANK_CODE_RE.test(b.code) && b.name.length > 0);
  if (banks.length > 0) bankCache = { at: Date.now(), banks };
  return banks;
}

// ---------------------------------------------------------------- GET /api/rooms/payouts/status

/** Can this person link a bank account through rooms? Any verified adult: without a name on file the account waits for its name check. */
export async function canLinkAccountFor(user: User | undefined | null): Promise<boolean> {
  return !!user && !user.deletedAt && isIdVerifiedAdult(user);
}

export async function payoutStatusFor(userId: string): Promise<RoomPayoutStatus> {
  const [user, acct] = await Promise.all([storage.getUser(userId), storage.getOrganizerPaymentAccount(userId, "paystack")]);
  const verifiedAdult = !!user && !user.deletedAt && isIdVerifiedAdult(user);
  // The same rule as payableSubaccountOf (rule 1), read from the row already loaded.
  const checked = !!acct && !!acct.paystackSubaccountCode && !!acct.nameMatchedAt && acct.roomVerifiedSubaccountCode === acct.paystackSubaccountCode;
  const subaccountReady = !!acct && checked && acct.payoutsEnabled === true && acct.detailsSubmitted === true;
  // Shown only when it is the name-checked account rooms saved AND still the row's subaccount. Otherwise null.
  let account: RoomPayoutStatus["account"] = null;
  const last4 = acct?.accountLast4 ?? "";
  // An account saved before the ID name existed carries the bank's holder name until it is compared: shown as not matched yet.
  const waiting = !!acct && !checked && !!acct.paystackSubaccountCode
    && (((await pool.query(`select 1 from organizer_payment_accounts where user_id = $1 and provider = 'paystack' and holder_name_enc is not null`, [userId])).rowCount ?? 0) > 0);
  if (acct && (checked || waiting) && /^\d{4}$/.test(last4) && acct.bankName) {
    account = { bankName: acct.bankName, last4, nameMatches: checked };
  }
  const hasName = await hasVerifiedNameFor(userId);
  return { verifiedAdult, account, subaccountReady, canLinkAccount: await canLinkAccountFor(user), hasVerifiedName: hasName, awaitingName: waiting && !hasName };
}

// ---------------------------------------------------------------- POST /api/rooms/payouts/account

export interface PayoutAccountOutcome {
  status: number;
  body: RoomPayoutAccountResult | { code: PayoutAccountCode; message: string };
  retryAfterSec?: number;
}

const MESSAGES: Record<PayoutAccountCode, string> = {
  NOT_VERIFIED: "Verify your ID first. Only ID-verified adults can get paid in rooms.",
  BAD_INPUT: "Enter your 10 digit account number and choose your bank.",
  BAD_BANK: "Choose your bank from the list.",
  NO_VERIFIED_NAME: "To add a bank account we need to check your name on your ID. Start a payouts check from this page.",
  NAME_MISMATCH: "This account is not in your verified name, or the number and bank do not match. Use an account in your own name.",
  PAYOUT_IN_FLIGHT: "A payout to your current account is being sent. You can change your account once it lands.",
  BUSY: "Your account is already being saved. Try again in a minute.",
  RATE_LIMITED: "Too many tries. Please wait an hour and try again.",
  PROVIDER_UNAVAILABLE: "We could not reach the bank check right now. Try again in a few minutes.",
  SERVER_ERROR: "That did not work. Try again.",
};
const STATUS: Record<PayoutAccountCode, number> = {
  NOT_VERIFIED: 403, BAD_INPUT: 400, BAD_BANK: 400, NO_VERIFIED_NAME: 422, NAME_MISMATCH: 422, PAYOUT_IN_FLIGHT: 409, BUSY: 409,
  RATE_LIMITED: 429, PROVIDER_UNAVAILABLE: 503, SERVER_ERROR: 500,
};
const refuse = (code: PayoutAccountCode, retryAfterSec?: number): PayoutAccountOutcome =>
  ({ status: STATUS[code], body: { code, message: MESSAGES[code] }, ...(retryAfterSec ? { retryAfterSec } : {}) });

/** User id and outcome only. */
function logAccount(userId: string, outcome: string): void {
  console.log(`[rooms:payouts] user=${userId} account_change outcome=${outcome}`);
}

async function audit(q: Q, userId: string, action: "attempt" | "account_set" | "account_refused", outcome: string, bankCode: string | null, last4: string | null): Promise<void> {
  await q.query(
    `insert into room_payout_account_events (user_id, action, outcome, bank_code, account_last4) values ($1, $2, $3, $4, $5)`,
    [userId, action, outcome.slice(0, 40), bankCode, last4],
  );
}
/** Audit outside a transaction; a failure is logged, never thrown (the outcome stands). */
const auditQuiet = (userId: string, action: "attempt" | "account_set" | "account_refused", outcome: string, bankCode: string | null, last4: string | null) =>
  audit(pool, userId, action, outcome, bankCode, last4).catch((e) => console.error(`[rooms:payouts] user=${userId} audit write failed:`, sanitizeMoneyError(e)));

/**
 * Any payout of this host Paystack may be sending right now. Review r3 N1 (b): a queued row whose note is NO_PAYOUT_ACCOUNT
 * is NOT in flight (payQueued set that note after Paystack said no transfer with its reference exists, and it verifies
 * again before it ever creates one), so it never blocks a change; it is paid to the new name-checked account afterwards.
 * Rows queued before the r3 fix can still carry that note; new ones are never queued unpayable (settlement N1 (a)).
 */
async function hasQueuedPayout(q: Q, userId: string): Promise<boolean> {
  return ((await q.query(
    `select 1 from room_payouts where host_id = $1 and status = 'queued' and coalesce(last_error, '') <> 'NO_PAYOUT_ACCOUNT' limit 1`,
    [userId],
  )).rowCount ?? 0) > 0;
}

/** Queued rows of this host that wait for a payable account (see hasQueuedPayout). */
async function waitingPayoutIds(q: Q, userId: string): Promise<string[]> {
  return ((await q.query(
    `select id from room_payouts where host_id = $1 and status = 'queued' and last_error = 'NO_PAYOUT_ACCOUNT' order by id`,
    [userId],
  )).rows as { id: string }[]).map((r) => r.id);
}

export type LookupSource = "rooms" | "organizer_resolve" | "organizer_onboard";

/**
 * One bank lookup against the per-user hourly limit (ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR, shared by the rooms page and the
 * organiser routes), durably and serialised per user (advisory transaction lock), and recorded as an 'attempt' row.
 * Returns the seconds to wait when the limit is reached (nothing recorded then), else 0.
 */
export async function takeBankLookupAttempt(
  userId: string, source: LookupSource, bankCode: string | null, last4: string | null, nowMs: number = Date.now(),
): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [lockKey(userId)]);
    const since = new Date(nowMs - HOUR_MS).toISOString();
    const r = (await c.query(
      `select count(*)::int as n, round(extract(epoch from min(created_at)) * 1000)::float8 as oldest_ms
         from room_payout_account_events where user_id = $1 and action = 'attempt' and created_at > $2::timestamp`,
      [userId, since],
    )).rows[0] as { n: number; oldest_ms: number | null };
    if (Number(r.n) >= ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR) {
      await c.query("ROLLBACK");
      const oldest = r.oldest_ms === null ? nowMs : Number(r.oldest_ms);
      return Math.max(1, Math.ceil((oldest + HOUR_MS - nowMs) / 1000));
    }
    await c.query(
      `insert into room_payout_account_events (user_id, action, outcome, bank_code, account_last4, created_at) values ($1, 'attempt', $2, $3, $4, $5::timestamp)`,
      [userId, source === "rooms" ? "started" : source, bankCode, last4, new Date(nowMs).toISOString()],
    );
    await c.query("COMMIT");
    return 0;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** "ADEBAYO OKAFOR" -> "A***** O*****": what the organiser onboarding answer shows instead of the bank's name (fix round I1). */
export function maskAccountName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 6)
    .map((w) => `${w.charAt(0).toUpperCase()}${"*".repeat(Math.min(Math.max(w.length - 1, 1), 8))}`).join(" ");
}

const ACCOUNT_SQL = `select paystack_subaccount_code, room_verified_subaccount_code,
    round(extract(epoch from name_matched_at) * 1000)::float8 as matched_ms
  from organizer_payment_accounts where user_id = $1 and provider = 'paystack'`;

/**
 * Connect (or change) the payout account rooms pay into. See the rules at the top. The account number never leaves this
 * function except to Paystack; the answer carries the last four digits only.
 */
export async function setPayoutAccount(userId: string, body: unknown, nowMs: number = Date.now()): Promise<PayoutAccountOutcome> {
  const user = await storage.getUser(userId);
  if (!user || user.deletedAt || !isIdVerifiedAdult(user)) return refuse("NOT_VERIFIED");

  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const bankCode = typeof b.bankCode === "string" ? b.bankCode.trim() : "";
  const accountNumber = typeof b.accountNumber === "string" ? b.accountNumber.replace(/\s+/g, "") : "";
  if (!BANK_CODE_RE.test(bankCode) || !ACCOUNT_NUMBER_RE.test(accountNumber)) return refuse("BAD_INPUT");
  const last4 = last4Of(accountNumber);

  // Before any lookup: nothing to compare against means no lookup at all (no oracle, no attempt spent, no row written).
  // No name yet is allowed: the account is saved as "waiting for its name check" and becomes payable when the reviewer records the name.
  const verifiedName = await verifiedLegalNameOf(userId);
  // Cheap early answer (re-checked under the lock below).
  if (await hasQueuedPayout(pool, userId)) { logAccount(userId, "PAYOUT_IN_FLIGHT"); return refuse("PAYOUT_IN_FLIGHT"); }

  // The bank is checked against the public list BEFORE an attempt is spent (review r1 m3).
  let bank: PaystackBank | undefined;
  try { bank = (await payoutBanks()).find((x) => x.code === bankCode); }
  catch { logAccount(userId, "PROVIDER_UNAVAILABLE:banks"); return refuse("PROVIDER_UNAVAILABLE"); }
  if (!bank) { logAccount(userId, "BAD_BANK"); return refuse("BAD_BANK"); }

  const wait = await takeBankLookupAttempt(userId, "rooms", bankCode, last4, nowMs);
  if (wait > 0) { logAccount(userId, "RATE_LIMITED"); return refuse("RATE_LIMITED", wait); }

  let resolvedName: string;
  try {
    const r = await provider().resolve(accountNumber, bankCode);
    // A different number back than we asked about is not this account.
    resolvedName = r.accountNumber === accountNumber ? r.accountName : "";
  } catch (e) {
    if (isOutage(e)) { logAccount(userId, "PROVIDER_UNAVAILABLE:resolve"); return refuse("PROVIDER_UNAVAILABLE"); }
    resolvedName = ""; // Paystack could not resolve it: the same answer as a name that does not match
  }
  const holderName = resolvedName;
  const matches = verifiedName ? namesMatch(verifiedName, resolvedName) : holderName.trim().length > 0; // no name yet: the bank must at least know the account
  resolvedName = ""; // not kept a moment longer than needed
  if (!matches) {
    logAccount(userId, "NAME_MISMATCH");
    await auditQuiet(userId, "account_refused", "NAME_MISMATCH", bankCode, last4);
    return refuse("NAME_MISMATCH");
  }

  const commissionBps = await storage.getPlatformCommissionBps();
  const bankName = bank.name.slice(0, 200);
  const out = await withAdvisoryLock(LOCK_ACCOUNT_CHANGE, userId, (c) => changeLocked(c, {
    userId, verifiedName, holderName: verifiedName ? "" : holderName, bankCode, accountNumber, last4, bankName, commissionBps, nowMs,
  }), 8000);
  // Review r3 m3: lock contention (a double submit, or a save already talking to Paystack) is "busy", never "a payout is
  // being sent".
  if (out === BUSY) { logAccount(userId, "BUSY"); return refuse("BUSY"); }
  return out;
}

interface ChangeInput {
  userId: string; verifiedName: string | null; /** the bank's holder name, kept (encrypted) only when verifiedName is null */ holderName: string; bankCode: string; accountNumber: string; last4: string; bankName: string; commissionBps: number; nowMs: number;
}

/** Under the session lock (rule 4), with NO transaction open around the provider call. */
async function changeLocked(c: Q, i: ChangeInput): Promise<PayoutAccountOutcome> {
  const { userId, bankCode, last4 } = i;
  // The name and the verification were read before the Paystack round trip. Under the lock nothing can change them any more
  // (they are changed under this same lock), so read them again: whatever vanished meanwhile stops the link here.
  const nowUser = await storage.getUser(userId);
  if (!nowUser || nowUser.deletedAt || !isIdVerifiedAdult(nowUser)) { logAccount(userId, "NOT_VERIFIED"); return refuse("NOT_VERIFIED"); }
  const nameNow = await verifiedLegalNameOf(userId);
  if (nameNow !== i.verifiedName) { logAccount(userId, "BUSY:name_changed"); return refuse("BUSY"); }
  // No payout can become queued while we hold the lock (settlement takes the shared lock to queue), so this answer holds.
  if (await hasQueuedPayout(c, userId)) {
    logAccount(userId, "PAYOUT_IN_FLIGHT");
    await auditQuiet(userId, "account_refused", "PAYOUT_IN_FLIGHT", bankCode, last4);
    return refuse("PAYOUT_IN_FLIGHT");
  }
  // Review r3 N1: a payout waiting for an account (queued, NO_PAYOUT_ACCOUNT) is held still for the whole change: its
  // payout lock (the one payQueued runs under) is taken here and kept until the change is done, so no pass can start its
  // transfer while the subaccount is being pointed at the new bank. Busy = payQueued is on it right now: try again.
  const waiting = await waitingPayoutIds(c, userId);
  const held: string[] = [];
  try {
    for (const id of waiting) {
      const got = (await c.query("select pg_try_advisory_lock($1::int, hashtext($2::text)) as ok", [LOCK_PAYOUT, id])).rows[0] as { ok: boolean } | undefined;
      if (got?.ok !== true) { logAccount(userId, "BUSY:payout"); return refuse("BUSY"); }
      held.push(id);
    }
    return await changeWithPayoutsHeld(c, i);
  } finally {
    for (const id of held) {
      await c.query("select pg_advisory_unlock($1::int, hashtext($2::text))", [LOCK_PAYOUT, id]).catch(() => {});
    }
  }
}

async function changeWithPayoutsHeld(c: Q, i: ChangeInput): Promise<PayoutAccountOutcome> {
  const { userId, bankCode, last4 } = i;
  const existing = (await c.query(ACCOUNT_SQL, [userId])).rows[0] as
    { paystack_subaccount_code: string | null; room_verified_subaccount_code: string | null; matched_ms: number | null } | undefined;

  let code = existing?.paystack_subaccount_code ?? "";
  const updating = !!code;
  if (updating) {
    // Fail closed while Paystack is being changed: the account is not payable until the new verification is written.
    await c.query(
      `update organizer_payment_accounts set room_verified_subaccount_code = null, name_matched_at = null where user_id = $1 and provider = 'paystack'`,
      [userId],
    );
  }
  try {
    if (updating) await provider().updateSubaccount(code, { bankCode, accountNumber: i.accountNumber });
    else code = (await provider().createSubaccount({ businessName: i.verifiedName ?? i.holderName, bankCode, accountNumber: i.accountNumber, percentageCharge: i.commissionBps / 100 })).subaccountCode;
  } catch (e) {
    const outage = isOutage(e);
    if (updating && !outage && existing?.room_verified_subaccount_code && existing.matched_ms !== null) {
      // Paystack clearly refused: nothing changed there, so the old verification stands again.
      await c.query(
        `update organizer_payment_accounts set room_verified_subaccount_code = $2, name_matched_at = $3::timestamp
          where user_id = $1 and provider = 'paystack' and paystack_subaccount_code = $2`,
        [userId, existing.room_verified_subaccount_code, new Date(Number(existing.matched_ms)).toISOString()],
      ).catch((err) => console.error(`[rooms:payouts] user=${userId} restoring the verification failed:`, sanitizeMoneyError(err)));
    }
    logAccount(userId, `PROVIDER_REFUSED_SUBACCOUNT:${outage ? "outage" : "refusal"}`);
    await auditQuiet(userId, "account_refused", "PROVIDER_UNAVAILABLE", bankCode, last4);
    return refuse("PROVIDER_UNAVAILABLE");
  }

  // One short autocommit statement straight after Paystack answered (review r1 m4): the code is never lost silently.
  const at = new Date(i.nowMs).toISOString();
  const waiting = i.verifiedName === null;
  try {
    await c.query(
      `insert into organizer_payment_accounts
         (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, bank_code, bank_name, account_last4,
          room_verified_subaccount_code, name_matched_at, holder_name_enc, updated_at)
       values ($1, 'paystack', $2, true, true, $3, $4, $5, case when $7::boolean then null else $2::varchar end, case when $7::boolean then null else $6::timestamp end, $8, $6::timestamp)
       on conflict (user_id, provider) do update set
         paystack_subaccount_code = excluded.paystack_subaccount_code, details_submitted = true, payouts_enabled = true,
         bank_code = excluded.bank_code, bank_name = excluded.bank_name, account_last4 = excluded.account_last4,
         room_verified_subaccount_code = excluded.room_verified_subaccount_code, name_matched_at = excluded.name_matched_at,
         holder_name_enc = excluded.holder_name_enc, updated_at = excluded.updated_at`,
      [userId, code, bankCode, i.bankName, last4, at, waiting, waiting ? sealHolderName(i.holderName, userId) : null],
    );
  } catch (e) {
    // Paystack has the new account but our row does not. The account stays unpayable (fail closed); the code is in this
    // alert so a person can attach it (a subaccount code is not a secret).
    console.error(`[rooms:payouts] ALERT user=${userId} subaccount ${updating ? "updated" : "created"} at Paystack (code ${code}) but saving it failed:`, sanitizeMoneyError(e));
    return refuse("SERVER_ERROR");
  }
  await auditQuiet(userId, "account_set", updating ? "updated" : "created", bankCode, last4);
  logAccount(userId, updating ? "updated" : "created");
  return {
    status: 200,
    body: waiting
      ? { account: { bankName: i.bankName, last4, nameMatches: false }, subaccountReady: false, updated: updating, awaitingName: true }
      : { account: { bankName: i.bankName, last4, nameMatches: true }, subaccountReady: true, updated: updating },
  };
}
