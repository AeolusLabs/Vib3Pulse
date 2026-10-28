// Team spray (rooms gaming, team-spray-design.md): ONE charge for a whole team, split by Paystack at charge time to every
// player's subaccount and the host's. The single-spray engine's rules (spray.ts header, revisions section B) apply to the
// letter; this file is that engine for a batch, never a second set of rules:
//  - No oracle: every eligibility failure about the payer, the room, the host or ANY player is the one 403 SPRAY_UNAVAILABLE.
//    Only payer-owned facts get their own codes, checked FIRST from the payer's own data (payerPrecheck).
//  - Reserve first: one per-payer critical section (the same queue and pg_advisory_xact_lock as a single spray) re-checks
//    the key, velocity, in-flight, the daily and room limits, then (under the 'spray-recv' locks of the host and every player,
//    id order) the new-host receive cap and the receive ban, reserves the room spend and inserts the batch row and one
//    spray_payments row per share, all in ONE transaction. Only then is the provider called.
//  - One charge, one delivery: finalize is spray.ts's finalizeSpray (same queue, same advisory lock on the batch reference);
//    a batch and its shares change status together, conditionally.
//  - Owner rules 2026-10-22: no refund of our own anywhere. A charge that went through is DELIVERED (ledger rows written) even
//    if the room ended, a player left or the 60 s deadline passed: the money reached the subaccounts at charge time, and if
//    it did not arrive the PSP returns it. Only the integrity guards still reverse (amount / currency mismatch, a late
//    payment for an already failed charge, the new-host cap at delivery). Q2 (a): a player who drops out after the spray
//    started keeps their share (the split is fixed at init); only players already gone at init are left out. Q4: a payer on
//    the sprayed team is refused (the generic answer).
//  - Secrets: subaccount codes go only to the provider and the batch / share rows; never to a client, never to a log.
import crypto from "crypto";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { db, storage } from "../storage";
import type { SprayBatch, SprayPayment } from "@shared/schema";
import { SPRAY_CATALOGUE, isSprayTier, teamSprayBreakdown, teamSprayTiers, type SprayTier } from "@shared/money";
import { DELIVERY_DEADLINE_MS, idempotencyKeyShape, requiresThreeDs, type SprayStatus } from "@shared/spray";
import { type Side } from "@shared/gameScreen";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import { getSplitProvider, type ChargeResult, type SplitSpec, type SplitVerifyResult } from "../payments/splitProvider";
import { decryptToken } from "../payments/tokenCrypto";
import { makeSprayReference, sprayReferenceForLog, sprayReferenceSecret } from "../payments/sprayReference";
import { deliverNotification } from "../notifications";
import { notifySprayReceived } from "./notify";
import * as ss from "./sprayStorage";
import * as bs from "./sprayBatchStorage";
import { recordBatchTransition } from "./sprayEvents";
import { roomHub } from "./RoomHub";
import { roomFeatures } from "./features";
import { sprayAllowed } from "./roomControls";
import { getRates } from "./roomRates";
import { ticketCheckoutBaseUrl } from "./checkoutUrl";
import { QueueFullError } from "./keyedQueue";
import { openPaymentIssue } from "./refunds";
import {
  CAP_STATUSES_AT_DELIVERY, CAP_STATUSES_AT_START, capLockKey, checkVelocity, clawbackBlockThresholdKobo, dailyWindowStart,
  effectiveDailyLimit, hasSprayInFlight, isNewHost, newHostReceiveCapKobo, payerPrecheck, roomLimitFor, windowStart,
} from "./sprayLimits";
import { isGamePlayer } from "./stage";
import { registerBatchFinalizer } from "./sprayBatchHook";
import {
  REVERSAL_DEFAULT, REVERSAL_TEXT, SPRAY_UNAVAILABLE, finalizeSpray, maybeSaveCard, runForPayer,
  shownReason, sprayClock, sprayGate, type FinalizeOpts, type FinalizeOutcome, type SprayFacts, type StoredReason,
} from "./spray";

const PROVIDER_NAME = "paystack";
const iso = (ms: number) => new Date(ms).toISOString();
const testing = () => process.env.NODE_ENV !== "production";

/** Reference prefix, ids and an outcome only (the spray.ts rule). Never an amount beyond the tier, a subaccount or an email. */
function logBatch(reference: string, outcome: string, extra = ""): void {
  console.log(`[rooms:spray] team ref=${sprayReferenceForLog(reference)} outcome=${outcome}${extra ? ` ${extra}` : ""}`);
}

export const teamRequestHash = (roomId: string, tier: string, side: string): string =>
  crypto.createHash("sha256").update(`${roomId}|${tier}|team:${side}`).digest("hex");

// ---------------------------------------------------------------- answers (the single spray's codes and words)
export interface TeamOutcome { status: number; body: Record<string, unknown>; retryAfterSec?: number }
const unavailable = (): TeamOutcome => ({ status: 403, body: { ...SPRAY_UNAVAILABLE } });
const badRequest = (): TeamOutcome => ({ status: 400, body: { code: "BAD_REQUEST", message: "That spray request is not valid." } });
const rateLimited = (sec: number): TeamOutcome => ({ status: 429, retryAfterSec: sec, body: { code: "RATE_LIMITED", message: "You're spraying too fast. Please wait a moment." } });
const dailyLimit = (): TeamOutcome => ({ status: 409, body: { code: "DAILY_LIMIT", message: "This would go over your daily spray limit." } });
const roomLimit = (): TeamOutcome => ({ status: 409, body: { code: "ROOM_LIMIT", message: "This would go over your limit for this room." } });
const declined = (batchId: string, reason: string): TeamOutcome => ({ status: 402, body: { code: "PAYMENT_DECLINED", batchId, reason, message: "Your card was not charged." } });

