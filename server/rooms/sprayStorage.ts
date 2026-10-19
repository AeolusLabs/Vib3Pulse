// Spraying (phase 5): every SQL helper for spray_payments, room_spend, host_clawbacks, user_payment_methods and the payer's
// daily limit. No business rules here (eligibility, limits and the flow live in spray.ts / sprayLimits.ts / clawbacks.ts);
// only atomic, conditional writes. Every write that changes a status is a conditional UPDATE (WHERE status IN (...)), so two
// processes racing the same spray can never both win. Helpers take an optional transaction where the caller needs one.
// Nothing here logs; callers never log authorization codes, card signatures or emails.
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  hostClawbacks, roomSpend, sprayPayments, userPaymentMethods, users,
  type HostClawback, type InsertSprayPayment, type SprayPayment, type UserPaymentMethod,
} from "@shared/schema";
import { SPRAY_SPEND_STATUSES, isSprayStatus, type SprayStatus } from "@shared/spray";

export type SprayTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The database or a transaction. */
export type SprayExec = typeof db | SprayTx;

/** The transaction has the same query API as db; one static type keeps the generic method calls simple. */
const x = (tx?: SprayExec): typeof db => (tx ?? db) as typeof db;
const isPosInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

// ---------------------------------------------------------------- spray_payments
/**
 * Inserts the spray row unless the payer already used this idempotency key, then re-reads it by (payer_id, key).
 * Never read-then-insert: two parallel requests with the same key get the same row, and exactly one sees created: true.
 * The caller compares the returned row's request_hash with its own (a different hash is IDEMPOTENCY_MISMATCH).
 */
export async function insertSprayIfNew(row: InsertSprayPayment, tx?: SprayExec): Promise<{ row: SprayPayment; created: boolean }> {
  const ex = x(tx);
  const inserted = await ex.insert(sprayPayments).values(row).onConflictDoNothing().returning();
  if (inserted.length > 0) return { row: inserted[0], created: true };
  const [existing] = await ex.select().from(sprayPayments)
    .where(and(eq(sprayPayments.payerId, row.payerId), eq(sprayPayments.idempotencyKey, row.idempotencyKey))).limit(1);
  // A conflict that is not on (payer_id, idempotency_key) can only be a provider_ref collision: refuse loudly, never guess.
  if (!existing) throw new Error("spray insert conflicted on the payment reference");
  return { row: existing, created: false };
}

/** A strict 8-4-4-4-12 hex uuid (anything else would make Postgres throw "invalid input syntax for type uuid"). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSprayById(id: string, tx?: SprayExec): Promise<SprayPayment | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null; // not a uuid: no row (and no SQL error, so 404 not 500)
  const [row] = await x(tx).select().from(sprayPayments).where(eq(sprayPayments.id, id)).limit(1);
  return row ?? null;
}

export async function getSprayByRef(providerRef: string, tx?: SprayExec): Promise<SprayPayment | null> {
  if (typeof providerRef !== "string" || !providerRef) return null;
  const [row] = await x(tx).select().from(sprayPayments).where(eq(sprayPayments.providerRef, providerRef)).limit(1);
  return row ?? null;
}

export type SprayStatusPatch = Partial<Pick<SprayPayment,
  "reason" | "paidAt" | "deliveredAt" | "reversedAt" | "refundRequestedAt" | "paymentMethodId" | "authorizationUrl">>;

/**
 * Conditional status change: only when the row's current status is one of `from`. Returns the updated row, or null when
 * another process got there first (or the id does not exist). Only the listed patch fields can change.
 */
export async function markSprayStatus(
  id: string, from: readonly SprayStatus[], to: SprayStatus, patch: SprayStatusPatch = {}, tx?: SprayExec,
): Promise<SprayPayment | null> {
  if (!isSprayStatus(to) || from.length === 0 || !from.every(isSprayStatus)) throw new RangeError("bad spray status change");
  const set: Record<string, unknown> = { status: to };
  for (const k of ["reason", "paidAt", "deliveredAt", "reversedAt", "refundRequestedAt", "paymentMethodId", "authorizationUrl"] as const) {
    if (k in patch) set[k] = patch[k];
  }
  const [row] = await x(tx).update(sprayPayments).set(set as Partial<SprayPayment>)
    .where(and(eq(sprayPayments.id, id), inArray(sprayPayments.status, [...from]))).returning();
  return row ?? null;
}

