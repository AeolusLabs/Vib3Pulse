// Network for the room money screens (phase 6, tasks 6.1 to 6.3). Reads only, plus the one payout account save.
// The client never sends an amount, a user id or a range it made up: the earnings range is one of three words and every
// route answers for the signed-in user only (the server takes the user from the session, never from here).
// Calls go through sprayCall (lib/sprayApi.ts): no-store, a hard time limit, the CSRF retry on the POST, and the status,
// code and Retry-After kept so the screens word every refusal themselves. Bodies are parsed by earningsUi.ts.
import { sprayCall } from "@/lib/sprayApi";
import {
  parseBanks, parseEarnings, parsePaymentsPage, parsePayoutStatus, cleanAccountNumber,
  type Bank, type Earnings, type EarningsRange, type PaymentsPage, type PayoutStatus,
} from "@/components/rooms/earnings/earningsUi";

/** A read that worked and parsed, or why not. A body of the wrong shape is a failure (status 500), never drawn. */
export type Read<T> = { ok: true; data: T } | { ok: false; status: number; code?: string; retryAfterSec?: number };

async function read<T>(url: string, parse: (b: unknown) => T | null): Promise<Read<T>> {
  const r = await sprayCall<unknown>("GET", url);
  if (!r.ok) return { ok: false, status: r.status, ...(r.code ? { code: r.code } : {}), ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) };
  const data = parse(r.body);
  return data === null ? { ok: false, status: 500, code: "BAD_BODY" } : { ok: true, data };
}

export const payoutStatusKey = ["/api/rooms/payouts/status"] as const;
export const banksKey = ["/api/rooms/payouts/banks"] as const;
export const earningsKey = (range: EarningsRange) => ["/api/users/me/room-earnings", range] as const;
export const paymentsKey = ["/api/users/me/room-payments"] as const;

export const fetchPayoutStatus = () => read<PayoutStatus>("/api/rooms/payouts/status", parsePayoutStatus);
export const fetchBanks = () => read<Bank[]>("/api/rooms/payouts/banks", parseBanks);
export const fetchEarnings = (range: EarningsRange) =>
  read<Earnings>(`/api/users/me/room-earnings?range=${encodeURIComponent(range)}`, parseEarnings);
export const fetchPayments = (cursor: string | null) =>
  read<PaymentsPage>(`/api/users/me/room-payments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, parsePaymentsPage);

/**
 * POST /api/rooms/payouts/account `{ bankCode, accountNumber }`. The number is sent once and never kept anywhere on the
 * client after this call. A longer time limit than the default: the server asks Paystack twice (resolve, subaccount).
 */
export const saveAccountTimeoutMs = 30_000;
export const savePayoutAccount = (bankCode: string, accountNumber: string) =>
  sprayCall<unknown>("POST", "/api/rooms/payouts/account", { bankCode, accountNumber: cleanAccountNumber(accountNumber) }, saveAccountTimeoutMs);