/** What the payer is shown about their team spray: never a reference, a subaccount or anyone's cut, only gross shares. */
function view(b: SprayBatch, shares: SprayPayment[]) {
  return { batchId: b.id, tier: b.tier, amountKobo: b.amountKobo, shares: shares.map((s) => ({ userId: s.recipientId, amountKobo: s.amountKobo })) };
}
const ok = async (b: SprayBatch, status: "delivered" | "pending" | "action_required", extra: Record<string, unknown> = {}): Promise<TeamOutcome> =>
  ({ status: 200, body: { status, ...view(b, await bs.sharesOf(b.id)), ...extra } });

/** The stored bank page, only while it can still be used (same rule as the single spray). */
function resumableLink(b: SprayBatch, now: number): string | null {
  const url = b.authorizationUrl;
  if (b.status !== "pending" || typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url) || url.length > 2048) return null;
  const created = new Date(b.createdAt).getTime();
  return Number.isFinite(created) && now - created < 10 * 60_000 ? url : null;
}

/** A key used before: the first result, from the row. Never a second charge, never a fresh eligibility answer. */
async function replay(b: SprayBatch, requestHash: string): Promise<TeamOutcome> {
  if (b.requestHash !== requestHash) return { status: 409, body: { code: "IDEMPOTENCY_MISMATCH", message: "That spray was already sent with different details." } };
  const status = b.status as SprayStatus;
  if (status === "failed") return declined(b.id, shownReason(b.reason) ?? "DECLINED");
  if (status === "delivered") return ok(b, "delivered");
  const link = resumableLink(b, sprayClock.now());
  if (link) return ok(b, "action_required", { authorizationUrl: link });
  const reason = shownReason(b.reason);
  return ok(b, "pending", reason ? { reason } : {});
}

// ---------------------------------------------------------------- start (POST /api/rooms/:id/spray/team)
export interface TeamStartInput { roomId: string; payerId: string; body: unknown; devOrigin: string }

type Reservation =
  | { kind: "created"; batch: SprayBatch }
  | { kind: "replay"; batch: SprayBatch }
  | { kind: "velocity"; retryAfterSec: number }
  | { kind: "in_flight" } | { kind: "daily" } | { kind: "room" } | { kind: "cap" } | { kind: "ban" };

