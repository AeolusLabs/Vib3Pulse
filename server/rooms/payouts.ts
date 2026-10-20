// Rooms phase 6, task 6.1: the host's payout account for rooms (tickets and sprays).
//
// SECURITY RULES (read before changing anything here)
//  1. hostPayoutReady(userId) is the ONE source for "this person can be paid": canSellTickets' input (roomRoutes sellCheck),
//     hostCanSellNow (ticketStorage, through hasVerifiedPayoutAccount) and the spray gate (spray.ts) all read it. Behaviour
//     is identical to phase 4/5: a Paystack row with a subaccount code and payouts enabled.
//  2. The account lookup is an oracle on third parties' bank details. Linking an account therefore needs: signed in, an
//     ID-verified adult, a verified legal name on file, at most ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR attempts per user per hour
//     (counted in the database, so it holds across server instances), plus a per-IP limit on the route. The bank's account
//     name is NEVER returned or logged: the answer is only whether it matches. "Not found" and "not your name" are ONE answer
//     (NAME_MISMATCH), so the endpoint never says whether a number exists.
//  3. Name match is strict (shared/roomEarnings.ts namesMatch). No verified legal name is stored anywhere in the repo yet
//     (the ID provider is gate G2): verifiedLegalNameOf returns null and linking refuses with NO_VERIFIED_NAME, before any
//     lookup. Owner item.
//  4. In-flight transfers are never redirected. settlement.ts reads the subaccount from Paystack when it STARTS a transfer
//     (createTransferRecipient in payQueued), so changing the subaccount's bank while a payout is 'queued' would redirect it.
//     We BLOCK the change while any payout of this host is queued (409 PAYOUT_IN_FLIGHT). The check runs in the same
//     transaction as the change, holding FOR UPDATE locks on the host's held / queued / failed payout rows, so no held
//     payout can be queued (queueDuePayout locks the row) and no failed payout requeued (its UPDATE waits) until the new
//     account is committed. A payout already handed to Paystack keeps the recipient it was created with.
//  5. Idempotent: a second call updates the existing subaccount (same code) instead of creating another.
//  6. Every attempt and every outcome writes a room_payout_account_events row (the audit log) and one log line with the user
//     id and the outcome code only. Never the account number, the account name, the bank's answer or an email.
import type { PoolClient } from "pg";
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

export const ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;
const lockKey = (userId: string) => `room-payout-acct:${userId}`;
const testing = () => process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------- the single "can be paid" helper

/**
 * The host (or stage guest) can be paid: a Paystack row in organizer_payment_accounts with a subaccount code and payouts
 * enabled. Never reads or returns bank details. Same rule phase 4 (hasVerifiedPayoutAccount) and phase 5 used.
 */
export async function hostPayoutReady(userId: string): Promise<boolean> {
  const acct = await storage.getOrganizerPaymentAccount(userId, "paystack");
  return !!acct && acct.payoutsEnabled === true && !!acct.paystackSubaccountCode;
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
 * The person's verified legal name, from ID verification. The repo stores none today (users has only ageVerifiedAt /
 * ageVerifiedMethod; the ID provider is gate G2), so this is null for everyone and linking refuses NO_VERIFIED_NAME.
 * When the provider lands, read its stored legal name here (and only here).
 */
export function verifiedLegalNameOf(user: User): string | null {
  if (testing() && payoutTestHooks.verifiedName) return payoutTestHooks.verifiedName(user.id);
  return null;
}

/** "Paystack unavailable: ..." (or any error that is not a Paystack refusal) is an outage. */
const isOutage = (e: unknown) => isPaystackOutage(e) || !(e instanceof Error && e.message.startsWith("Paystack error"));

let bankCache: { at: number; banks: PaystackBank[] } | null = null;
/** Paystack's Nigerian bank list, cached for an hour. Throws on an outage. */
export async function payoutBanks(): Promise<PaystackBank[]> {
  if (bankCache && Date.now() - bankCache.at < HOUR_MS) return bankCache.banks;
  const banks = (await provider().listBanks()).filter((b) => BANK_CODE_RE.test(b.code) && b.name.length > 0);
  bankCache = { at: Date.now(), banks };
  return banks;
}

// ---------------------------------------------------------------- GET /api/rooms/payouts/status

