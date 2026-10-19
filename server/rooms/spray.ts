// Spraying (phase 5, task 5.4): the spray endpoint's flow, finalize (deliver or reverse), and the room's spray block.
//
// MONEY RULES (read before changing anything here; revisions section B is the checklist)
//  1. Server authority. Every amount comes from SPRAY_CATALOGUE through spraySplit; the request only names a tier, a target
//     user id and an idempotency key. Payer id is the session's; the reference is ours (HMAC bound to room, payer, tier,
//     recipient). Currency is NGN only.
//  2. No oracle. Every eligibility failure about the payer, the room or the recipient (flag off included) answers the SAME
//     403 SPRAY_UNAVAILABLE. Only payer-owned facts get their own codes (limits, idempotency, rate, their card).
//  3. Reserve first. One per-payer critical section (in-process queue, then pg_advisory_xact_lock on 'spray-daily:<payer>')
//     re-checks the idempotency key, velocity, the one-in-flight rule and the rolling 24 h daily limit, reserves the room
//     spend and inserts the row, all in ONE transaction. Only then is the provider called.
//  4. Exactly one charge, exactly one delivery. A key that exists answers from its row and never charges again.
//     finalizeSpray is serialised per reference (in-process queue + a session advisory lock across processes) and every
//     status change is conditional (WHERE status IN (...)). Delivery and its ledger row commit together, under
//     pg_advisory_xact_lock on the reference and on the host (new host cap). The room:spray broadcast happens AFTER the
//     commit and is never the source of truth.
//  5. Reverse, never strand. Paid but undeliverable => 'reversing' (reason), the provider refund (lookup first, never twice),
//     'reversed' only once the provider says the refund is processed. A lookup or refund failure stays 'reversing' and the
//     sweep (sprayJobs.ts) tries again. The spend reservation is given back exactly once, by the winning transition.
//  6. Secrets. Authorization codes are decrypted only to charge and encrypted at once when saved; never logged, never in a
//     response, never in an error. Logs carry the reference prefix, ids and outcomes only (never emails or card data).
import crypto from "crypto";
import type { PoolClient } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { sprayPayments, type Room, type SprayPayment, type User } from "@shared/schema";
import { SPRAY_CATALOGUE, isSprayTier, type SprayTier } from "@shared/money";
import {
  DELIVERY_DEADLINE_MS, SPRAY_REASONS, idempotencyKeyShape, requiresThreeDs, sprayEligibility, spraySplit,
  type SprayCode, type SprayStatus,
} from "@shared/spray";
import { moneyEligibleRoom } from "@shared/roomRules";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import { getSplitProvider, type ChargeResult, type SplitSpec, type SplitVerifyResult } from "../payments/splitProvider";
import { decryptToken, encryptToken } from "../payments/tokenCrypto";
import {
  looksLikeSprayReference, makeSprayReference, sprayReferenceBelongsTo, sprayReferenceForLog, sprayReferenceSecret,
} from "../payments/sprayReference";
import { deliverNotification } from "../notifications";
import { isBlockedEitherWay } from "../utils/blocks";
import * as rs from "./roomStorage";
import * as ss from "./sprayStorage";
import { roomHub } from "./RoomHub";
import { isKicked } from "./roomSocket";
import { roomFeatures } from "./features";
import { hasVerifiedPayoutAccount } from "./ticketStorage";
import { ticketCheckoutBaseUrl } from "./checkoutUrl";
import { createKeyedQueue, QueueFullError } from "./keyedQueue";
import { BUSY, openPaymentIssue, withAdvisoryLock } from "./refunds";
import {
  checkVelocity, dailyWindowStart, effectiveDailyLimit, hasSprayInFlight, overNewHostCapAtDelivery, overNewHostCapAtStart,
  roomLimitFor,
} from "./sprayLimits";

export { QueueFullError };

// ---------------------------------------------------------------- constants and seams
/** The one answer for every eligibility failure (rule B2). Same shape, no detail about the recipient or the room. */
export const SPRAY_UNAVAILABLE = Object.freeze({ code: "SPRAY_UNAVAILABLE", message: "Spraying is not available here." });

/** Advisory lock namespace for one spray reference (refunds.ts uses 41001 / 41002). */
export const LOCK_SPRAY = 41003;

/** created / pending rows older than this are re-verified by the sweep: paid => finalize, anything else => failed. */
export const UNPAID_EXPIRY_MS = 10 * 60_000;

/** The one clock for spraying. Tests replace now(); production never does. */
export const sprayClock = { now: (): number => Date.now() };

/** Test-only seams (ignored when NODE_ENV=production). */
export const sprayTestHooks: {
  /** Fail the ledger write of one delivery (by spray id), to prove delivery and ledger commit together. */
  failDeliveryLedger?: (sprayId: string) => boolean;
  /** Throw from the broadcast, to prove a broadcast failure never undoes a delivered spray. */
  failBroadcast?: (sprayId: string) => boolean;
} = {};
const testing = () => process.env.NODE_ENV !== "production";

const PROVIDER_NAME = "paystack";
const iso = (ms: number) => new Date(ms).toISOString();
const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Reference prefix, ids and an outcome. Never amounts beyond the tier, card data, codes or emails. */
function logSpray(reference: string, outcome: string, extra = ""): void {
  console.log(`[rooms:spray] ref=${sprayReferenceForLog(reference)} outcome=${outcome}${extra ? ` ${extra}` : ""}`);
}

/** sha256(roomId|tier|targetId): the body a key was first used with. */
export function sprayRequestHash(roomId: string, tier: string, targetId: string): string {
  return crypto.createHash("sha256").update(`${roomId}|${tier}|${targetId}`).digest("hex");
}