/**
 * Sum of amount_kobo of this payer's sprays created since `since` in a status that counts toward the daily limit
 * (SPRAY_SPEND_STATUSES: created, pending, paid, delivered, reversing, disputed). Call it inside the transaction that holds
 * the payer's advisory lock (sprayLimits.ts), passing that transaction.
 */
export async function sumPayerKoboSince(exec: SprayExec, payerId: string, since: Date): Promise<number> {
  const [row] = await x(exec).select({ n: sql<string>`coalesce(sum(${sprayPayments.amountKobo}), 0)::bigint` }).from(sprayPayments)
    .where(and(eq(sprayPayments.payerId, payerId), gte(sprayPayments.createdAt, since), inArray(sprayPayments.status, [...SPRAY_SPEND_STATUSES])));
  return Number(row?.n ?? 0);
}

/** How many sprays (any status: attempts count) this payer started since `since`. Velocity, works across processes. */
export async function countPayerSprays(payerId: string, since: Date, tx?: SprayExec): Promise<number> {
  const [row] = await x(tx).select({ n: sql<number>`count(*)::int` }).from(sprayPayments)
    .where(and(eq(sprayPayments.payerId, payerId), gte(sprayPayments.createdAt, since)));
  return Number(row?.n ?? 0);
}

/** How many sprays (any status) this payer started at this recipient since `since`. */
export async function countPayerRecipientSprays(payerId: string, recipientId: string, since: Date, tx?: SprayExec): Promise<number> {
  const [row] = await x(tx).select({ n: sql<number>`count(*)::int` }).from(sprayPayments)
    .where(and(eq(sprayPayments.payerId, payerId), eq(sprayPayments.recipientId, recipientId), gte(sprayPayments.createdAt, since)));
  return Number(row?.n ?? 0);
}

/**
 * Sprays in one of `statuses` whose last state change is older than `olderThan`, at most `limit`, for the sweep (it
 * re-checks each row under its lock). "Last state change" is refund_requested_at, else paid_at, else created_at (so a
 * `paid` row ages from when payment was detected and a `reversing` row from when its refund was asked for).
 * Fair order: rows never checked first, then the least recently checked, so rows that are stuck for good (a refund the
 * provider keeps refusing, a verify that keeps failing) can never fill every batch. With `opts.dueAt`, rows whose
 * next_check_at (the backoff set by noteSprayChecked) is still in the future are skipped. With `opts.createdSince`, only
 * rows created at or after it (the sweep's 24 hour late-payment window for failed rows).
 */
export async function listStaleSprays(
  statuses: readonly SprayStatus[], olderThan: Date, limit: number,
  opts: { dueAt?: Date; createdSince?: Date } = {}, tx?: SprayExec,
): Promise<SprayPayment[]> {
  if (statuses.length === 0 || !statuses.every(isSprayStatus)) return [];
  const n = isPosInt(limit) ? Math.min(limit, 500) : 50;
  const since = sql`coalesce(${sprayPayments.refundRequestedAt}, ${sprayPayments.paidAt}, ${sprayPayments.createdAt})`;
  // Same Date mapping as drizzle's timestamp columns (ISO text cast to timestamp), so this agrees with gte() elsewhere.
  const conds = [inArray(sprayPayments.status, [...statuses]), sql`${since} < ${olderThan.toISOString()}::timestamp`];
  if (opts.dueAt) conds.push(sql`(${sprayPayments.nextCheckAt} is null or ${sprayPayments.nextCheckAt} <= ${opts.dueAt.toISOString()}::timestamp)`);
  if (opts.createdSince) conds.push(gte(sprayPayments.createdAt, opts.createdSince));
  return await x(tx).select().from(sprayPayments)
    .where(and(...conds))
    .orderBy(sql`${sprayPayments.lastCheckedAt} asc nulls first`, asc(sprayPayments.createdAt)).limit(n);
}