export async function payoutStatusFor(userId: string): Promise<RoomPayoutStatus> {
  const [user, acct] = await Promise.all([storage.getUser(userId), storage.getOrganizerPaymentAccount(userId, "paystack")]);
  const verifiedAdult = !!user && !user.deletedAt && isIdVerifiedAdult(user);
  const subaccountReady = !!acct && acct.payoutsEnabled === true && !!acct.paystackSubaccountCode;
  // Shown only when it is the name-checked account rooms saved AND still the row's subaccount (an organiser re-onboarding
  // makes a new code). Otherwise null: the page asks for an account (organiser-made accounts were never name-checked).
  let account: RoomPayoutStatus["account"] = null;
  const last4 = acct?.accountLast4 ?? "";
  if (acct?.paystackSubaccountCode && acct.nameMatchedAt && acct.roomVerifiedSubaccountCode === acct.paystackSubaccountCode
    && /^\d{4}$/.test(last4) && acct.bankName) {
    account = { bankName: acct.bankName, last4, nameMatches: true };
  }
  return { verifiedAdult, account, subaccountReady };
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
  NO_VERIFIED_NAME: "We do not have your verified name yet, so we cannot check this account. Contact support to finish your ID check.",
  NAME_MISMATCH: "This account is not in your verified name, or the number and bank do not match. Use an account in your own name.",
  PAYOUT_IN_FLIGHT: "A payout to your current account is being sent. You can change your account once it lands.",
  RATE_LIMITED: "Too many tries. Please wait an hour and try again.",
  PROVIDER_UNAVAILABLE: "We could not reach the bank check right now. Try again in a few minutes.",
  SERVER_ERROR: "That did not work. Try again.",
};
const STATUS: Record<PayoutAccountCode, number> = {
  NOT_VERIFIED: 403, BAD_INPUT: 400, BAD_BANK: 400, NO_VERIFIED_NAME: 422, NAME_MISMATCH: 422, PAYOUT_IN_FLIGHT: 409,
  RATE_LIMITED: 429, PROVIDER_UNAVAILABLE: 503, SERVER_ERROR: 500,
};
const refuse = (code: PayoutAccountCode, retryAfterSec?: number): PayoutAccountOutcome =>
  ({ status: STATUS[code], body: { code, message: MESSAGES[code] }, ...(retryAfterSec ? { retryAfterSec } : {}) });

/** User id and outcome only. */
function logAccount(userId: string, outcome: string): void {
  console.log(`[rooms:payouts] user=${userId} account_change outcome=${outcome}`);
}