// Reasons stored on the row. Only SPRAY_REASONS are ever shown to the payer; the others are for finance and logs.
type InternalReason = "AMOUNT_MISMATCH" | "NOT_DELIVERABLE" | "HOST_CAP" | "LATE_PAYMENT";
type StoredReason = (typeof SPRAY_REASONS)[number] | InternalReason;
const shownReason = (r: string | null | undefined): string | undefined =>
  r && (SPRAY_REASONS as readonly string[]).includes(r) ? r : undefined;

/** Plain words for the payer-only chat line after a reversal (no em dashes, no "cash"). */
const REVERSAL_TEXT: Record<string, string> = {
  RECIPIENT_LEFT: "They left the stage, so you were refunded in full.",
  ROOM_ENDED: "The room ended before your spray landed, so you were refunded in full.",
  TIMEOUT: "Your spray took too long to land, so you were refunded in full.",
};
const REVERSAL_DEFAULT = "Your spray could not be delivered, so you were refunded in full.";

// ---------------------------------------------------------------- the gate (rule B1)
export interface SprayFacts {
  room: Room;
  payer: User;
  host: User;
  recipient: User;
  kind: "host" | "stage";
  hostSubaccount: string;
  recipientSubaccount: string;
}

async function subaccountOf(userId: string): Promise<string | null> {
  const acct = await storage.getOrganizerPaymentAccount(userId, "paystack");
  return acct && acct.payoutsEnabled === true && acct.paystackSubaccountCode ? acct.paystackSubaccountCode : null;
}

const accountUsable = async (u: User | undefined): Promise<boolean> =>
  !!u && !u.deletedAt && !(await storage.getActiveSuspension(u.id));

/**
 * Loads everything the rule needs from the database and the hub (never from the request) and runs sprayEligibility, plus
 * the server-only checks the pure rule cannot see (accounts banned or deleted, kicked, blocks, an empty room).
 *  - phase "start": the payer must be in the room now, and the spray switch must be on.
 *  - phase "deliver" (inside finalize): a payment was already taken, so the switch no longer matters and the payer may have
 *    left (a bank approval page takes them out of the room); a banned, deleted or suspended payer still stops delivery.
 * Every failure is one code; callers turn any of them into the generic 403 (start) or a reversal (deliver).
 */
export async function sprayGate(
  roomId: string, payerId: string, recipientId: string, phase: "start" | "deliver",
): Promise<{ ok: true; facts: SprayFacts } | { ok: false; code: SprayCode | "SERVER_RULE" }> {
  const room = await rs.getRoom(roomId);
  if (!room) return { ok: false, code: "ROOM_NOT_LIVE" };
  const [payer, host, recipient, payerMember] = await Promise.all([
    storage.getUser(payerId), storage.getUser(room.hostId), storage.getUser(recipientId), rs.getMember(roomId, payerId),
  ]);
  const [payerOk, hostOk, recipientOk, blocked, hostSub, recipientSub] = await Promise.all([
    accountUsable(payer), accountUsable(host), accountUsable(recipient),
    isBlockedEitherWay(payerId, recipientId),
    hasVerifiedPayoutAccount(room.hostId).then((ok) => (ok ? subaccountOf(room.hostId) : null)),
    recipientId === room.hostId ? Promise.resolve<string | null>(null)
      : hasVerifiedPayoutAccount(recipientId).then((ok) => (ok ? subaccountOf(recipientId) : null)),
  ]);
  const recipientHub = roomHub.get(roomId, recipientId);
  const stage = roomHub.stageOf(roomId).stage;
  const role: "host" | "cohost" | "guest" = recipientId === room.hostId ? "host" : recipientHub?.role === "cohost" ? "cohost" : "guest";
  // On stage: a co-host who is in the room (an implicit speaker) or a guest the host put on the stage list.
  const onStage = role !== "host" && !!recipientHub && (role === "cohost" || stage.includes(recipientId));
  const payerBanned = !payerOk || payerMember?.banned === true || isKicked(roomId, payerId);
  const recipientPayable = recipientId === room.hostId ? !!hostSub : !!recipientSub;

  const v = sprayEligibility({
    room: { ageLimit: room.ageLimit, status: room.status, minorsRoom: room.minorsRoom },
    payer: {
      userId: payerId,
      idVerifiedAdult: !!payer && payerOk && isIdVerifiedAdult(payer),
      inRoom: phase === "deliver" ? true : !!roomHub.get(roomId, payerId),
      banned: payerBanned,
    },
    recipient: {
      userId: recipientId,
      idVerifiedAdult: !!recipient && recipientOk && isIdVerifiedAdult(recipient),
      hasSubaccount: recipientPayable,
      role,
      onStage,
      present: !!recipientHub,
    },
    host: { idVerifiedAdult: !!host && hostOk && isIdVerifiedAdult(host), hasPayoutAccount: !!hostSub },
    flags: { spray: phase === "deliver" ? true : roomFeatures.spray === true },
    blocked,
  });
  if (!v.ok) return { ok: false, code: v.code };
  // Rule B14: a room with nobody else in it is not spray-eligible (at start; at delivery the recipient's presence is the test).
  if (phase === "start" && roomHub.count(roomId) < 2) return { ok: false, code: "SERVER_RULE" };
  // The hub's minors' flag can be newer than the row: never money in a room the hub knows is a minors' room.
  if (roomHub.isMinorsRoom(roomId) || !moneyEligibleRoom(room)) return { ok: false, code: "ROOM_NOT_ELIGIBLE" };
  if (!payer || !host || !recipient || !hostSub) return { ok: false, code: "SERVER_RULE" };
  const kind = recipientId === room.hostId ? "host" : "stage";
  return {
    ok: true,
    facts: { room, payer, host, recipient, kind, hostSubaccount: hostSub, recipientSubaccount: kind === "host" ? hostSub : (recipientSub as string) },
  };
}