/**
 * The sweep looked at this row: one more attempt, when, and the earliest time it is worth looking again (a backoff).
 * Bookkeeping only (never a status), so it is unconditional and harmless if the row moved meanwhile.
 */
export async function noteSprayChecked(id: string, at: Date, nextCheckAt: Date, tx?: SprayExec): Promise<void> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return;
  await x(tx).update(sprayPayments)
    .set({ checkAttempts: sql`${sprayPayments.checkAttempts} + 1`, lastCheckedAt: at, nextCheckAt })
    .where(eq(sprayPayments.id, id));
}

/** Another spray of this payer to this recipient still `created` or `pending`, started at or after `since`. */
export async function payerRecipientInFlight(payerId: string, recipientId: string, since: Date, tx?: SprayExec): Promise<boolean> {
  const [row] = await x(tx).select({ id: sprayPayments.id }).from(sprayPayments)
    .where(and(eq(sprayPayments.payerId, payerId), eq(sprayPayments.recipientId, recipientId),
      inArray(sprayPayments.status, ["created", "pending"]), sql`${sprayPayments.createdAt} > ${since.toISOString()}::timestamp`))
    .limit(1);
  return !!row;
}

/**
 * Total amount_kobo of sprays this person received or hosted (recipient_id = them OR host_id = them) created at or after
 * `since`, in one of `statuses`, optionally leaving one spray out. The new-host receive cap (sprayLimits.ts).
 */
