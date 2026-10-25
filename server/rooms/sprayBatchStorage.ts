// Team spray (rooms gaming): SQL helpers for spray_batches and the share rows (spray_payments with batch_id). No business
// rules here (those are in teamSpray.ts). Same discipline as sprayStorage.ts: every status change is a conditional UPDATE
// (WHERE status IN (...)), and a batch and its shares always change status together, in one transaction, so the share rows
// (which every existing limit, cap, clawback and earnings query reads) never disagree with the charge.
// Nothing here logs. Subaccount codes are stored for the split only: never returned to a client.
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../storage";
import { sprayBatches, sprayPayments, type SprayBatch, type SprayPayment } from "@shared/schema";
import { isSprayStatus, type SprayStatus } from "@shared/spray";
import { UUID_RE, type SprayExec } from "./sprayStorage";
import { recordBatchTransition, recordSprayEvent } from "./sprayEvents";

const x = (tx?: SprayExec): typeof db => (tx ?? db) as typeof db;

export type InsertSprayBatch = typeof sprayBatches.$inferInsert;

export async function getBatchByPayerKey(payerId: string, key: string, tx?: SprayExec): Promise<SprayBatch | null> {
  const [row] = await x(tx).select().from(sprayBatches)
    .where(and(eq(sprayBatches.payerId, payerId), eq(sprayBatches.idempotencyKey, key))).limit(1);
  return row ?? null;
}

export async function getBatchByRef(providerRef: string, tx?: SprayExec): Promise<SprayBatch | null> {
  if (typeof providerRef !== "string" || !providerRef) return null;
  const [row] = await x(tx).select().from(sprayBatches).where(eq(sprayBatches.providerRef, providerRef)).limit(1);
  return row ?? null;
}

export async function getBatchById(id: string, tx?: SprayExec): Promise<SprayBatch | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const [row] = await x(tx).select().from(sprayBatches).where(eq(sprayBatches.id, id)).limit(1);
  return row ?? null;
}

/** The batch row, unless the payer already used this key (then null: the caller re-reads it and replays). */
export async function insertBatchIfNew(row: InsertSprayBatch, tx: SprayExec): Promise<SprayBatch | null> {
  const inserted = await x(tx).insert(sprayBatches).values(row).onConflictDoNothing().returning();
  if (inserted[0]) await recordSprayEvent({ batchId: inserted[0].id, roomId: inserted[0].roomId, from: null, to: inserted[0].status }, x(tx));
  return inserted[0] ?? null;
}

/** The share rows of a batch, in the order they were made (team order). */
export async function sharesOf(batchId: string, tx?: SprayExec): Promise<SprayPayment[]> {
  return x(tx).select().from(sprayPayments).where(eq(sprayPayments.batchId, batchId)).orderBy(asc(sprayPayments.idempotencyKey));
}

export type BatchStatusPatch = Partial<Pick<SprayBatch, "reason" | "paidAt" | "deliveredAt" | "reversedAt" | "refundRequestedAt" | "paymentMethodId" | "authorizationUrl">>;

/**
 * Conditional status change of a batch AND all its share rows, in one transaction (the caller's, or a new one). Returns the
 * updated batch, or null when another process got there first. The same patch fields go on the shares (paid_at, reason ...).
 */
export async function markBatchStatus(
  id: string, from: readonly SprayStatus[], to: SprayStatus, patch: BatchStatusPatch = {}, tx?: SprayExec,
): Promise<SprayBatch | null> {
  if (!isSprayStatus(to) || from.length === 0 || !from.every(isSprayStatus)) throw new RangeError("bad spray status change");
  const set: Record<string, unknown> = { status: to };
  for (const k of ["reason", "paidAt", "deliveredAt", "reversedAt", "refundRequestedAt", "paymentMethodId", "authorizationUrl"] as const) {
    if (k in patch) set[k] = patch[k];
  }
  const run = async (ex: SprayExec) => {
    const [row] = await x(ex).update(sprayBatches).set(set as Partial<SprayBatch>)
      .where(and(eq(sprayBatches.id, id), inArray(sprayBatches.status, [...from]))).returning();
    if (!row) return null;
    const shares = await x(ex).update(sprayPayments).set(set as Partial<SprayPayment>)
      .where(and(eq(sprayPayments.batchId, id), inArray(sprayPayments.status, [...from]))).returning({ id: sprayPayments.id });
    // One event for the batch and one per share row that moved with it (shares carry batch_id so either timeline finds them).
    const prev = from.length === 1 ? from[0] : null;
    await recordBatchTransition(row, shares.map((sh) => sh.id), prev, to, patch.reason ?? null, x(ex));
    return row;
  };
  return tx ? run(tx) : db.transaction((t) => run(t));
}

/** Same as listStaleSprays, for batches (the sweep finalizes each by its reference). */
export async function listStaleBatches(
  statuses: readonly SprayStatus[], olderThan: Date, limit: number, opts: { dueAt?: Date; createdSince?: Date } = {},
): Promise<SprayBatch[]> {
  if (statuses.length === 0 || !statuses.every(isSprayStatus)) return [];
  const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 20;
  const since = sql`coalesce(${sprayBatches.refundRequestedAt}, ${sprayBatches.paidAt}, ${sprayBatches.createdAt})`;
  const conds = [inArray(sprayBatches.status, [...statuses]), sql`${since} < ${olderThan.toISOString()}::timestamp`];
  if (opts.dueAt) conds.push(sql`(${sprayBatches.nextCheckAt} is null or ${sprayBatches.nextCheckAt} <= ${opts.dueAt.toISOString()}::timestamp)`);
  if (opts.createdSince) conds.push(gte(sprayBatches.createdAt, opts.createdSince));
  return db.select().from(sprayBatches).where(and(...conds))
    .orderBy(sql`${sprayBatches.lastCheckedAt} asc nulls first`, asc(sprayBatches.createdAt)).limit(n);
}

export async function noteBatchChecked(id: string, at: Date, nextCheckAt: Date): Promise<void> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return;
  await db.update(sprayBatches)
    .set({ checkAttempts: sql`${sprayBatches.checkAttempts} + 1`, lastCheckedAt: at, nextCheckAt })
    .where(eq(sprayBatches.id, id));
}