/** Why a delivery failed, as a stored reason. */
function reversalReasonFor(code: SprayCode | "SERVER_RULE"): StoredReason {
  if (code === "ROOM_NOT_LIVE" || code === "ROOM_NOT_ELIGIBLE") return "ROOM_ENDED";
  if (code === "RECIPIENT_NOT_ALLOWED" || code === "RECIPIENT_NOT_PAYABLE") return "RECIPIENT_LEFT";
  return "NOT_DELIVERABLE";
}

// ---------------------------------------------------------------- start (POST /api/rooms/:id/spray)
export interface StartOutcome {
  status: number;
  body: Record<string, unknown>;
  /** Seconds, for 429 answers (the route sets Retry-After). */
  retryAfterSec?: number;
}

const unavailable = (): StartOutcome => ({ status: 403, body: { ...SPRAY_UNAVAILABLE } });
const badRequest = (): StartOutcome => ({ status: 400, body: { code: "BAD_REQUEST", message: "That spray request is not valid." } });
const rateLimited = (sec: number): StartOutcome => ({
  status: 429, retryAfterSec: sec, body: { code: "RATE_LIMITED", message: "You're spraying too fast. Please wait a moment." },
});
const declined = (sprayId: string, reason: string): StartOutcome => ({
  status: 402, body: { code: "PAYMENT_DECLINED", sprayId, reason, message: "Your card was not charged." },
});

async function rowByPayerKey(payerId: string, key: string, ex: ss.SprayExec = db): Promise<SprayPayment | null> {
  const [row] = await (ex as typeof db).select().from(sprayPayments)
    .where(and(eq(sprayPayments.payerId, payerId), eq(sprayPayments.idempotencyKey, key))).limit(1);
  return row ?? null;
}

/** A key that was used before: the first result, read from the row. Never a second charge. */
function replayOutcome(row: SprayPayment, requestHash: string): StartOutcome {
  if (row.requestHash !== requestHash) {
    return { status: 409, body: { code: "IDEMPOTENCY_MISMATCH", message: "That spray was already sent with different details." } };
  }
  const status = row.status as SprayStatus;
  if (status === "failed") return declined(row.id, shownReason(row.reason) ?? "DECLINED");
  if (status === "delivered") return { status: 200, body: { status: "delivered", sprayId: row.id } };
  const reason = shownReason(row.reason);
  return { status: 200, body: { status: "pending", sprayId: row.id, ...(reason ? { reason } : {}) } };
}

/** Per payer, in this process, before a pool connection is taken (the advisory lock still serialises across processes). */
const payerQueue = createKeyedQueue({ maxPending: 5 });
/** Per reference, in this process, before the advisory-lock connection is taken. */
const finalizeQueue = createKeyedQueue({ maxPending: 10 });

type Reservation =
  | { kind: "created"; row: SprayPayment }
  | { kind: "replay"; row: SprayPayment }
  | { kind: "velocity"; retryAfterSec: number }
  | { kind: "in_flight" }
  | { kind: "daily" }
  | { kind: "room" };

export interface StartInput {
  roomId: string;
  payerId: string;
  body: unknown;
  /** Outside production, where APP_URL may be unset, the checkout callback falls back to this origin. */
  devOrigin: string;
}

/**
 * The whole POST: validate, gate, reserve, charge. Cheap checks (switch, body, replay, eligibility, limits) all come
 * before any provider call; nothing is written before the eligibility gate passes.
 */
