// Spraying (phase 5, task 5.5): the payer's limits, velocity, the one-in-flight rule and the new host receive cap.
// Every limit is read from the database each time, never from the client. The SQL that stores limits and spend lives in
// sprayStorage.ts (lane A); this file only decides. The reservation itself (advisory lock, daily sum, room spend, insert)
// runs in spray.ts, inside one per-payer critical section, so these counts cannot race each other for one payer.
import { db } from "../storage";
import type { User } from "@shared/schema";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import {
  DAILY_DEFAULT_KOBO, DAILY_VERIFIED_MAX_KOBO, ID_REQUIRED_ABOVE_KOBO, NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT, NEW_HOST_WINDOW_DAYS,
  ROOM_LIMIT_DEFAULT_KOBO, VELOCITY, isRoomLimitOption, type SprayStatus,
} from "@shared/spray";
import { MIN_CHARGE_KOBO } from "@shared/money";
import * as ss from "./sprayStorage";

const DAY_MS = 86_400_000;

/**
 * The payer's effective daily limit: their stored choice, else the default. Never above DAILY_VERIFIED_MAX_KOBO, and never
 * above the default for someone who is not an ID-verified adult (a stored higher value from before an un-verification
 * stops counting at once).
 */
export function effectiveDailyLimit(user: Pick<User, "ageVerifiedAt" | "dateOfBirth"> & { sprayDailyLimitKobo?: number | null }): number {
  const stored = user.sprayDailyLimitKobo;
  const chosen = typeof stored === "number" && Number.isSafeInteger(stored) && stored > 0 ? stored : DAILY_DEFAULT_KOBO;
  const cap = isIdVerifiedAdult(user) ? DAILY_VERIFIED_MAX_KOBO : DAILY_DEFAULT_KOBO;
  return Math.min(chosen, cap);
}

export type DailyLimitCheck = { ok: true } | { ok: false; status: 400 | 403; code: "BAD_REQUEST" | "ID_REQUIRED"; message: string };

/** May this person set their daily limit to `kobo`? Lowering is always allowed; raising above the default needs ID. */
export function checkDailyLimitChange(user: Pick<User, "ageVerifiedAt" | "dateOfBirth">, kobo: unknown): DailyLimitCheck {
  if (typeof kobo !== "number" || !Number.isSafeInteger(kobo) || kobo < MIN_CHARGE_KOBO || kobo > DAILY_VERIFIED_MAX_KOBO) {
    return { ok: false, status: 400, code: "BAD_REQUEST", message: "Choose a daily limit between 500 and 100,000 naira." };
  }
  if ((kobo > DAILY_DEFAULT_KOBO || kobo > ID_REQUIRED_ABOVE_KOBO) && !isIdVerifiedAdult(user)) {
    return { ok: false, status: 403, code: "ID_REQUIRED", message: "Verify your ID to raise your daily limit above 20,000 naira." };
  }
  return { ok: true };
}

export type RoomLimitCheck = DailyLimitCheck;

/** May this person set their room limit to `kobo`? Must be one of the options; above ID_REQUIRED_ABOVE_KOBO needs ID. */
export function checkRoomLimitChange(user: Pick<User, "ageVerifiedAt" | "dateOfBirth">, kobo: unknown): RoomLimitCheck {
  if (!isRoomLimitOption(kobo)) return { ok: false, status: 400, code: "BAD_REQUEST", message: "Choose one of the room limits." };
  if (kobo > ID_REQUIRED_ABOVE_KOBO && !isIdVerifiedAdult(user)) {
    return { ok: false, status: 403, code: "ID_REQUIRED", message: "Verify your ID to set a room limit above 20,000 naira." };
  }
  return { ok: true };
}

/** The payer's room limit for this room, from the database (the default when they never chose one). Pass the reservation's tx. */
export async function roomLimitFor(roomId: string, userId: string, tx?: ss.SprayExec): Promise<{ limitKobo: number; spentKobo: number }> {
  const row = await ss.getRoomSpend(roomId, userId, tx);
  return row ? { limitKobo: Number(row.limitKobo), spentKobo: Number(row.spentKobo) } : { limitKobo: ROOM_LIMIT_DEFAULT_KOBO, spentKobo: 0 };
}

/** Rolling 24 hours, never a calendar day. */
export const dailyWindowStart = (now: number) => new Date(now - DAY_MS);