export async function sumReceivedSince(
  userId: string, since: Date, statuses: readonly SprayStatus[], exceptSprayId: string | null, tx?: SprayExec,
): Promise<number> {
  if (statuses.length === 0 || !statuses.every(isSprayStatus)) throw new RangeError("bad spray statuses");
  const conds = [
    or(eq(sprayPayments.recipientId, userId), eq(sprayPayments.hostId, userId)),
    gte(sprayPayments.createdAt, since),
    inArray(sprayPayments.status, [...statuses]),
  ];
  if (exceptSprayId) conds.push(sql`${sprayPayments.id} <> ${exceptSprayId}::uuid`);
  const [row] = await x(tx).select({ n: sql<string>`coalesce(sum(${sprayPayments.amountKobo}), 0)::bigint` }).from(sprayPayments)
    .where(and(...conds));
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------- room_spend (the payer's own room limit)
/**
 * Reserves `kobo` of the payer's room limit, atomically. Returns false (and changes nothing) when it would go over.
 * `limitKobo` only seeds a row that does not exist yet (the caller reads it from the database, never from the client);
 * an existing row keeps its stored limit. The UPDATE is the gate: concurrent calls serialise on the row lock and each
 * re-checks `spent + kobo <= limit` against the latest row, so parallel calls can never pass the limit together.
 */
export async function addSpend(roomId: string, userId: string, kobo: number, limitKobo: number, tx?: SprayExec): Promise<boolean> {
  if (!isPosInt(kobo) || !isPosInt(limitKobo)) return false; // fail closed
  const ex = x(tx);
  await ex.insert(roomSpend).values({ roomId, userId, limitKobo, spentKobo: 0 }).onConflictDoNothing();
  const rows = await ex.update(roomSpend).set({ spentKobo: sql`${roomSpend.spentKobo} + ${kobo}` })
    .where(and(eq(roomSpend.roomId, roomId), eq(roomSpend.userId, userId), sql`${roomSpend.spentKobo} + ${kobo} <= ${roomSpend.limitKobo}`))
    .returning({ spentKobo: roomSpend.spentKobo });
  return rows.length > 0;
}

/**
 * Gives back a reservation (failed, reversed or never-paid spray). Never below zero. Call it only from the same conditional
 * status change that ends the spray, so it runs once per spray.
 */
export async function releaseSpend(roomId: string, userId: string, kobo: number, tx?: SprayExec): Promise<void> {
  if (!isPosInt(kobo)) return;
  await x(tx).update(roomSpend).set({ spentKobo: sql`greatest(${roomSpend.spentKobo} - ${kobo}, 0)` })
    .where(and(eq(roomSpend.roomId, roomId), eq(roomSpend.userId, userId)));
}

export async function getRoomSpend(roomId: string, userId: string, tx?: SprayExec): Promise<{ limitKobo: number; spentKobo: number } | null> {
  const [row] = await x(tx).select({ limitKobo: roomSpend.limitKobo, spentKobo: roomSpend.spentKobo }).from(roomSpend)
    .where(and(eq(roomSpend.roomId, roomId), eq(roomSpend.userId, userId))).limit(1);
  return row ?? null;
}

/**
 * Sets the payer's limit for this room (the caller validates it is one of ROOM_LIMIT_OPTIONS_KOBO and the ID rule). A
 * limit below what is already spent is stored as the spent amount (so nothing more can be sprayed there), never an error.
 */
export async function setRoomLimit(roomId: string, userId: string, limitKobo: number, tx?: SprayExec): Promise<{ limitKobo: number; spentKobo: number }> {
  if (!isPosInt(limitKobo)) throw new RangeError("room limit must be a positive integer of kobo");
  const [row] = await x(tx).insert(roomSpend).values({ roomId, userId, limitKobo, spentKobo: 0 })
    .onConflictDoUpdate({ target: [roomSpend.roomId, roomSpend.userId], set: { limitKobo: sql`greatest(${limitKobo}, ${roomSpend.spentKobo})` } })
    .returning({ limitKobo: roomSpend.limitKobo, spentKobo: roomSpend.spentKobo });
  return row;
}

// ---------------------------------------------------------------- host_clawbacks
/**
 * One clawback per (spray, beneficiary): a second dispute event (or a dispute after a reversal) for the same spray changes
 * nothing. origin: 'dispute' (a chargeback) or 'reversal' (a split charge refunded in full); default 'dispute'.
 */
export async function insertClawbackIfNew(
  c: { hostId: string; beneficiaryId: string; sprayId: string; amountKobo: number; origin?: "dispute" | "reversal" }, tx?: SprayExec,
): Promise<{ row: HostClawback; created: boolean }> {
  if (!isPosInt(c.amountKobo)) throw new RangeError("clawback amount must be a positive integer of kobo");
  const origin = c.origin === "reversal" ? "reversal" : "dispute";
  const ex = x(tx);
  const inserted = await ex.insert(hostClawbacks)
    .values({ hostId: c.hostId, beneficiaryId: c.beneficiaryId, sprayId: c.sprayId, amountKobo: c.amountKobo, origin })
    .onConflictDoNothing({ target: [hostClawbacks.sprayId, hostClawbacks.beneficiaryId] }).returning();
  if (inserted.length > 0) return { row: inserted[0], created: true };
  const [existing] = await ex.select().from(hostClawbacks)
    .where(and(eq(hostClawbacks.sprayId, c.sprayId), eq(hostClawbacks.beneficiaryId, c.beneficiaryId))).limit(1);
  return { row: existing, created: false };
}

/**
 * Open clawbacks this person owes back, oldest first: rows where they are the BENEFICIARY (the one who received the
 * money: the host for a host share, the stage guest for a guest share). A guest share is never taken from the host's payout. With a transaction the rows are
 * locked FOR UPDATE, so settlement applying them is serialised with another settlement for the same person.
 */
export async function openClawbacksFor(hostId: string, tx?: SprayExec): Promise<HostClawback[]> {
  const q = x(tx).select().from(hostClawbacks)
    .where(and(eq(hostClawbacks.beneficiaryId, hostId), eq(hostClawbacks.status, "open")))
    .orderBy(asc(hostClawbacks.createdAt));
  return tx ? await q.for("update") : await q;
}

/** Marks these clawbacks recovered in full (recovered_kobo = amount_kobo), only those still open. Returns the rows that changed. */
export async function markClawbacksRecovered(ids: readonly string[], tx?: SprayExec): Promise<HostClawback[]> {
  if (ids.length === 0) return [];
  return await x(tx).update(hostClawbacks).set({ status: "recovered", recoveredKobo: sql`${hostClawbacks.amountKobo}`, recoveredAt: new Date() })
    .where(and(inArray(hostClawbacks.id, [...ids]), eq(hostClawbacks.status, "open"))).returning();
}

/**
 * Does any of these people owe an open clawback (as the beneficiary)? A debtor never receives another spray (host or
 * recipient), so a reversal or chargeback can never be followed by more money to the same account.
 */
export async function hasOpenClawback(userIds: readonly string[], tx?: SprayExec): Promise<boolean> {
  const ids = Array.from(new Set(userIds.filter((u) => typeof u === "string" && u.length > 0)));
  if (ids.length === 0) return false;
  const [row] = await x(tx).select({ id: hostClawbacks.id }).from(hostClawbacks)
    .where(and(inArray(hostClawbacks.beneficiaryId, ids), eq(hostClawbacks.status, "open"))).limit(1);
  return !!row;
}

// ---------------------------------------------------------------- saved card (a payment method, never a balance)
/**
 * The payer's current saved reusable card, or null. The row holds auth_enc (encrypted): pass it to decryptToken only at
 * charge time; never return or log the row. Routes return { last4, brand } only.
 */
export async function getSavedMethod(userId: string, tx?: SprayExec): Promise<UserPaymentMethod | null> {
  const [row] = await x(tx).select().from(userPaymentMethods)
    .where(and(eq(userPaymentMethods.userId, userId), isNull(userPaymentMethods.deletedAt), eq(userPaymentMethods.reusable, true),
      sql`${userPaymentMethods.authEnc} <> ''`))
    .orderBy(sql`${userPaymentMethods.createdAt} desc`).limit(1);
  return row ?? null;
}

/**
 * Saves (or revives) a card. Only a REUSABLE card with an encrypted code and a signature is ever stored; anything else
 * returns null and stores nothing. The same card again (same user and signature) updates the one row.
 */
export async function saveMethod(
  m: { userId: string; provider: string; authEnc: string; last4: string | null; brand: string | null; bank: string | null; reusable: boolean; signature: string },
  tx?: SprayExec,
): Promise<UserPaymentMethod | null> {
  if (m.reusable !== true || typeof m.authEnc !== "string" || !m.authEnc || typeof m.signature !== "string" || !m.signature) return null;
  const last4 = typeof m.last4 === "string" && /^\d{4}$/.test(m.last4) ? m.last4 : null;
  const [row] = await x(tx).insert(userPaymentMethods)
    .values({ userId: m.userId, provider: m.provider, authEnc: m.authEnc, last4, brand: m.brand, bank: m.bank, reusable: true, signature: m.signature })
    .onConflictDoUpdate({
      target: [userPaymentMethods.userId, userPaymentMethods.signature],
      set: { provider: m.provider, authEnc: m.authEnc, last4, brand: m.brand, bank: m.bank, reusable: true, deletedAt: null, createdAt: new Date() },
    }).returning();
  return row ?? null;
}

/** Soft-deletes every saved card of this user and wipes the encrypted code. Returns how many were removed. */
export async function deleteMethod(userId: string, tx?: SprayExec): Promise<number> {
  const rows = await x(tx).update(userPaymentMethods).set({ authEnc: "", deletedAt: new Date() })
    .where(and(eq(userPaymentMethods.userId, userId), or(isNull(userPaymentMethods.deletedAt), sql`${userPaymentMethods.authEnc} <> ''`)))
    .returning({ id: userPaymentMethods.id });
  return rows.length;
}

// ---------------------------------------------------------------- daily limit
/** Stores the payer's daily limit (null = the default). The caller checks the verified-adult and maximum rules. */
export async function setDailyLimit(userId: string, kobo: number | null, tx?: SprayExec): Promise<void> {
  if (kobo !== null && !isPosInt(kobo)) throw new RangeError("daily limit must be a positive integer of kobo or null");
  await x(tx).update(users).set({ sprayDailyLimitKobo: kobo }).where(eq(users.id, userId));
}

/** The payer's stored daily limit (null = the default), read from the database each time. */
export async function getDailyLimit(userId: string, tx?: SprayExec): Promise<number | null> {
  const [row] = await x(tx).select({ v: users.sprayDailyLimitKobo }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.v ?? null;
}