export async function startSpray(input: StartInput): Promise<StartOutcome> {
  const now = sprayClock.now();
  if (!roomFeatures.spray) return unavailable();
  const b = (input.body && typeof input.body === "object" && !Array.isArray(input.body) ? input.body : {}) as Record<string, unknown>;
  const { tier, targetId, idempotencyKey } = b;
  const saveCard = b.saveCard === true;
  if (!isSprayTier(tier) || typeof targetId !== "string" || targetId.length < 1 || targetId.length > 64
    || !idempotencyKeyShape(idempotencyKey) || (b.saveCard !== undefined && typeof b.saveCard !== "boolean")
    || typeof input.roomId !== "string" || input.roomId.length < 1 || input.roomId.length > 64) {
    return badRequest();
  }
  const { roomId, payerId } = input;
  const requestHash = sprayRequestHash(roomId, tier, targetId);

  // A key already used: the first result, never a second charge (and never a fresh eligibility answer for it).
  const prior = await rowByPayerKey(payerId, idempotencyKey);
  if (prior) return replayOutcome(prior, requestHash);

  const gate = await sprayGate(roomId, payerId, targetId, "start");
  if (!gate.ok) {
    console.log(`[rooms:spray] start refused room=${roomId} payer=${payerId} code=${gate.code}`); // server log only
    return unavailable();
  }
  const f = gate.facts;
  const price = SPRAY_CATALOGUE[tier].kobo;
  if (await overNewHostCapAtStart(f.host, price, now)) {
    console.log(`[rooms:spray] start refused room=${roomId} payer=${payerId} code=NEW_HOST_CAP`);
    return unavailable();
  }
  if (!f.payer.email) return unavailable();

  const split = spraySplit(tier, f.kind);
  const bd = split.breakdown;
  const shares: SplitSpec["shares"] = f.kind === "host"
    ? [{ subaccountCode: f.hostSubaccount, amountKobo: split.hostKobo }]
    : [{ subaccountCode: f.hostSubaccount, amountKobo: split.hostKobo }, { subaccountCode: f.recipientSubaccount, amountKobo: split.guestKobo as number }];
  if (!shares.every((s) => Number.isSafeInteger(s.amountKobo) && s.amountKobo > 0)) return unavailable(); // fail closed

  let reference: string;
  try { reference = makeSprayReference(roomId, payerId, tier, targetId, sprayReferenceSecret()); }
  catch (e) {
    console.error("[rooms:spray] no reference secret; refusing:", sanitizeMoneyError(e));
    return { status: 500, body: { code: "SERVER_ERROR", message: "Spraying isn't working right now. Try again later." } };
  }

  // ---- the reservation: one transaction under the payer's advisory lock (rule B5)
  let reserved: Reservation;
  try {
    reserved = await payerQueue.run(payerId, () => db.transaction(async (tx): Promise<Reservation> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`spray-daily:${payerId}`}))`);
      const again = await rowByPayerKey(payerId, idempotencyKey, tx);
      if (again) return { kind: "replay", row: again };
      const vel = await checkVelocity(payerId, targetId, now, tx);
      if (!vel.ok) return { kind: "velocity", retryAfterSec: vel.retryAfterSec };
      if (await hasSprayInFlight(payerId, targetId, now)) return { kind: "in_flight" };
      // The daily limit and the stored limit are read here, from the database, under the lock.
      // (f.payer was read from the database by the gate for this request; never a client value.)
      const spent = await ss.sumPayerKoboSince(tx, payerId, dailyWindowStart(now));
      if (spent + price > effectiveDailyLimit(f.payer)) return { kind: "daily" };
      const roomLimit = await roomLimitFor(roomId, payerId);
      if (!(await ss.addSpend(roomId, payerId, price, roomLimit.limitKobo, tx))) return { kind: "room" };
      const ins = await ss.insertSprayIfNew({
        idempotencyKey, requestHash, roomId, hostId: f.room.hostId, payerId, recipientId: targetId, tier,
        v3c: SPRAY_CATALOGUE[tier].v3c, amountKobo: bd.price, vatKobo: bd.vat, feeKobo: bd.fee, reserveKobo: bd.reserve,
        platformKobo: bd.platform, hostKobo: split.hostKobo, guestKobo: split.guestKobo,
        provider: PROVIDER_NAME, providerRef: reference, status: "created",
      }, tx);
      if (!ins.created) throw new Error("spray row conflicted under the payer lock"); // roll back the spend; the retry replays
      return { kind: "created", row: ins.row };
    }));
  } catch (e) {
    if (e instanceof QueueFullError) return rateLimited(2);
    throw e;
  }

  switch (reserved.kind) {
    case "replay": return replayOutcome(reserved.row, requestHash);
    case "velocity": return rateLimited(reserved.retryAfterSec);
    case "in_flight": return rateLimited(10);
    case "daily": return { status: 409, body: { code: "DAILY_LIMIT", message: "This would go over your daily spray limit." } };
    case "room": return { status: 409, body: { code: "ROOM_LIMIT", message: "This would go over your limit for this room." } };
    case "created": break;
  }
  const row = reserved.row;
  logSpray(reference, "created", `room=${roomId} payer=${payerId} tier=${tier}`);
  return chargeNewSpray(row, f, tier, saveCard, shares, input.devOrigin);
}

/** created -> failed with a reason, and the reservation back (only the call that wins the transition gives it back). */
async function failUnpaid(row: SprayPayment, from: SprayStatus[], reason: StoredReason): Promise<boolean> {
  const won = await ss.markSprayStatus(row.id, from, "failed", { reason });
  if (won) await ss.releaseSpend(row.roomId, row.payerId, row.amountKobo).catch((e) => console.error("[rooms:spray] releasing spend failed:", sanitizeMoneyError(e)));
  return !!won;
}

async function chargeNewSpray(
  row: SprayPayment, f: SprayFacts, tier: SprayTier, saveCard: boolean, shares: SplitSpec["shares"], devOrigin: string,
): Promise<StartOutcome> {
  const reference = row.providerRef;
  const metadata: Record<string, string> = {
    type: "spray", sprayId: row.id, roomId: row.roomId, payerId: row.payerId, recipientId: row.recipientId, tier,
    saveCard: saveCard ? "1" : "0",
  };
  const base = ticketCheckoutBaseUrl(process.env, devOrigin);
  if (!base) {
    console.error(`[rooms:spray] room=${row.roomId} outcome=no_app_url (set APP_URL to the site's https origin)`);
    await failUnpaid(row, ["created"], "NETWORK");
    return { status: 500, body: { code: "SERVER_ERROR", message: "Payment couldn't be started. Try again." } };
  }
  const callbackUrl = `${base}/rooms/${encodeURIComponent(row.roomId)}?spray=${encodeURIComponent(row.id)}`;

  let provider: ReturnType<typeof getSplitProvider>;
  try { provider = getSplitProvider(); }
  catch (e) {
    console.error("[rooms:spray] no payment provider:", sanitizeMoneyError(e));
    await failUnpaid(row, ["created"], "NETWORK");
    return declined(row.id, "NETWORK");
  }

  // A saved, reusable card, decrypted only here. Never for bag / rain (rule B9: no silent charge at 10,000 naira and above).
  let method: Awaited<ReturnType<typeof ss.getSavedMethod>> = null;
  let authorizationCode: string | null = null;
  if (!requiresThreeDs(tier)) {
    method = await ss.getSavedMethod(row.payerId);
    if (method) {
      try { authorizationCode = decryptToken(method.authEnc); }
      catch { authorizationCode = null; console.error(`[rooms:spray] payer=${row.payerId} saved card could not be read; using checkout`); }
    }
  }

  if (!authorizationCode) {
    // First payment (or bank approval): a hosted checkout. The payer comes back to the room and the server finalizes.
    try {
      const { url } = await provider.startFirstPayment({
        reference, email: f.payer.email, amountKobo: row.amountKobo, split: { shares }, metadata, callbackUrl,
      });
      await ss.markSprayStatus(row.id, ["created"], "pending");
      logSpray(reference, "action_required");
      return { status: 200, body: { status: "action_required", sprayId: row.id, authorizationUrl: url } };
    } catch (e) {
      // The payer never got a checkout page, so nothing can be paid on it. If a payment ever shows up anyway, finalize
      // refunds it (LATE_PAYMENT).
      console.error(`[rooms:spray] ref=${sprayReferenceForLog(reference)} checkout could not start:`, sanitizeMoneyError(e));
      await failUnpaid(row, ["created"], "NETWORK");
      return declined(row.id, "NETWORK");
    }
  }

  let result: ChargeResult;
  try {
    result = await provider.chargeSaved({
      reference, email: f.payer.email, amountKobo: row.amountKobo, authorizationCode, split: { shares }, metadata,
      force3ds: false, callbackUrl,
    });
  } catch (e) {
    console.error(`[rooms:spray] ref=${sprayReferenceForLog(reference)} charge got no answer:`, sanitizeMoneyError(e));
    result = { status: "failed", reference, failure: "NETWORK" };
  } finally {
    authorizationCode = null;
  }

  if (result.status === "action_required") {
    await ss.markSprayStatus(row.id, ["created"], "pending", { paymentMethodId: method?.id ?? null });
    logSpray(reference, "action_required");
    return result.authorizationUrl
      ? { status: 200, body: { status: "action_required", sprayId: row.id, authorizationUrl: result.authorizationUrl } }
      : { status: 200, body: { status: "pending", sprayId: row.id } };
  }
  if (result.status === "failed" && result.failure && result.failure !== "NETWORK") {
    // The provider answered and no money moved.
    await failUnpaid(row, ["created"], result.failure);
    logSpray(reference, `failed:${result.failure}`);
    return declined(row.id, result.failure);
  }
  // success, or an unknown outcome (NETWORK / no failure code): never marked failed. Verify now; the webhook and the sweep
  // finish whatever this does not.
  await ss.markSprayStatus(row.id, ["created"], "pending", { paymentMethodId: method?.id ?? null });
  let out: FinalizeOutcome;
  try { out = await finalizeSpray(reference); }
  catch (e) {
    console.error(`[rooms:spray] ref=${sprayReferenceForLog(reference)} finalize after charge failed, the sweep will finish it:`, sanitizeMoneyError(e));
    out = "pending";
  }
  if (out === "delivered") return { status: 200, body: { status: "delivered", sprayId: row.id } };
  const now = await ss.getSprayById(row.id);
  if (now?.status === "delivered") return { status: 200, body: { status: "delivered", sprayId: row.id } };
  if (now?.status === "failed") return declined(row.id, shownReason(now.reason) ?? "DECLINED");
  const reason = shownReason(now?.reason);
  return { status: 200, body: { status: "pending", sprayId: row.id, ...(reason ? { reason } : {}) } };
}