export async function startTeamSpray(input: TeamStartInput): Promise<TeamOutcome> {
  const now = sprayClock.now();
  if (!(await sprayAllowed())) return unavailable();
  const b = (input.body && typeof input.body === "object" && !Array.isArray(input.body) ? input.body : {}) as Record<string, unknown>;
  const { tier, side, idempotencyKey } = b;
  const payOther = b.payOther === true; // "pay another way": any Paystack method, one time, never a saved card
  const saveCard = b.saveCard === true && !payOther;
  if (!isSprayTier(tier) || (side !== "A" && side !== "B") || !idempotencyKeyShape(idempotencyKey)
    || (b.saveCard !== undefined && typeof b.saveCard !== "boolean")
    || (b.payOther !== undefined && typeof b.payOther !== "boolean")
    || typeof input.roomId !== "string" || input.roomId.length < 1 || input.roomId.length > 64) {
    return badRequest();
  }
  const { roomId, payerId } = input;
  const requestHash = teamRequestHash(roomId, tier, side);
  const price = SPRAY_CATALOGUE[tier].kobo;

  const prior = await bs.getBatchByPayerKey(payerId, idempotencyKey);
  if (prior) return replay(prior, requestHash);

  // Payer-owned limits, payer data only, before anything about the team (no oracle through 409 / 429). The per-recipient part
  // of velocity / in-flight is about the team as one target here; per player it is checked under the lock below.
  const payerRow = await storage.getUser(payerId);
  if (!payerRow) return unavailable();
  const pre = await payerPrecheck(payerRow, roomId, `team:${side}`, price, now);
  if (!pre.ok) {
    if (pre.kind === "velocity") return rateLimited(pre.retryAfterSec);
    if (pre.kind === "in_flight") return rateLimited(10);
    return pre.kind === "daily" ? dailyLimit() : roomLimit();
  }

  // ---- the team gate: every current player must pass the single spray's gate; any failure is the one generic answer
  const refuse = (code: string) => { console.log(`[rooms:spray] team start refused room=${roomId} payer=${payerId} code=${code}`); return unavailable(); };
  if (!roomFeatures.gaming || !roomHub.gameOn(roomId)) return refuse("NO_GAME");
  const game = roomHub.gameOf(roomId);
  const team = game.teams[side as Side];
  if (team.includes(payerId)) return refuse("PAYER_ON_TEAM"); // owner Q4
  // Players already gone (dropped out: away, or no longer in the game) at init are not in the split (owner Q2 a).
  const present = team.filter((id) => isGamePlayer(roomId, id) && !roomHub.get(roomId, id)?.away);
  if (present.length === 0) return refuse("EMPTY_TEAM");
  if (!teamSprayTiers(present.length).includes(tier)) return refuse("BELOW_TEAM_MINIMUM");
  const facts = new Map<string, SprayFacts>();
  for (const id of present) {
    const g = await sprayGate(roomId, payerId, id, "start");
    if (!g.ok) return refuse(g.code); // never skip a player silently: one ineligible player = no team spray
    facts.set(id, g.facts);
  }
  const first = facts.get(present[0])!;
  const hostId = first.room.hostId;
  if (Array.from(facts.values()).some((f) => f.room.hostId !== hostId || f.hostSubaccount !== first.hostSubaccount)) return refuse("SERVER_RULE");
  if (!first.payer.email) return unavailable();

  // ---- the split, fixed here, once (the saved rates at this moment, stored on the rows; never recomputed). The owner's order:
  // the whole charge's deductions first, then the pool split equally into the players' subaccounts (teamSprayBreakdown).
  const featured = game.featured[side as Side];
  const featuredId = featured && present.includes(featured) ? featured : null;
  let bd: ReturnType<typeof teamSprayBreakdown>;
  try { bd = teamSprayBreakdown(tier, present.map((id) => ({ userId: id, isHost: id === hostId })), featuredId, await getRates()); }
  catch (e) { console.error("[rooms:spray] team split could not be made:", sanitizeMoneyError(e)); return unavailable(); } // fail closed
  const bySub = new Map<string, number>();
  const add = (code: string, kobo: number) => bySub.set(code, (bySub.get(code) ?? 0) + kobo);
  for (const p of bd.shares) add(p.isHost ? first.hostSubaccount : facts.get(p.userId)!.recipientSubaccount, p.recipient);
  add(first.hostSubaccount, bd.whole.host); // the host's % (merged into the host's own entry when the host plays)
  const entries = Array.from(bySub.entries()).filter(([, k]) => k > 0).map(([subaccountCode, amountKobo]) => ({ subaccountCode, amountKobo }));
  if (!entries.length || !entries.every((s) => Number.isSafeInteger(s.amountKobo) && s.amountKobo > 0)
    || entries.reduce((a, s) => a + s.amountKobo, 0) > price) return unavailable();
  const split: SplitSpec = entries.length >= 2 ? { shares: entries, team: true } : { shares: entries };

  let reference: string;
  try { reference = makeSprayReference(roomId, payerId, tier, `team:${side}`, sprayReferenceSecret()); }
  catch (e) {
    console.error("[rooms:spray] no reference secret; refusing:", sanitizeMoneyError(e));
    return { status: 500, body: { code: "SERVER_ERROR", message: "Spraying isn't working right now. Try again later." } };
  }

  // Everyone the money reaches, in id order (the lock order), with what this charge adds to each (the cap counts every share
  // row where they are the recipient or the host: the host gets the whole price, a player their share).
  const people = Array.from(new Map([[hostId, first.host], ...present.map((id) => [id, facts.get(id)!.recipient] as const)]).values())
    .sort((a, b2) => (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0));
  const adds = (id: string) => (id === hostId ? price : bd.shares.find((p) => p.userId === id)!.gross);

  let reserved: Reservation;
  try {
    reserved = await runForPayer(payerId, () => db.transaction(async (tx): Promise<Reservation> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`spray-daily:${payerId}`}))`);
      const again = await bs.getBatchByPayerKey(payerId, idempotencyKey, tx);
      if (again) return { kind: "replay", batch: again };
      for (const id of present) {
        const vel = await checkVelocity(payerId, id, now, tx);
        if (!vel.ok) return { kind: "velocity", retryAfterSec: vel.retryAfterSec };
      }
      for (const id of present) if (await hasSprayInFlight(payerId, id, now, tx)) return { kind: "in_flight" };
      const spent = await ss.sumPayerKoboSince(tx, payerId, dailyWindowStart(now));
      if (spent + price > effectiveDailyLimit(first.payer)) return { kind: "daily" };
      const limit = await roomLimitFor(roomId, payerId, tx);
      if (limit.spentKobo + price > limit.limitKobo) return { kind: "room" };
      for (const u of people) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${capLockKey(u.id)}))`);
      const cap = newHostReceiveCapKobo();
      for (const u of people) {
        if (!isNewHost(u, now)) continue;
        if ((await ss.sumReceivedSince(u.id, windowStart(u), CAP_STATUSES_AT_START, null, tx)) + adds(u.id) > cap) return { kind: "cap" };
      }
      if (await ss.receiveBlocked(people.map((u) => u.id), clawbackBlockThresholdKobo(), tx)) return { kind: "ban" };
      if (!(await ss.addSpend(roomId, payerId, price, limit.limitKobo, tx))) return { kind: "room" };
      const batch = await bs.insertBatchIfNew({
        idempotencyKey, requestHash, roomId, hostId, payerId, featuredId: featuredId ?? present[0],
        side, tier, amountKobo: price, vatKobo: bd.whole.vat, feeKobo: bd.whole.paystackFee, reserveKobo: bd.whole.reserve,
        hostSubaccount: first.hostSubaccount, provider: PROVIDER_NAME, providerRef: reference, status: "created",
      }, tx);
      if (!batch) throw new Error("team spray batch conflicted under the payer lock"); // roll back the spend; the retry replays
      // One share row per player, DERIVED key and reference (both unique per payer / globally; the reference is never sent
      // to the provider and never looks like a spray reference, so finalize and verify refuse it on its own).
      for (let i = 0; i < bd.shares.length; i++) {
        const p = bd.shares[i];
        const f = facts.get(p.userId)!;
        const ins = await ss.insertSprayIfNew({
          idempotencyKey: `${idempotencyKey}:${i}`, requestHash, roomId, hostId, payerId, recipientId: p.userId, tier,
          v3c: p.gross, amountKobo: p.gross, vatKobo: p.vat, feeKobo: p.paystackFee, reserveKobo: p.reserve, platformKobo: p.platform,
          // the host who plays keeps their equal share as host money (host_kobo, guest null), as a host spray row does
          hostKobo: p.isHost ? p.host + p.recipient : p.host, guestKobo: p.isHost ? null : p.recipient,
          provider: PROVIDER_NAME, providerRef: `${reference}.${i}`, status: "created",
          batchId: batch.id, recipientSubaccount: p.isHost ? first.hostSubaccount : f.recipientSubaccount,
        }, tx);
        if (!ins.created) throw new Error("team spray share conflicted under the payer lock");
      }
      return { kind: "created", batch };
    }));
  } catch (e) {
    if (e instanceof QueueFullError) return rateLimited(2);
    throw e;
  }

  switch (reserved.kind) {
    case "replay": return replay(reserved.batch, requestHash);
    case "velocity": return rateLimited(reserved.retryAfterSec);
    case "in_flight": return rateLimited(10);
    case "daily": return dailyLimit();
    case "room": return roomLimit();
    case "cap": return refuse("NEW_HOST_CAP");
    case "ban": return refuse("RECEIVE_BAN");
    case "created": break;
  }
  const batch = reserved.batch;
  logBatch(reference, "created", `room=${roomId} payer=${payerId} tier=${tier} players=${present.length}`);
  return chargeBatch(batch, first.payer.email, tier, saveCard, split, input.devOrigin, payOther);
}