export type VelocityVerdict = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * 10 per minute and 60 per hour per payer, and 3 per minute per (payer, recipient). Database-backed counts over
 * spray_payments (every attempt counts, whatever its status), so the limit holds across processes and restarts.
 * Called inside the payer's critical section (spray.ts), so parallel requests of one payer are counted one after another.
 * Only the payer's own attempts are counted (the per-recipient count is "how often did I spray this person"), so it never
 * says anything about the recipient.
 */
export async function checkVelocity(payerId: string, recipientId: string, now: number, tx?: ss.SprayExec): Promise<VelocityVerdict> {
  // One after another: a transaction runs one query at a time on its connection.
  const perHour = await ss.countPayerSprays(payerId, new Date(now - 3_600_000), tx);
  const perMinute = await ss.countPayerSprays(payerId, new Date(now - 60_000), tx);
  const perRecipient = await ss.countPayerRecipientSprays(payerId, recipientId, new Date(now - 60_000), tx);
  if (perHour >= VELOCITY.perHour) return { ok: false, retryAfterSec: 600 };
  if (perMinute >= VELOCITY.perMinute || perRecipient >= VELOCITY.perRecipientPerMinute) return { ok: false, retryAfterSec: 60 };
  return { ok: true };
}

/** One spray in flight per (payer, recipient): another one `created` or `pending` started in the last 10 seconds. */
export const IN_FLIGHT_MS = 10_000;
export async function hasSprayInFlight(payerId: string, recipientId: string, now: number, tx?: ss.SprayExec): Promise<boolean> {
  // Pass the reservation's transaction: the critical section then uses exactly one pool connection (never a second one
  // requested while one is held, which could starve the pool with many payers at once).
  return ss.payerRecipientInFlight(payerId, recipientId, new Date(now - IN_FLIGHT_MS), tx);
}

/**
 * The payer-owned limits, with payer data only (their own sprays and their own stored limits), BEFORE anything about the
 * recipient is looked at (rule B2, owner ruling 5): a 409 or 429 then says nothing about the person they named, because the
 * same answer comes back whoever the target is. Not locked: the reservation re-checks all of it under the payer's advisory
 * lock (a refusal there needs the payer's own parallel requests, whose first answer already told them the same).
 */
export type PayerPrecheck =
  | { ok: true }
  | { ok: false; kind: "velocity"; retryAfterSec: number }
  | { ok: false; kind: "in_flight" | "daily" | "room" };
export async function payerPrecheck(
  payer: Pick<User, "id" | "ageVerifiedAt" | "dateOfBirth"> & { sprayDailyLimitKobo?: number | null },
  roomId: string, targetId: string, priceKobo: number, now: number,
): Promise<PayerPrecheck> {
  const vel = await checkVelocity(payer.id, targetId, now);
  if (!vel.ok) return { ok: false, kind: "velocity", retryAfterSec: vel.retryAfterSec };
  if (await hasSprayInFlight(payer.id, targetId, now)) return { ok: false, kind: "in_flight" };
  const spent = await ss.sumPayerKoboSince(db, payer.id, dailyWindowStart(now));
  if (spent + priceKobo > effectiveDailyLimit(payer)) return { ok: false, kind: "daily" };
  const room = await roomLimitFor(roomId, payer.id);
  if (room.spentKobo + priceKobo > room.limitKobo) return { ok: false, kind: "room" };
  return { ok: true };
}

// ---------------------------------------------------------------- new host receive cap (rule B11, owner ruling C2)
// Choice (documented in the lane report): the window is the first NEW_HOST_WINDOW_DAYS days after the ACCOUNT WAS CREATED
// (users.created_at). The data has no "first spray eligibility" timestamp, so account creation is what the existing data
// supports. The cap applies to EVERY person the money reaches: the room's host AND the recipient (a stage guest), each with
// their own window. For each of them it counts every spray they received or hosted (recipient_id or host_id), at the full
// price (fail closed: it can only make the cap bite earlier). Reversing and reversed sprays count too (owner ruling C1: a
// reversal does not take the split share back from the subaccount, so that money did reach them).
// Checked at start (inside the reservation, under the 'spray-recv:<id>' advisory locks) and again at delivery (inside the
// delivery transaction, under the same locks).