// ---------------------------------------------------------------- finalize
export type FinalizeOutcome = "delivered" | "reversed" | "already" | "pending" | "unknown" | "busy";

export interface FinalizeOpts {
  /** Sweep only: a created / pending spray the provider does not report paid is ended as failed (TIMEOUT). */
  expireUnpaid?: boolean;
  /** How long to wait for another process holding this reference (0 = skip at once, the sweep's choice). */
  waitMs?: number;
}

/**
 * The single path from a charge to a delivered or reversed spray. Idempotent; safe to call from the endpoint, the webhook
 * and the sweep, in any order, any number of times, concurrently, on any number of processes.
 * Throws when the provider cannot be asked (the webhook answers 500 and Paystack retries; the sweep tries next pass).
 */
export async function finalizeSpray(reference: string, opts: FinalizeOpts = {}): Promise<FinalizeOutcome> {
  if (!looksLikeSprayReference(reference)) return "unknown";
  return finalizeQueue.run(reference, async () => {
    const r = await withAdvisoryLock(LOCK_SPRAY, reference, (c) => finalizeLocked(c, reference, opts), opts.waitMs ?? 8000);
    return r === BUSY ? "busy" : r;
  });
}

function verifiedMatches(row: SprayPayment, v: SplitVerifyResult): boolean {
  return v.paid === true && Number.isSafeInteger(v.amountKobo) && v.amountKobo === row.amountKobo
    && typeof v.currency === "string" && v.currency.toUpperCase() === "NGN";
}