async function failUnpaidBatch(b: SprayBatch, from: SprayStatus[], reason: StoredReason): Promise<boolean> {
  const won = await bs.markBatchStatus(b.id, from, "failed", { reason });
  if (won) await ss.releaseSpend(b.roomId, b.payerId, b.amountKobo).catch((e) => console.error("[rooms:spray] releasing spend failed:", sanitizeMoneyError(e)));
  return !!won;
}

async function chargeBatch(b: SprayBatch, email: string, tier: SprayTier, saveCard: boolean, split: SplitSpec, devOrigin: string, payOther = false): Promise<TeamOutcome> {
  const reference = b.providerRef;
  const metadata: Record<string, string> = { type: "spray", batchId: b.id, roomId: b.roomId, payerId: b.payerId, tier, side: b.side, saveCard: saveCard ? "1" : "0" };
  const base = ticketCheckoutBaseUrl(process.env, devOrigin);
  if (!base) {
    console.error(`[rooms:spray] room=${b.roomId} outcome=no_app_url (set APP_URL to the site's https origin)`);
    await failUnpaidBatch(b, ["created"], "NETWORK");
    return { status: 500, body: { code: "SERVER_ERROR", message: "Payment couldn't be started. Try again." } };
  }
  const callbackUrl = `${base}/rooms/${encodeURIComponent(b.roomId)}?sprayTeam=${encodeURIComponent(b.id)}`;
  let provider: ReturnType<typeof getSplitProvider>;
  try { provider = getSplitProvider(); }
  catch (e) {
    console.error("[rooms:spray] no payment provider:", sanitizeMoneyError(e));
    await failUnpaidBatch(b, ["created"], "NETWORK");
    return declined(b.id, "NETWORK");
  }

  let method: Awaited<ReturnType<typeof ss.getSavedMethod>> = null;
  let authorizationCode: string | null = null;
  if (!requiresThreeDs(tier) && !payOther) {
    method = await ss.getSavedMethod(b.payerId);
    if (method) {
      try { authorizationCode = decryptToken(method.authEnc); }
      catch { authorizationCode = null; console.error(`[rooms:spray] payer=${b.payerId} saved card could not be read; using checkout`); }
    }
  }

  if (!authorizationCode) {
    try {
      const { url } = await provider.startFirstPayment({ reference, email, amountKobo: b.amountKobo, split, metadata, callbackUrl, ...(payOther ? { anyMethod: true } : {}) });
      const now = await bs.markBatchStatus(b.id, ["created"], "pending", { authorizationUrl: url });
      logBatch(reference, "action_required");
      return ok(now ?? b, "action_required", { authorizationUrl: url });
    } catch (e) {
      console.error(`[rooms:spray] team ref=${sprayReferenceForLog(reference)} checkout could not start:`, sanitizeMoneyError(e));
      await failUnpaidBatch(b, ["created"], "NETWORK");
      return declined(b.id, "NETWORK");
    }
  }

  let result: ChargeResult;
  try {
    result = await provider.chargeSaved({ reference, email, amountKobo: b.amountKobo, authorizationCode, split, metadata, force3ds: false, callbackUrl });
  } catch (e) {
    console.error(`[rooms:spray] team ref=${sprayReferenceForLog(reference)} charge got no answer:`, sanitizeMoneyError(e));
    result = { status: "failed", reference, failure: "NETWORK" };
  } finally {
    authorizationCode = null;
  }

  if (result.status === "action_required") {
    const now = await bs.markBatchStatus(b.id, ["created"], "pending", { paymentMethodId: method?.id ?? null, authorizationUrl: result.authorizationUrl ?? null });
    logBatch(reference, "action_required");
    return result.authorizationUrl ? ok(now ?? b, "action_required", { authorizationUrl: result.authorizationUrl }) : ok(now ?? b, "pending");
  }
  if (result.status === "failed" && result.failure && result.failure !== "NETWORK") {
    await failUnpaidBatch(b, ["created"], result.failure);
    logBatch(reference, `failed:${result.failure}`);
    return declined(b.id, result.failure);
  }
  await bs.markBatchStatus(b.id, ["created"], "pending", { paymentMethodId: method?.id ?? null });
  let out: FinalizeOutcome;
  try { out = await finalizeSpray(reference); }
  catch (e) {
    console.error(`[rooms:spray] team ref=${sprayReferenceForLog(reference)} finalize after charge failed, the sweep will finish it:`, sanitizeMoneyError(e));
    out = "pending";
  }
  const now = (await bs.getBatchById(b.id)) ?? b;
  if (out === "delivered" || now.status === "delivered") return ok(now, "delivered");
  if (now.status === "failed") return declined(b.id, shownReason(now.reason) ?? "DECLINED");
  const reason = shownReason(now.reason);
  return ok(now, "pending", reason ? { reason } : {});
}