/** Statuses counted at start: everything that holds money or may still (created and pending included: fail closed). */
export const CAP_STATUSES_AT_START: readonly SprayStatus[] = Object.freeze(["created", "pending", "paid", "delivered", "reversing", "reversed", "disputed"] as SprayStatus[]);
/** Statuses counted at delivery (plus the spray being delivered): money that reached them. */
export const CAP_STATUSES_AT_DELIVERY: readonly SprayStatus[] = Object.freeze(["delivered", "reversing", "reversed", "disputed"] as SprayStatus[]);

/** NEW_HOST_RECEIVE_CAP_KOBO from the environment when it is a positive whole number of kobo, else the default. */
export function newHostReceiveCapKobo(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.NEW_HOST_RECEIVE_CAP_KOBO ?? "").trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT;
}

/**
 * OWNER DECISION (review r4 N5, 2026-10-20): reversals ALWAYS write clawbacks (money safety), but a person is refused as a
 * spray recipient (or as the host of a stage spray) only when what they still owe on open clawbacks is MORE than this, or
 * when they owe any open clawback from a chargeback (origin 'dispute'). Checked only when a spray STARTS (review r4 N4: a
 * paid spray is never reversed for a debt, the split already happened). CLAWBACK_BLOCK_THRESHOLD_KOBO when it is a
 * non-negative whole number of kobo, else 1,000,000 (10,000 naira).
 */
export const CLAWBACK_BLOCK_THRESHOLD_KOBO_DEFAULT = 1_000_000;
export function clawbackBlockThresholdKobo(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CLAWBACK_BLOCK_THRESHOLD_KOBO ?? "").trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : CLAWBACK_BLOCK_THRESHOLD_KOBO_DEFAULT;
}

/** Is this account still inside its new account window? Unknown creation time counts as new (fail closed). */
export function isNewHost(user: { createdAt: Date | string | null | undefined }, now: number): boolean {
  const created = user.createdAt ? new Date(user.createdAt).getTime() : NaN;
  if (!Number.isFinite(created)) return true;
  return now - created < NEW_HOST_WINDOW_DAYS * DAY_MS;
}

function windowStart(user: { createdAt: Date | string | null | undefined }): Date {
  const d = user.createdAt ? new Date(user.createdAt) : new Date(0);
  return Number.isFinite(d.getTime()) ? d : new Date(0);
}

export type CapUser = { id: string; createdAt: Date | string | null | undefined };

/** The distinct people a spray reaches (the host, and the recipient when it is someone else), in id order (the lock order). */
export function capUsers(host: CapUser, recipient: CapUser): CapUser[] {
  const out = host.id === recipient.id ? [host] : [host, recipient];
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The advisory lock key for one person's receive cap (always taken in capUsers order). */
export const capLockKey = (userId: string): string => `spray-recv:${userId}`;

/**
 * At the start of a spray, inside the reservation transaction that already holds the 'spray-recv' locks of these people:
 * would this price take any of them (inside their new account window) over the cap, counting everything in flight?
 */
export async function overNewHostCapAtStart(people: CapUser[], priceKobo: number, now: number, tx?: ss.SprayExec): Promise<boolean> {
  const cap = newHostReceiveCapKobo();
  for (const u of people) {
    if (!isNewHost(u, now)) continue;
    const already = await ss.sumReceivedSince(u.id, windowStart(u), CAP_STATUSES_AT_START, null, tx);
    if (already + priceKobo > cap) return true;
  }
  return false;
}

/**
 * At delivery, inside the delivery transaction (c) that holds the 'spray-recv' locks of these people: money that reached
 * each of them (delivered, reversing, reversed, disputed) plus this spray. Over the cap for anyone = the spray is reversed.
 */
export async function overNewHostCapAtDelivery(
  c: { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> },
  people: CapUser[], sprayId: string, priceKobo: number, now: number,
): Promise<boolean> {
  const cap = newHostReceiveCapKobo();
  for (const u of people) {
    if (!isNewHost(u, now)) continue;
    const r = await c.query(
      `select coalesce(sum(amount_kobo), 0)::bigint as n from spray_payments
        where (recipient_id = $1 or host_id = $1) and created_at >= $2::timestamp and status = any($3::text[]) and id <> $4::uuid`,
      [u.id, windowStart(u).toISOString(), [...CAP_STATUSES_AT_DELIVERY], sprayId],
    );
    if (Number(r.rows[0]?.n ?? 0) + priceKobo > cap) return true;
  }
  return false;
}