async function finalizeLocked(c: PoolClient, reference: string, opts: FinalizeOpts): Promise<FinalizeOutcome> {
  const row = await ss.getSprayByRef(reference);
  if (!row) { logSpray(reference, "ignored:no_row"); return "unknown"; }
  // Rule B4: the stored row's room / payer / tier / recipient must be what the reference was made for.
  let bound = false;
  try { bound = sprayReferenceBelongsTo(reference, row.roomId, row.payerId, row.tier, row.recipientId, sprayReferenceSecret()); }
  catch { bound = false; }
  if (!bound) {
    logSpray(reference, "unbound:needs_person");
    await openPaymentIssue(c, { ticketId: null, providerRef: reference, provider: row.provider, reason: "refund_failed", error: "SPRAY_REFERENCE_UNBOUND: the stored spray does not match its reference MAC; check it in Paystack", now: new Date(sprayClock.now()) }).catch(() => false);
    return "unknown";
  }
  const status = row.status as SprayStatus;
  const provider = getSplitProvider();

  if (status === "delivered" || status === "reversed" || status === "disputed") return "already";
  if (status === "reversing") { await continueReversal(c, row); return "reversed"; }
  if (status === "paid") return deliverOrReverse(c, row);

  // created / pending / failed: ask the provider (throws on an outage: never treated as unpaid).
  const v = await provider.verify(reference);
  if (status === "failed") {
    if (v && v.paid) {
      // A payment for a spray we already ended (its checkout could not start, or it expired): give it back.
      const won = await ss.markSprayStatus(row.id, ["failed"], "reversing", { reason: "LATE_PAYMENT", paidAt: new Date(sprayClock.now()), refundRequestedAt: new Date(sprayClock.now()) });
      if (won) { logSpray(reference, "late_payment:reversing"); await continueReversal(c, won); return "reversed"; }
    }
    return "already";
  }
  if (!v || !v.paid) {
    const expired = opts.expireUnpaid === true || (!!v && v.state === "failed");
    if (expired && (await failUnpaid(row, ["created", "pending"], opts.expireUnpaid ? "TIMEOUT" : "DECLINED"))) {
      logSpray(reference, opts.expireUnpaid ? "failed:expired" : "failed:declined");
      return "already";
    }
    return "pending";
  }
  const nowMs = sprayClock.now();
  if (!verifiedMatches(row, v)) {
    // Paid, but not exactly what we priced (amount or currency): never delivered, refunded in full.
    const won = await ss.markSprayStatus(row.id, ["created", "pending"], "reversing", { reason: "AMOUNT_MISMATCH", paidAt: new Date(nowMs), refundRequestedAt: new Date(nowMs) });
    if (won) { logSpray(reference, "amount_mismatch:reversing"); await continueReversal(c, won); }
    return "reversed";
  }
  const paid = await ss.markSprayStatus(row.id, ["created", "pending"], "paid", { paidAt: new Date(nowMs) });
  if (!paid) return "already";
  logSpray(reference, "paid");
  await maybeSaveCard(paid, v);
  return deliverOrReverse(c, paid);
}

/** Rule B8: only with the payer's explicit saveCard AND a reusable card. Never fails the spray. */
async function maybeSaveCard(row: SprayPayment, v: SplitVerifyResult): Promise<void> {
  const a = v.authorization;
  if (v.metadata?.saveCard !== "1" || !a || a.reusable !== true || !a.code || !a.signature) return;
  try {
    await ss.saveMethod({
      userId: row.payerId, provider: row.provider, authEnc: encryptToken(a.code), last4: a.last4 ?? null, brand: a.brand ?? null,
      bank: a.bank ?? null, reusable: true, signature: a.signature,
    });
  } catch (e) {
    // The message never holds the code (tokenCrypto / storage errors carry no secret); sanitized anyway.
    console.error(`[rooms:spray] payer=${row.payerId} card not saved:`, sanitizeMoneyError(e));
  }
}

/** A paid spray: delivered if it still may be, else reversed. Caller holds the reference's advisory lock (c). */
async function deliverOrReverse(c: PoolClient, row: SprayPayment): Promise<FinalizeOutcome> {
  const nowMs = sprayClock.now();
  const paidMs = row.paidAt ? new Date(row.paidAt).getTime() : nowMs;
  if (nowMs - paidMs > DELIVERY_DEADLINE_MS) return reverse(c, row, "TIMEOUT");
  const gate = await sprayGate(row.roomId, row.payerId, row.recipientId, "deliver");
  if (!gate.ok) return reverse(c, row, reversalReasonFor(gate.code));
  const f = gate.facts;
  // The host changed, or the recipient's kind changed (the split was made for the other one): never deliver a wrong split.
  if (f.room.hostId !== row.hostId || (f.kind === "host") !== (row.guestKobo === null)) return reverse(c, row, "NOT_DELIVERABLE");

  let overCap = false;
  try {
    await c.query("BEGIN");
    await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [`spray-ref:${row.providerRef}`]);
    await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [`spray-host:${row.hostId}`]);
    if (await overNewHostCapAtDelivery(c, f.host, row.id, row.amountKobo, nowMs)) {
      overCap = true;
      await c.query("ROLLBACK");
    } else {
      const won = await c.query(
        `update spray_payments set status = 'delivered', delivered_at = $2::timestamp where id = $1 and status = 'paid' returning id`,
        [row.id, iso(nowMs)],
      );
      if (!won.rowCount) { await c.query("ROLLBACK"); return "already"; }
      if (testing() && sprayTestHooks.failDeliveryLedger?.(row.id)) throw new Error("injected ledger failure (test)");
      await c.query(
        `insert into payment_transactions (type, provider, provider_payment_id, currency, buyer_user_id, organizer_id, ticket_id,
                                           gross_amount, platform_fee_amount, net_to_organizer_amount, status, created_at)
         select 'spray', $1::text, $2::text, 'NGN', $3::varchar, $4::varchar, $5::varchar, $6::int, $7::int, $8::int, 'succeeded', $9::timestamp
          where not exists (select 1 from payment_transactions where type = 'spray' and provider_payment_id = $2::text)`,
        [row.provider, row.providerRef, row.payerId, row.hostId, row.id, row.amountKobo, row.platformKobo,
          row.hostKobo + (row.guestKobo ?? 0), iso(nowMs)],
      );
      await c.query("COMMIT");
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e; // nothing was written: the webhook answers 500, the sweep tries again
  }
  if (overCap) return reverse(c, row, "HOST_CAP");
  logSpray(row.providerRef, "delivered");
  announceDelivery(row, f);
  return "delivered";
}