// ---------------------------------------------------------------- finalize (inside finalizeSpray's lock on the reference)
function verifiedMatches(b: SprayBatch, v: SplitVerifyResult): boolean {
  return v.paid === true && Number.isSafeInteger(v.amountKobo) && v.amountKobo === b.amountKobo && typeof v.currency === "string" && v.currency.toUpperCase() === "NGN";
}

async function finalizeBatchLocked(c: PoolClient, b: SprayBatch, opts: FinalizeOpts): Promise<FinalizeOutcome> {
  const status = b.status as SprayStatus;
  const reference = b.providerRef;
  if (status === "delivered" || status === "reversed" || status === "disputed") return "already";
  if (status === "reversing") return continueBatchReversal(c, b);
  if (status === "paid") return deliverBatch(c, b);
  const v = await getSplitProvider().verify(reference); // throws on an outage: never treated as unpaid
  if (status === "failed") {
    if (v && v.paid) {
      const nowMs = sprayClock.now();
      const won = await toReversingBatch(b, ["failed"], "LATE_PAYMENT", { paidAt: new Date(nowMs), refundRequestedAt: new Date(nowMs) });
      if (won) { logBatch(reference, "late_payment:reversing"); return continueBatchReversal(c, won); }
    }
    return "already";
  }
  if (!v || !v.paid) {
    const expired = opts.expireUnpaid === true || (!!v && v.state === "failed");
    if (expired && (await failUnpaidBatch(b, ["created", "pending"], opts.expireUnpaid ? "TIMEOUT" : "DECLINED"))) {
      logBatch(reference, opts.expireUnpaid ? "failed:expired" : "failed:declined");
      return "already";
    }
    return "pending";
  }
  const nowMs = sprayClock.now();
  if (!verifiedMatches(b, v)) {
    const won = await toReversingBatch(b, ["created", "pending"], "AMOUNT_MISMATCH", { paidAt: new Date(nowMs), refundRequestedAt: new Date(nowMs) });
    if (won) { logBatch(reference, "amount_mismatch:reversing"); return continueBatchReversal(c, won); }
    return "already";
  }
  const paid = await bs.markBatchStatus(b.id, ["created", "pending"], "paid", { paidAt: new Date(nowMs) });
  if (!paid) return "already";
  logBatch(reference, "paid");
  await maybeSaveCard(paid, v);
  return deliverBatch(c, paid);
}

/**
 * A paid batch is DELIVERED (owner rule 2026-10-22: the money already reached the subaccounts at charge time, so a charge that
 * went through is never undone for a delivery problem; if the money did not arrive, the PSP returns it, not us). The only
 * thing the room state decides is whether the animation is shown: when the room ended, the host left or the deadline passed
 * with nobody to see it, the batch is still marked delivered and the ledger rows are written, with no broadcast. A recipient
 * that merely looks absent in this process's hub is waited for until the deadline. The one thing still refused is the
 * new-host receive cap (an integrity guard, kept; listed in the report). Individual players are never re-checked.
 */
async function deliverBatch(c: PoolClient, b: SprayBatch): Promise<FinalizeOutcome> {
  const nowMs = sprayClock.now();
  const paidMs = b.paidAt ? new Date(b.paidAt).getTime() : nowMs;
  const pastDeadline = nowMs - paidMs > DELIVERY_DEADLINE_MS;
  const shares = await bs.sharesOf(b.id);
  // The gate needs a recipient: the host (a host spray's checks: room, payer, host, blocks with the host). When the payer is
  // the host, the first player stands in.
  const probe = b.payerId !== b.hostId ? b.hostId : shares.find((s) => s.recipientId !== b.payerId)?.recipientId;
  let show = false;
  if (probe) {
    const gate = await sprayGate(b.roomId, b.payerId, probe, "deliver");
    if (!gate.ok && gate.absentOnly && !pastDeadline) { logBatch(b.providerRef, "waiting:recipient_not_seen"); return "pending"; }
    show = gate.ok && gate.facts.room.hostId === b.hostId;
  }
  if (!show) logBatch(b.providerRef, "delivered_unseen"); // delivered all the same, no animation

  const ids = Array.from(new Set([b.hostId, ...shares.map((s) => s.recipientId)])).sort();
  const users = await Promise.all(ids.map((id) => storage.getUser(id)));
  let refused: StoredReason | null = null;
  try {
    await c.query("BEGIN");
    await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [`spray-ref:${b.providerRef}`]);
    for (const id of ids) await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [capLockKey(id)]);
    // The new-host receive cap at delivery, as overNewHostCapAtDelivery does for a single spray, with this batch's rows left out.
    const cap = newHostReceiveCapKobo();
    for (let i = 0; i < ids.length && !refused; i++) {
      const u = users[i];
      if (!u || !isNewHost(u, nowMs)) continue;
      const r = await c.query(
        `select coalesce(sum(amount_kobo), 0)::bigint as n from spray_payments
          where (recipient_id = $1 or host_id = $1) and created_at >= $2::timestamp and status = any($3::text[]) and batch_id is distinct from $4::uuid`,
        [u.id, windowStart(u).toISOString(), [...CAP_STATUSES_AT_DELIVERY], b.id],
      );
      const add = u.id === b.hostId ? b.amountKobo : shares.filter((s) => s.recipientId === u.id).reduce((a, s) => a + s.amountKobo, 0);
      if (Number(r.rows[0]?.n ?? 0) + add > cap) refused = "HOST_CAP";
    }
    if (refused) {
      await c.query("ROLLBACK");
    } else {
      const won = await c.query(`update spray_batches set status = 'delivered', delivered_at = $2::timestamp where id = $1 and status = 'paid' returning id`, [b.id, iso(nowMs)]);
      if (!won.rowCount) { await c.query("ROLLBACK"); return "already"; }
      await c.query(`update spray_payments set status = 'delivered', delivered_at = $2::timestamp where batch_id = $1 and status = 'paid'`, [b.id, iso(nowMs)]);
      await recordBatchTransition(b, shares.map((s) => s.id), "paid", "delivered", null, c);
      for (const s of shares) {
        await c.query(
          `insert into payment_transactions (type, provider, provider_payment_id, currency, buyer_user_id, organizer_id, ticket_id,
                                             gross_amount, platform_fee_amount, net_to_organizer_amount, status, created_at)
           select 'spray', $1::text, $2::text, 'NGN', $3::varchar, $4::varchar, $5::varchar, $6::int, $7::int, $8::int, 'succeeded', $9::timestamp
            where not exists (select 1 from payment_transactions where type = 'spray' and provider_payment_id = $2::text)`,
          [s.provider, s.providerRef, s.payerId, s.hostId, s.id, s.amountKobo, s.platformKobo, s.hostKobo + (s.guestKobo ?? 0), iso(nowMs)],
        );
      }
      await c.query("COMMIT");
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e; // nothing was written: the webhook answers 500, the sweep tries again
  }
  if (refused) return reverseBatch(c, b, refused);
  logBatch(b.providerRef, "delivered", `shares=${shares.length}`);
  if (show) announceBatch(b, shares);
  // Phase 6 notifications: the host's total and each player's own cut, batched per (person, room), never naming the payer.
  const hostTotal = shares.reduce((a, s) => a + s.hostKobo, 0);
  if (hostTotal > 0) void notifySprayReceived(b.hostId, b.roomId, hostTotal, b.id);
  for (const s of shares) if (s.recipientId !== b.hostId && (s.guestKobo ?? 0) > 0) void notifySprayReceived(s.recipientId, b.roomId, s.guestKobo as number, s.id);
  return "delivered";
}