type Q = { query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
async function audit(q: Q, userId: string, action: "attempt" | "account_set" | "account_refused", outcome: string, bankCode: string | null, last4: string | null): Promise<void> {
  await q.query(
    `insert into room_payout_account_events (user_id, action, outcome, bank_code, account_last4) values ($1, $2, $3, $4, $5)`,
    [userId, action, outcome.slice(0, 40), bankCode, last4],
  );
}
/** Audit outside a transaction; a failure is logged, never thrown (the outcome stands). */
const auditQuiet = (userId: string, action: "attempt" | "account_set" | "account_refused", outcome: string, bankCode: string | null, last4: string | null) =>
  audit(pool, userId, action, outcome, bankCode, last4).catch((e) => console.error(`[rooms:payouts] user=${userId} audit write failed:`, sanitizeMoneyError(e)));

/** Any payout of this host Paystack may be sending right now. */
async function hasQueuedPayout(q: Q, userId: string): Promise<boolean> {
  return ((await q.query(`select 1 from room_payouts where host_id = $1 and status = 'queued' limit 1`, [userId])).rowCount ?? 0) > 0;
}

/**
 * Counts this attempt against the per-user hourly limit, durably and serialised per user (advisory transaction lock), and
 * records it. Returns the seconds to wait when the limit is reached (nothing recorded then), else 0.
 */
async function takeAttempt(userId: string, bankCode: string, last4: string, nowMs: number): Promise<number> {
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
      `insert into room_payout_account_events (user_id, action, outcome, bank_code, account_last4, created_at) values ($1, 'attempt', 'started', $2, $3, $4::timestamp)`,
      [userId, bankCode, last4, new Date(nowMs).toISOString()],
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

  // Before any lookup: nothing to compare against means no lookup at all (no oracle, no attempt spent).
  const verifiedName = verifiedLegalNameOf(user);
  if (!verifiedName) {
    logAccount(userId, "NO_VERIFIED_NAME");
    await auditQuiet(userId, "account_refused", "NO_VERIFIED_NAME", bankCode, last4);
    return refuse("NO_VERIFIED_NAME");
  }
  // Cheap early answer (re-checked under the locks below).
  if (await hasQueuedPayout(pool, userId)) {
    logAccount(userId, "PAYOUT_IN_FLIGHT");
    await auditQuiet(userId, "account_refused", "PAYOUT_IN_FLIGHT", bankCode, last4);
    return refuse("PAYOUT_IN_FLIGHT");
  }

  const wait = await takeAttempt(userId, bankCode, last4, nowMs);
  if (wait > 0) { logAccount(userId, "RATE_LIMITED"); return refuse("RATE_LIMITED", wait); }

  let bank: PaystackBank | undefined;
  try { bank = (await payoutBanks()).find((x) => x.code === bankCode); }
  catch { logAccount(userId, "PROVIDER_UNAVAILABLE:banks"); return refuse("PROVIDER_UNAVAILABLE"); }
  if (!bank) { await auditQuiet(userId, "account_refused", "BAD_BANK", bankCode, last4); return refuse("BAD_BANK"); }

  let resolvedName: string;
  try {
    const r = await provider().resolve(accountNumber, bankCode);
    // A different number back than we asked about is not this account.
    resolvedName = r.accountNumber === accountNumber ? r.accountName : "";
  } catch (e) {
    if (isOutage(e)) { logAccount(userId, "PROVIDER_UNAVAILABLE:resolve"); return refuse("PROVIDER_UNAVAILABLE"); }
    resolvedName = ""; // Paystack could not resolve it: the same answer as a name that does not match
  }
  const matches = namesMatch(verifiedName, resolvedName);
  resolvedName = ""; // not kept a moment longer than needed
  if (!matches) {
    logAccount(userId, "NAME_MISMATCH");
    await auditQuiet(userId, "account_refused", "NAME_MISMATCH", bankCode, last4);
    return refuse("NAME_MISMATCH");
  }

  const commissionBps = await storage.getPlatformCommissionBps();
  const c: PoolClient = await pool.connect();
  let updated = false;
  let providerChanged = false;
  try {
    await c.query("BEGIN");
    await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [lockKey(userId)]);
    // Rule 4: lock every payout of this host that could still move money, then refuse while one is being sent.
    const payouts = (await c.query(
      `select id, status from room_payouts where host_id = $1 and status in ('held', 'queued', 'failed') order by id for update`,
      [userId],
    )).rows as { id: string; status: string }[];
    if (payouts.some((p) => p.status === "queued")) {
      await c.query("ROLLBACK");
      logAccount(userId, "PAYOUT_IN_FLIGHT");
      await auditQuiet(userId, "account_refused", "PAYOUT_IN_FLIGHT", bankCode, last4);
      return refuse("PAYOUT_IN_FLIGHT");
    }
    const existing = (await c.query(
      `select paystack_subaccount_code from organizer_payment_accounts where user_id = $1 and provider = 'paystack' for update`,
      [userId],
    )).rows[0] as { paystack_subaccount_code: string | null } | undefined;

    let code = "";
    try {
      if (existing?.paystack_subaccount_code) {
        code = existing.paystack_subaccount_code;
        await provider().updateSubaccount(code, { bankCode, accountNumber });
        updated = true;
      } else {
        code = (await provider().createSubaccount({ businessName: verifiedName, bankCode, accountNumber, percentageCharge: commissionBps / 100 })).subaccountCode;
      }
      providerChanged = true;
    } catch (e) {
      await c.query("ROLLBACK");
      logAccount(userId, `PROVIDER_REFUSED_SUBACCOUNT:${isOutage(e) ? "outage" : "refusal"}`);
      await auditQuiet(userId, "account_refused", "PROVIDER_UNAVAILABLE", bankCode, last4);
      return refuse("PROVIDER_UNAVAILABLE");
    }

    await c.query(
      `insert into organizer_payment_accounts
         (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, bank_code, bank_name, account_last4,
          room_verified_subaccount_code, name_matched_at, updated_at)
       values ($1, 'paystack', $2, true, true, $3, $4, $5, $2, $6::timestamp, $6::timestamp)
       on conflict (user_id, provider) do update set
         paystack_subaccount_code = excluded.paystack_subaccount_code, details_submitted = true, payouts_enabled = true,
         bank_code = excluded.bank_code, bank_name = excluded.bank_name, account_last4 = excluded.account_last4,
         room_verified_subaccount_code = excluded.room_verified_subaccount_code, name_matched_at = excluded.name_matched_at,
         updated_at = excluded.updated_at`,
      [userId, code, bankCode, bank.name.slice(0, 200), last4, new Date(nowMs).toISOString()],
    );
    await audit(c, userId, "account_set", updated ? "updated" : "created", bankCode, last4);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    if (providerChanged) {
      // Paystack has the new account but our row does not say so. Payouts read the subaccount from Paystack, so money goes
      // to the new (name-checked) account; only our display is stale. The next call fixes it.
      console.error(`[rooms:payouts] ALERT user=${userId} subaccount ${updated ? "updated" : "created"} at Paystack but saving it failed:`, sanitizeMoneyError(e));
    } else {
      console.error(`[rooms:payouts] user=${userId} account change failed:`, sanitizeMoneyError(e));
    }
    return refuse("SERVER_ERROR");
  } finally {
    c.release();
  }
  logAccount(userId, updated ? "updated" : "created");
  return {
    status: 200,
    body: { account: { bankName: bank.name, last4, nameMatches: true }, subaccountReady: true, updated },
  };
}