/** After the commit, never the source of truth: a failure here never undoes the delivery. */
function announceDelivery(row: SprayPayment, f: SprayFacts): void {
  try {
    if (testing() && sprayTestHooks.failBroadcast?.(row.id)) throw new Error("injected broadcast failure (test)");
    const tier = row.tier as SprayTier;
    const at = sprayClock.now();
    // Rule B13: ids exactly as members appear in room:state (user ids), the tier and its V3C label value. Nothing else.
    roomHub.broadcast(row.roomId, { type: "room:spray", id: row.id, tier, v3c: SPRAY_CATALOGUE[tier].v3c, fromId: row.payerId, toId: row.recipientId, at });
    const name = f.recipient.displayName || f.recipient.username || "them";
    const text = tier === "rain" ? `made it rain on ${name}` : `sprayed ${name} a ${SPRAY_CATALOGUE[tier].label.toLowerCase()}`;
    // A server-made chat line (the client never invents one). Not quotable: it is not something the payer typed.
    roomHub.recordChat(row.roomId, { userId: row.payerId, text, at, quotable: false });
    roomHub.broadcast(row.roomId, { type: "room:chat", userId: row.payerId, text, at, system: "spray" });
  } catch (e) {
    console.error(`[rooms:spray] ref=${sprayReferenceForLog(row.providerRef)} delivered, but the announcement failed:`, sanitizeMoneyError(e));
  }
}

/** paid -> reversing (only the caller that wins it refunds), then the provider refund. */
async function reverse(c: PoolClient, row: SprayPayment, reason: StoredReason): Promise<FinalizeOutcome> {
  const nowMs = sprayClock.now();
  const won = await ss.markSprayStatus(row.id, ["paid"], "reversing", { reason, refundRequestedAt: new Date(nowMs) });
  if (!won) return "already";
  logSpray(row.providerRef, `reversing:${reason}`);
  await continueReversal(c, won);
  return "reversed";
}

/** Paystack answered and refused, as opposed to an outage. */
const isRefusalAnswer = (e: unknown) => (e instanceof Error ? e.message : "").startsWith("Paystack error");

/**
 * The provider half of a reversal (row in 'reversing'). Lookup first: a refund that already exists is never sent again,
 * and a lookup that fails sends nothing (fail closed, the sweep retries). 'reversed' only once the provider says processed.
 */
export async function continueReversal(c: PoolClient, row: SprayPayment): Promise<"reversed" | "reversing"> {
  const provider = getSplitProvider();
  const now = new Date(sprayClock.now());
  const issue = (error: string) => openPaymentIssue(c, { ticketId: null, providerRef: row.providerRef, provider: row.provider, reason: "refund_failed", error, now }).catch(() => false);
  let state: Awaited<ReturnType<typeof provider.refundState>>;
  try { state = await provider.refundState(row.providerRef); }
  catch (e) { logSpray(row.providerRef, "refund_lookup_failed", sanitizeMoneyError(e)); return "reversing"; }
  if (state === "done") return confirmReversed(c, row);
  if (state === "in_progress") return "reversing";
  if (state === "needs_attention") { await issue("SPRAY_REFUND_NEEDS_ATTENTION: the provider flagged this refund for review"); return "reversing"; }
  if (state === "failed") await issue("SPRAY_REFUND_FAILED_AT_PROVIDER: an earlier refund failed at the provider; trying again");
  try { await provider.refund(row.providerRef); }
  catch (e) {
    const msg = sanitizeMoneyError(e);
    logSpray(row.providerRef, isRefusalAnswer(e) ? "refund_rejected" : "refund_no_answer", msg);
    if (isRefusalAnswer(e)) await issue(`SPRAY_REFUND_REJECTED: ${msg}`);
    return "reversing";
  }
  const after = await provider.refundState(row.providerRef).catch(() => "in_progress" as const);
  if (after === "done") return confirmReversed(c, row);
  if (after === "needs_attention") await issue("SPRAY_REFUND_NEEDS_ATTENTION: the provider flagged this refund for review");
  return "reversing";
}

/** reversing -> reversed and the spray_refund ledger row in ONE transaction; then the spend back and the payer told. */
async function confirmReversed(c: PoolClient, row: SprayPayment): Promise<"reversed" | "reversing"> {
  const nowMs = sprayClock.now();
  let won = false;
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `update spray_payments set status = 'reversed', reversed_at = $2::timestamp where id = $1 and status = 'reversing' returning id`,
      [row.id, iso(nowMs)],
    );
    won = !!r.rowCount;
    if (won) {
      await c.query(
        `insert into payment_transactions (type, provider, provider_payment_id, currency, buyer_user_id, organizer_id, ticket_id,
                                           gross_amount, platform_fee_amount, net_to_organizer_amount, status, created_at)
         select 'spray_refund', $1::text, $2::text, 'NGN', $3::varchar, $4::varchar, $5::varchar, $6::int, $7::int, $8::int, 'refunded', $9::timestamp
          where not exists (select 1 from payment_transactions where type = 'spray_refund' and provider_payment_id = $2::text)`,
        [row.provider, row.providerRef, row.payerId, row.hostId, row.id, row.amountKobo, row.platformKobo,
          row.hostKobo + (row.guestKobo ?? 0), iso(nowMs)],
      );
      await c.query(
        `update payment_issues set resolved_at = $2::timestamp where provider_payment_id = $1 and reason in ('refund_failed', 'refund_pending', 'refund_overdue') and resolved_at is null`,
        [row.providerRef, iso(nowMs)],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    logSpray(row.providerRef, "refund_processed_bookkeeping_failed", sanitizeMoneyError(e));
    return "reversing"; // the provider has the refund; the next pass confirms again
  }
  if (!won) return "reversed";
  logSpray(row.providerRef, `reversed:${row.reason ?? "?"}`);
  // A late payment's reservation was already given back when it failed.
  if (row.reason !== "LATE_PAYMENT") {
    await ss.releaseSpend(row.roomId, row.payerId, row.amountKobo).catch((e) => console.error("[rooms:spray] releasing spend failed:", sanitizeMoneyError(e)));
  }
  await tellPayerReversed(row);
  return "reversed";
}

