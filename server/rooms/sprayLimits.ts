// Spraying (phase 5, task 5.5): the payer's limits, velocity, the one-in-flight rule and the new host receive cap.
// Every limit is read from the database each time, never from the client. The SQL that stores limits and spend lives in
// sprayStorage.ts (lane A); this file only decides. The reservation itself (advisory lock, daily sum, room spend, insert)
// runs in spray.ts, inside one per-payer critical section, so these counts cannot race each other for one payer.
import { pool } from "../storage";
import type { User } from "@shared/schema";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import {
  DAILY_DEFAULT_KOBO, DAILY_VERIFIED_MAX_KOBO, ID_REQUIRED_ABOVE_KOBO, NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT, NEW_HOST_WINDOW_DAYS,
  ROOM_LIMIT_DEFAULT_KOBO, VELOCITY, isRoomLimitOption,
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

/** The payer's room limit for this room, from the database (the default when they never chose one). */
export async function roomLimitFor(roomId: string, userId: string): Promise<{ limitKobo: number; spentKobo: number }> {
  const row = await ss.getRoomSpend(roomId, userId);
  return row ? { limitKobo: Number(row.limitKobo), spentKobo: Number(row.spentKobo) } : { limitKobo: ROOM_LIMIT_DEFAULT_KOBO, spentKobo: 0 };
}

/** Rolling 24 hours, never a calendar day. */
export const dailyWindowStart = (now: number) => new Date(now - DAY_MS);

export type VelocityVerdict = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * 10 per minute and 60 per hour per payer, and 3 per minute per (payer, recipient). Database-backed counts over
 * spray_payments (every attempt counts, whatever its status), so the limit holds across processes and restarts.
 * Called inside the payer's critical section (spray.ts), so parallel requests of one payer are counted one after another.
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
export async function hasSprayInFlight(payerId: string, recipientId: string, now: number): Promise<boolean> {
  const r = await pool.query(
    `select 1 from spray_payments
      where payer_id = $1 and recipient_id = $2 and status in ('created', 'pending') and created_at > $3::timestamp
      limit 1`,
    [payerId, recipientId, new Date(now - IN_FLIGHT_MS).toISOString()],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- new host receive cap (rule B11)
// Choice (documented in the lane report): the window is the first NEW_HOST_WINDOW_DAYS days after the HOST ACCOUNT WAS
// CREATED (users.created_at). The data has no "first spray eligibility" timestamp, so account creation is what the existing
// data supports. The cap counts every spray made in that host's rooms (spray_payments.host_id), whoever it went to, at the
// full price: a stage guest spray in a new host's room counts too (fail closed: it can only make the cap bite earlier).

/** NEW_HOST_RECEIVE_CAP_KOBO from the environment when it is a positive whole number of kobo, else the default. */
export function newHostReceiveCapKobo(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.NEW_HOST_RECEIVE_CAP_KOBO ?? "").trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT;
}

/** Is this host still inside their new host window? Unknown creation time counts as new (fail closed). */
export function isNewHost(host: { createdAt: Date | string | null | undefined }, now: number): boolean {
  const created = host.createdAt ? new Date(host.createdAt).getTime() : NaN;
  if (!Number.isFinite(created)) return true;
  return now - created < NEW_HOST_WINDOW_DAYS * DAY_MS;
}

/**
 * Total of sprays in this host's rooms, at or after `since`, in statuses that hold money or may still (created, pending,
 * paid, delivered, reversing, disputed), optionally leaving one spray out (the one being finalized).
 */
export async function hostReceivedSince(
  q: { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> }, hostId: string, since: Date, exceptSprayId?: string,
): Promise<number> {
  const r = await q.query(
    `select coalesce(sum(amount_kobo), 0)::bigint as n from spray_payments
      where host_id = $1 and created_at >= $2::timestamp
        and status in ('created', 'pending', 'paid', 'delivered', 'reversing', 'disputed')
        and ($3::uuid is null or id <> $3::uuid)`,
    [hostId, since.toISOString(), exceptSprayId ?? null],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** At the start of a spray: would this price take a new host over the cap (counting everything in flight)? */
export async function overNewHostCapAtStart(host: { id: string; createdAt: Date | string | null | undefined }, priceKobo: number, now: number): Promise<boolean> {
  if (!isNewHost(host, now)) return false;
  const since = host.createdAt ? new Date(host.createdAt) : new Date(0);
  const already = await hostReceivedSince(pool, host.id, Number.isFinite(since.getTime()) ? since : new Date(0));
  return already + priceKobo > newHostReceiveCapKobo();
}

/**
 * At delivery, inside the delivery transaction that holds the host's advisory lock: only money that is actually with the
 * host counts (delivered, disputed), plus this spray. Over the cap means the spray is reversed.
 */
export async function overNewHostCapAtDelivery(
  c: { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> },
  host: { id: string; createdAt: Date | string | null | undefined }, sprayId: string, priceKobo: number, now: number,
): Promise<boolean> {
  if (!isNewHost(host, now)) return false;
  const since = host.createdAt ? new Date(host.createdAt) : new Date(0);
  const r = await c.query(
    `select coalesce(sum(amount_kobo), 0)::bigint as n from spray_payments
      where host_id = $1 and created_at >= $2::timestamp and status in ('delivered', 'disputed') and id <> $3::uuid`,
    [host.id, (Number.isFinite(since.getTime()) ? since : new Date(0)).toISOString(), sprayId],
  );
  return Number(r.rows[0]?.n ?? 0) + priceKobo > newHostReceiveCapKobo();
}