/** After the commit, never the source of truth: one room:spray per share (same shape as a single spray) and one system line. */
function announceBatch(b: SprayBatch, shares: SprayPayment[]): void {
  try {
    if (testing() && (globalThis as { __failTeamBroadcast?: boolean }).__failTeamBroadcast) throw new Error("injected broadcast failure (test)");
    const tier = b.tier as SprayTier;
    const at = sprayClock.now();
    for (const s of shares) roomHub.broadcast(b.roomId, { type: "room:spray", id: s.id, tier, v3c: s.amountKobo, fromId: b.payerId, toId: s.recipientId, at });
    const text = tier === "rain" ? `made it rain on team ${b.side}` : `sprayed team ${b.side} a ${SPRAY_CATALOGUE[tier].label.toLowerCase()}`;
    roomHub.broadcast(b.roomId, { type: "room:chat", userId: b.payerId, text, at, system: "spray" }); // not recorded in the chat ring
  } catch (e) {
    console.error(`[rooms:spray] team ref=${sprayReferenceForLog(b.providerRef)} delivered, but the announcement failed:`, sanitizeMoneyError(e));
  }
}

// ---------------------------------------------------------------- reversal (the engine's existing automatic path, per batch)
/** Batch + shares to 'reversing' and, in the same transaction, the reversal clawbacks of every share (as toReversing). */
async function toReversingBatch(b: SprayBatch, from: SprayStatus[], reason: StoredReason, patch: bs.BatchStatusPatch = {}): Promise<SprayBatch | null> {
  return db.transaction(async (tx) => {
    const shares = await bs.sharesOf(b.id, tx);
    const ids = Array.from(new Set([b.hostId, ...shares.map((s) => s.recipientId)])).sort();
    for (const id of ids) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${capLockKey(id)}))`);
    const won = await bs.markBatchStatus(b.id, from, "reversing", { ...patch, reason }, tx);
    if (!won) return null;
    for (const s of shares) {
      if (s.hostKobo > 0) await ss.insertClawbackIfNew({ hostId: s.hostId, beneficiaryId: s.hostId, sprayId: s.id, amountKobo: s.hostKobo, origin: "reversal" }, tx);
      const guest = s.guestKobo ?? 0;
      if (guest > 0 && s.recipientId !== s.hostId) await ss.insertClawbackIfNew({ hostId: s.hostId, beneficiaryId: s.recipientId, sprayId: s.id, amountKobo: guest, origin: "reversal" }, tx);
    }
    return won;
  });
}

async function reverseBatch(c: PoolClient, b: SprayBatch, reason: StoredReason): Promise<FinalizeOutcome> {
  const won = await toReversingBatch(b, ["paid"], reason, { refundRequestedAt: new Date(sprayClock.now()) });
  if (!won) return "already";
  logBatch(b.providerRef, `reversing:${reason}`);
  return continueBatchReversal(c, won);
}

const isRefusalAnswer = (e: unknown) => (e instanceof Error ? e.message : "").startsWith("Paystack error");

/** The provider half (as continueReversal): lookup first, never a second refund, 'reversed' only when processed in full. */
async function continueBatchReversal(c: PoolClient, b: SprayBatch): Promise<"reversed" | "reversing"> {
  const provider = getSplitProvider();
  const now = new Date(sprayClock.now());
  const issue = (error: string) => openPaymentIssue(c, { ticketId: null, providerRef: b.providerRef, provider: b.provider, reason: "refund_failed", error, now }).catch(() => false);
  let state: Awaited<ReturnType<typeof provider.refundState>>;
  try { state = await provider.refundState(b.providerRef, b.amountKobo); }
  catch (e) { logBatch(b.providerRef, "refund_lookup_failed", sanitizeMoneyError(e)); return "reversing"; }
  if (state === "done") return confirmBatchReversed(c, b);
  if (state === "in_progress") return "reversing";
  if (state === "needs_attention") { await issue("SPRAY_REFUND_NEEDS_ATTENTION: the provider flagged this team spray refund (or a refund for less than the full amount) for review"); return "reversing"; }
  if (state === "failed") await issue("SPRAY_REFUND_FAILED_AT_PROVIDER: an earlier team spray refund failed at the provider; trying again");
  try { await provider.refund(b.providerRef); }
  catch (e) {
    const msg = sanitizeMoneyError(e);
    logBatch(b.providerRef, isRefusalAnswer(e) ? "refund_rejected" : "refund_no_answer", msg);
    if (isRefusalAnswer(e)) await issue(`SPRAY_REFUND_REJECTED: ${msg}`);
    return "reversing";
  }
  const after = await provider.refundState(b.providerRef, b.amountKobo).catch(() => "in_progress" as const);
  if (after === "done") return confirmBatchReversed(c, b);
  if (after === "needs_attention") await issue("SPRAY_REFUND_NEEDS_ATTENTION: the provider flagged this team spray refund for review");
  return "reversing";
}

async function confirmBatchReversed(c: PoolClient, b: SprayBatch): Promise<"reversed" | "reversing"> {
  const nowMs = sprayClock.now();
  let won = false;
  try {
    await c.query("BEGIN");
    const r = await c.query(`update spray_batches set status = 'reversed', reversed_at = $2::timestamp where id = $1 and status = 'reversing' returning id`, [b.id, iso(nowMs)]);
    won = !!r.rowCount;
    if (won) {
      await c.query(`update spray_payments set status = 'reversed', reversed_at = $2::timestamp where batch_id = $1 and status = 'reversing'`, [b.id, iso(nowMs)]);
      const reversedShares = await bs.sharesOf(b.id);
      await recordBatchTransition(b, reversedShares.map((s) => s.id), "reversing", "reversed", b.reason, c);
      for (const s of reversedShares) {
        await c.query(
          `insert into payment_transactions (type, provider, provider_payment_id, currency, buyer_user_id, organizer_id, ticket_id,
                                             gross_amount, platform_fee_amount, net_to_organizer_amount, status, created_at)
           select 'spray_refund', $1::text, $2::text, 'NGN', $3::varchar, $4::varchar, $5::varchar, $6::int, $7::int, $8::int, 'refunded', $9::timestamp
            where not exists (select 1 from payment_transactions where type = 'spray_refund' and provider_payment_id = $2::text)`,
          [s.provider, s.providerRef, s.payerId, s.hostId, s.id, s.amountKobo, s.platformKobo, s.hostKobo + (s.guestKobo ?? 0), iso(nowMs)],
        );
      }
      await c.query(
        `update payment_issues set resolved_at = $2::timestamp where provider_payment_id = $1 and reason in ('refund_failed', 'refund_pending', 'refund_overdue') and resolved_at is null`,
        [b.providerRef, iso(nowMs)],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    logBatch(b.providerRef, "refund_processed_bookkeeping_failed", sanitizeMoneyError(e));
    return "reversing";
  }
  if (!won) return "reversed";
  logBatch(b.providerRef, `reversed:${b.reason ?? "?"}`);
  if (b.reason !== "LATE_PAYMENT") await ss.releaseSpend(b.roomId, b.payerId, b.amountKobo).catch((e) => console.error("[rooms:spray] releasing spend failed:", sanitizeMoneyError(e)));
  await tellPayerReversed(b);
  return "reversed";
}

/** Payer only, the single spray's words (an automatic return of money that could not be delivered, not a refund request). */
async function tellPayerReversed(b: SprayBatch): Promise<void> {
  const text = REVERSAL_TEXT[b.reason ?? ""] ?? REVERSAL_DEFAULT;
  try {
    if (roomHub.roomOf(b.payerId) === b.roomId) roomHub.sendTo(b.payerId, { type: "room:chat", userId: b.payerId, text, at: sprayClock.now(), system: "spray_reversed" });
  } catch { /* best effort */ }
  try {
    await deliverNotification({ userId: b.payerId, type: "spray_reversed", title: "Your spray was refunded", message: text, link: `/rooms/${b.roomId}`, relatedEntityId: `spray-reversed-${b.id}` });
  } catch (e) {
    console.error(`[rooms:spray] team ref=${sprayReferenceForLog(b.providerRef)} reversal notification failed:`, sanitizeMoneyError(e));
  }
}

registerBatchFinalizer(async (c, reference, opts) => {
  const b = await bs.getBatchByRef(reference);
  return b ? finalizeBatchLocked(c, b, opts) : null;
});

// ---------------------------------------------------------------- chargeback (the bank's process, as handleSprayDispute)
/**
 * A dispute on a batch reference (called by clawbacks.ts under its lock, when the reference has no single spray row). The
 * same steps as a single spray: batch + shares 'disputed', the room spend back if never delivered, a chargeback ledger row
 * and dispute clawbacks per share, one payment issue for a person. Returns null when the reference is not a batch.
 */
export async function disputeBatchLocked(c: PoolClient, reference: string): Promise<"disputed" | "already" | "refunded" | "unknown" | null> {
  const b = await bs.getBatchByRef(reference);
  if (!b) return null;
  const nowMs = sprayClock.now();
  const issue = (error: string) => openPaymentIssue(c, { ticketId: null, providerRef: reference, provider: b.provider, reason: "dispute", error, now: new Date(nowMs) });
  if (b.status === "reversing" || b.status === "reversed") {
    await issue("SPRAY_DISPUTE_AFTER_REFUND: the payer of this team spray was refunded in full (or the refund is in progress); contest the dispute in Paystack with the refund as evidence");
    return "refunded";
  }
  if (b.status === "disputed") { await issue("SPRAY_DISPUTE: respond in Paystack before the deadline"); return "already"; }
  if (!["delivered", "paid", "created", "pending", "failed"].includes(b.status)) return "unknown";
  const shares = await bs.sharesOf(b.id);
  try {
    await c.query("BEGIN");
    for (const id of Array.from(new Set([b.hostId, ...shares.map((s) => s.recipientId)])).sort()) await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [capLockKey(id)]);
    const won = await c.query(`update spray_batches set status = 'disputed', reason = 'DISPUTED' where id = $1 and status = $2 returning id`, [b.id, b.status]);
    if (!won.rowCount) { await c.query("ROLLBACK"); return "already"; }
    await c.query(`update spray_payments set status = 'disputed', reason = 'DISPUTED' where batch_id = $1 and status = $2`, [b.id, b.status]);
    await recordBatchTransition(b, shares.map((s) => s.id), b.status, "disputed", "DISPUTED", c);
    if (b.status === "created" || b.status === "pending" || b.status === "paid") {
      await c.query(`update room_spend set spent_kobo = greatest(spent_kobo - $3::int, 0) where room_id = $1 and user_id = $2`, [b.roomId, b.payerId, b.amountKobo]);
    }
    for (const s of shares) {
      const hostKobo = s.hostKobo, guestKobo = s.guestKobo ?? 0;
      await c.query(
        `insert into payment_transactions (type, provider, provider_payment_id, currency, buyer_user_id, organizer_id, ticket_id,
                                           gross_amount, platform_fee_amount, net_to_organizer_amount, status, created_at)
         select 'chargeback', $1::text, $2::text, 'NGN', $3::varchar, $4::varchar, $5::varchar, $6::int, $7::int, $8::int, 'disputed', $9::timestamp
          where not exists (select 1 from payment_transactions where type = 'chargeback' and provider_payment_id = $2::text)`,
        [s.provider, s.providerRef, s.payerId, s.hostId, s.id, s.amountKobo, s.platformKobo, hostKobo + guestKobo, iso(nowMs)],
      );
      const claw = (beneficiary: string, amount: number) => c.query(
        `insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo, origin, status, created_at)
         values ($1, $2, $3::uuid, $4::int, 'dispute', 'open', $5::timestamp) on conflict (spray_id, beneficiary_id) do nothing`,
        [s.hostId, beneficiary, s.id, amount, iso(nowMs)],
      );
      if (hostKobo > 0) await claw(s.hostId, hostKobo);
      if (guestKobo > 0 && s.recipientId !== s.hostId) await claw(s.recipientId, guestKobo);
    }
    await issue(b.status === "delivered"
      ? "SPRAY_DISPUTE: a delivered team spray was disputed; respond in Paystack before the deadline (clawbacks opened for every share)"
      : `SPRAY_DISPUTE_UNDELIVERED: the team spray was never delivered (it was ${b.status}); respond in Paystack before the deadline (clawbacks opened, delivery blocked)`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
  console.error(`[rooms:spray] ALERT chargeback on team spray ${b.id} (room ${b.roomId}, was ${b.status}); clawbacks opened`);
  return "disputed";
}

/**
 * charge.dispute.resolve on a batch reference. The outcome is the bank's; money moves only by a person (the clawbacks the
 * dispute opened stay as they are), so this only closes the loop for a person: an issue naming the outcome. null = not a batch.
 */
export async function resolveBatchDisputeLocked(c: PoolClient, reference: string, resolution: string): Promise<"needs_person" | null> {
  const b = await bs.getBatchByRef(reference);
  if (!b) return null;
  await openPaymentIssue(c, {
    ticketId: null, providerRef: reference, provider: b.provider, reason: "dispute_resolved", now: new Date(sprayClock.now()),
    error: `TEAM_SPRAY_DISPUTE_RESOLVED: the chargeback on a team spray was resolved (${resolution || "no outcome word"}); settle it in Paystack and in the clawbacks by hand (nothing was changed automatically)`,
  }).catch(() => false);
  return "needs_person";
}

// ---------------------------------------------------------------- reads
/** GET /api/rooms/:id/spray/team/:batchId: the payer's own batch in this room, else null (404). */
export async function getOwnBatch(roomId: string, batchId: string, payerId: string): Promise<SprayBatch | null> {
  const b = await bs.getBatchById(batchId);
  return b && b.payerId === payerId && b.roomId === roomId ? b : null;
}

/** For the payer only, the single spray's status words, plus the gross shares. */
export async function batchStatusView(b: SprayBatch): Promise<Record<string, unknown>> {
  const s = b.status as SprayStatus;
  const reason = shownReason(b.reason);
  const status = s === "delivered" ? "delivered" : s === "reversed" || s === "disputed" ? "reversed" : s === "failed" ? "failed" : "pending";
  return { status, ...(s === "disputed" ? { reason: "DISPUTED" } : reason && status !== "delivered" ? { reason } : {}), ...view(b, await bs.sharesOf(b.id)) };
}