/** Payer only: a chat line if they are still in that room, and a notification. Never throws. */
async function tellPayerReversed(row: SprayPayment): Promise<void> {
  const text = REVERSAL_TEXT[row.reason ?? ""] ?? REVERSAL_DEFAULT;
  try {
    if (roomHub.roomOf(row.payerId) === row.roomId) {
      roomHub.sendTo(row.payerId, { type: "room:chat", userId: row.payerId, text, at: sprayClock.now(), system: "spray_reversed" });
    }
  } catch { /* best effort */ }
  try {
    await deliverNotification({
      userId: row.payerId, type: "spray_reversed", title: "Your spray was refunded", message: text,
      link: `/rooms/${row.roomId}`, relatedEntityId: `spray-reversed-${row.id}`,
    });
  } catch (e) {
    console.error(`[rooms:spray] ref=${sprayReferenceForLog(row.providerRef)} reversal notification failed:`, sanitizeMoneyError(e));
  }
}

// ---------------------------------------------------------------- webhook entry
/**
 * Paystack charge.success for a spray-shaped reference (signature already checked by the route). Nothing in the payload is
 * trusted: finalizeSpray re-verifies with the provider and checks the MAC against the stored row. A reference with no row
 * answers 200 and does nothing. Throws for anything transient (provider outage, a busy reference), so the route answers 500
 * and Paystack retries.
 */
export async function handleSprayChargeWebhook(reference: string): Promise<void> {
  const out = await finalizeSpray(reference);
  if (out === "busy") throw new Error("spray reference is busy; retry the webhook");
  if (out === "unknown") logSpray(reference, "webhook_ignored");
}

// ---------------------------------------------------------------- reads
/** For the payer only: { status, reason? }. Never the reference, amounts beyond the tier, or card data. */
export function sprayStatusView(row: SprayPayment): { status: "pending" | "action_required" | "delivered" | "reversed" | "failed"; reason?: string } {
  const s = row.status as SprayStatus;
  const reason = shownReason(row.reason);
  const status = s === "delivered" ? "delivered"
    : s === "reversed" ? "reversed"
    : s === "failed" ? "failed"
    : s === "disputed" ? "reversed"
    : "pending";
  return { status, ...(s === "disputed" ? { reason: "DISPUTED" } : reason && status !== "delivered" ? { reason } : {}) };
}

/** GET /api/rooms/:id/spray/:sprayId: the payer's own spray in this room, else null (the route answers 404). */
export async function getOwnSpray(roomId: string, sprayId: string, payerId: string): Promise<SprayPayment | null> {
  if (!isUuid(sprayId)) return null;
  const row = await ss.getSprayById(sprayId);
  return row && row.payerId === payerId && row.roomId === roomId ? row : null;
}

/**
 * The `spray` block of GET /api/rooms/:id, or null (the key is then absent). Only for a viewer who passes payer
 * eligibility for a live, money-eligible room (rule: never `enabled: false`). targets: user ids that are spray-eligible now.
 */
export async function sprayBlockFor(room: Room, viewerId: string): Promise<{ enabled: true; roomLimitKobo: number; roomSpentKobo: number; targets: string[] } | null> {
  if (!roomFeatures.spray || room.status !== "live" || !moneyEligibleRoom(room) || roomHub.isMinorsRoom(room.id)) return null;
  if (!roomHub.get(room.id, viewerId)) return null;
  const candidates = new Set<string>();
  if (roomHub.get(room.id, room.hostId)) candidates.add(room.hostId);
  for (const m of roomHub.members(room.id)) if (m.role === "cohost") candidates.add(m.userId);
  for (const id of roomHub.stageOf(room.id).stage) candidates.add(id);
  candidates.delete(viewerId);
  // Payer eligibility: checked against the host as the recipient but only the payer and room codes decide. If the viewer is
  // the host, against anyone (the payer and room rules do not depend on who).
  const probe = viewerId === room.hostId ? Array.from(candidates)[0] : room.hostId;
  if (!probe) return null;
  const p = await sprayGate(room.id, viewerId, probe, "start");
  const payerCodes: Array<SprayCode | "SERVER_RULE"> = ["FEATURE_OFF", "PAYER_NOT_VERIFIED", "ROOM_NOT_ELIGIBLE", "ROOM_NOT_LIVE", "PAYER_NOT_IN_ROOM", "HOST_NOT_PAYABLE", "SERVER_RULE"];
  if (!p.ok && payerCodes.includes(p.code)) return null;
  const targets: string[] = [];
  for (const id of Array.from(candidates)) {
    const g = id === probe ? p : await sprayGate(room.id, viewerId, id, "start");
    if (g.ok) targets.push(id);
  }
  const lim = await roomLimitFor(room.id, viewerId);
  return { enabled: true, roomLimitKobo: lim.limitKobo, roomSpentKobo: lim.spentKobo, targets };
}
