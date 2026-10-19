// Paid rooms: buyer refund, host cancel, the automatic refund job, the payout guard (throwaway database, mock provider):
//   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-refunds.ts
// Refuses to run unless the database name contains "test", because it creates users. Usernames use the prefix tr_.
// Tickets and payouts are inserted with SQL (the issuing code of lane S2 is not needed here). Nothing reaches Paystack:
// the payment layer is swapped for a mock with setPaymentProviderForTests before anything else runs.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
delete process.env.PAYSTACK_SECRET_KEY; // belt and braces: even a missed mock could not reach a real account

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { setPaymentProviderForTests } = await import("../server/payments");
const refunds = await import("../server/rooms/refunds");
const { ticketBreakdown } = await import("../shared/money");
const { pool: appPool } = await import("../server/storage");

// ---------------------------------------------------------------- mock provider
// A small refund state machine per payment reference. refund() moves a reference to `afterRefund` (default "done": the
// provider processed it at once); a test can hold it at "in_progress" (pending) and later flip it to "done" / "failed" /
// "needs_attention" by writing providerHas. refundState() reports providerHas (and counts every lookup).
type RS = "none" | "in_progress" | "needs_attention" | "done" | "failed";
const refundCalls: string[] = [];                  // provider refs, one entry per refund the provider received
const refundAttempts: string[] = [];               // every refund call, accepted or not
const lookups: string[] = [];                      // every refund lookup
const notes = new Map<string, string | undefined>(); // provider ref -> the merchant note of the last refund
const providerHas = new Map<string, RS>();         // provider ref -> refund state the provider reports
const afterRefund = new Map<string, RS>();         // provider ref -> state right after a refund is accepted
const refuse = new Set<string>();                  // refs whose refund the provider refuses (e.g. charged back)
const loseResponse = new Set<string>();            // refs whose refund is accepted but the answer never comes back
const lookupDown = new Set<string>();              // refs whose lookup fails (outage)
setPaymentProviderForTests({
  refundState: async (ref) => {
    lookups.push(ref);
    if (lookupDown.has(ref)) throw new TypeError("fetch failed");
    return providerHas.get(ref) ?? "none";
  },
  refund: async (ref, _provider, opts) => {
    refundAttempts.push(ref);
    if (refuse.has(ref)) throw new Error("Paystack error: Transaction has a chargeback and cannot be refunded");
    refundCalls.push(ref);
    notes.set(ref, opts?.note);
    providerHas.set(ref, afterRefund.get(ref) ?? "done");
    if (loseResponse.has(ref)) throw new TypeError("fetch failed");
  },
  createTransfer: async () => { throw new Error("no transfers in this suite"); },
  createTransferRecipient: async () => { throw new Error("no transfers in this suite"); },
  verifyTransfer: async () => { throw new Error("no transfers in this suite"); },
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};
/** Waits on a condition (remote database: ~200 ms a query), never a fixed sleep for the thing itself. */
async function waitFor(cond: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return cond();
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) {
    const u = await storage.getUser(id);
    req.user = u ? userToSessionUser(u) : undefined;
  }
  req.isAuthenticated = () => !!req.user;
  req.login = (_u: unknown, cb: (e?: unknown) => void) => cb();
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.14.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, json, text };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
let userSeq = 0;
const mk = async (name: string) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
     values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`,
    [`tr_${name}${stamp}_${++userSeq}@t.dev`, `tr_${name}${stamp}_${userSeq}`, hash, yearsAgo(30)]))[0].id as string;
  madeUsers.push(id);
  return id;
};

const PRICE = 500000; // 5,000 naira
const B = ticketBreakdown(PRICE);
/** A ticketed room, written straight to the table. scheduled_for is an ISO string (UTC, the drizzle convention). */
async function mkRoom(host: string, o: { minutesAhead?: number | null; status?: string; visibility?: string; refundBeforeStart?: boolean; started?: boolean } = {}) {
  const at = o.minutesAhead === null ? null : new Date(Date.now() + (o.minutesAhead ?? 180) * 60_000).toISOString();
  const status = o.status ?? "scheduled";
  const id = (await q(
    `insert into rooms (host_id, title, kind, visibility, age_limit, status, scheduled_for, started_at, ended_at, ticket_price_kobo, ticket_capacity, refund_before_start)
     values ($1, $2, 'party', $3, '18+', $4, $5::timestamp,
             case when $6 then $7::timestamp else null end,
             case when $4 = 'ended' then $7::timestamp else null end,
             $8, 50, $9)
     returning id`,
    [host, `tr room ${stamp} ${++userSeq}`, o.visibility ?? "public", status, at, o.started === true || status === "live", new Date().toISOString(), PRICE, o.refundBeforeStart ?? true],
  ))[0].id as string;
  madeRooms.push(id);
  return id;
}
let refSeq = 0;
async function mkTicket(roomId: string, userId: string) {
  const ref = `tr_ref_${stamp}_${++refSeq}`;
  const id = (await q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,'paid') returning id`,
    [roomId, userId, B.price, B.vat, B.fee, B.reserve, B.platform, B.host, ref],
  ))[0].id as string;
  madeRefs.push(ref);
  return { id, ref };
}
/** A charge lane S2 refused (sold out...): a row born 'refunded' with refund_reason auto_*, split columns 0. */
async function mkRefused(roomId: string, userId: string, o: { minutesOld?: number; confirmed?: boolean } = {}) {
  const ref = `tr_ref_${stamp}_${++refSeq}`;
  const id = (await q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref,
                               status, refund_reason, refunded_at, created_at)
     values ($1,$2,$3,0,0,0,0,0,'paystack',$4,'refunded','auto_sold_out', case when $5 then now() else null end, now() - make_interval(mins => $6::int)) returning id`,
    [roomId, userId, B.price, ref, o.confirmed === true, o.minutesOld ?? 30],
  ))[0].id as string;
  madeRefs.push(ref);
  return { id, ref };
}
const ticket = async (id: string) => (await q(`select status, refund_reason, refunded_at from room_tickets where id = $1`, [id]))[0];
const ledgerRows = async (ticketId: string) => (await q(`select * from payment_transactions where ticket_id = $1 and type = 'room_ticket_refund'`, [ticketId]));
// related_entity_id is the deterministic key ticket-refund-<id>:<stage> (idempotent notices); the link names the room.
const refundNotes = async (userId: string, roomId: string) => (await q(
  `select title, message, link, related_entity_id from notifications where user_id = $1 and link = $2 and type = 'room_refund' order by created_at`,
  [userId, `/rooms/${roomId}`]));
const enforced: string[] = [];                      // "roomId:userId" for every enforceTicketFor call after a refund commit
refunds.refundTestHooks.onEnforce = (roomId, userId) => { enforced.push(`${roomId}:${userId}`); };
const madeRooms: string[] = [];
const madeUsers: string[] = [];
const madeRefs: string[] = [];
const callsFor = (ref: string) => refundCalls.filter((r) => r === ref).length;

try {
  const H = await mk("host");
  const H2 = await mk("host2");
  const U1 = await mk("buyer1");
  const U2 = await mk("buyer2");
  const U3 = await mk("buyer3");
  const S = await mk("stranger");

  // ---- buyer refund inside the window
  const R1 = await mkRoom(H, { minutesAhead: 180 });
  const t1 = await mkTicket(R1, U1);
  const r1 = await http("POST", `/api/rooms/${R1}/tickets/refund`, U1);
  check("buyer refund 3 hours before the start: 200 refunded, settled", r1.status === 200 && r1.json?.result === "refunded" && r1.json?.settled === true, JSON.stringify(r1));
  const row1 = await ticket(t1.id);
  check("ticket is refunded (reason buyer) and confirmed (refunded_at set)", row1.status === "refunded" && row1.refund_reason === "buyer" && row1.refunded_at !== null, JSON.stringify(row1));
  check("the provider received exactly one refund for the payment", callsFor(t1.ref) === 1);
  const led1 = await ledgerRows(t1.id);
  check("one ledger row room_ticket_refund with the stored amounts", led1.length === 1 && led1[0].gross_amount === B.price && led1[0].net_to_organizer_amount === B.host && led1[0].status === "refunded", JSON.stringify(led1));
  const n1 = await refundNotes(U1, R1);
  check("the buyer is told once, in naira, with a link to the room", n1.length === 1 && n1[0].message.includes("₦5,000") && n1[0].link === `/rooms/${R1}`, JSON.stringify(n1));

  // ---- twice
  const r1b = await http("POST", `/api/rooms/${R1}/tickets/refund`, U1);
  check("second refund call answers already", r1b.status === 200 && r1b.json?.result === "already", JSON.stringify(r1b));
  check("...and nothing moved again (one provider refund, one ledger row, one notification)",
    callsFor(t1.ref) === 1 && (await ledgerRows(t1.id)).length === 1 && (await refundNotes(U1, R1)).length === 1);

  // ---- double click: two requests at once
  const R1c = await mkRoom(H, { minutesAhead: 180 });
  const t1c = await mkTicket(R1c, U2);
  const [d1, d2] = await Promise.all([http("POST", `/api/rooms/${R1c}/tickets/refund`, U2), http("POST", `/api/rooms/${R1c}/tickets/refund`, U2)]);
  const outcome = (r: { json: any }) => (r.json?.code === "REFUND_IN_PROGRESS" ? "in_progress" : r.json?.result);
  const pair = [outcome(d1), outcome(d2)].sort().join(",");
  check("double click: one refunded, the other already (or told it is in progress)",
    pair === "already,refunded" || pair === "in_progress,refunded", `${d1.text} | ${d2.text}`);
  check("...one provider refund, one ledger row", callsFor(t1c.ref) === 1 && (await ledgerRows(t1c.id)).length === 1);

  // ---- outside the window and other refusals
  const R2 = await mkRoom(H, { minutesAhead: 45 });
  const t2 = await mkTicket(R2, U1);
  const r2 = await http("POST", `/api/rooms/${R2}/tickets/refund`, U1);
  check("45 minutes before the start: 409 WINDOW_CLOSED, ticket still paid, no provider call",
    r2.status === 409 && r2.json?.code === "WINDOW_CLOSED" && (await ticket(t2.id)).status === "paid" && callsFor(t2.ref) === 0, JSON.stringify(r2));
  const R3 = await mkRoom(H, { minutesAhead: 600, refundBeforeStart: false });
  const t3 = await mkTicket(R3, U1);
  const r3 = await http("POST", `/api/rooms/${R3}/tickets/refund`, U1);
  check("host turned refunds off: 409 NO_REFUNDS", r3.status === 409 && r3.json?.code === "NO_REFUNDS" && (await ticket(t3.id)).status === "paid", JSON.stringify(r3));
  const RL = await mkRoom(H2, { minutesAhead: 600, status: "live" });
  const tL = await mkTicket(RL, U1);
  const rL = await http("POST", `/api/rooms/${RL}/tickets/refund`, U1);
  check("the room already started (even hours before its planned time): 409 ROOM_NOT_SCHEDULED",
    rL.status === 409 && rL.json?.code === "ROOM_NOT_SCHEDULED" && (await ticket(tL.id)).status === "paid", JSON.stringify(rL));
  const noTicket = await http("POST", `/api/rooms/${R3}/tickets/refund`, U3);
  check("no ticket: 404 NO_TICKET", noTicket.status === 404 && noTicket.json?.code === "NO_TICKET", JSON.stringify(noTicket));
  const RF = await mkRoom(H, { minutesAhead: 600, visibility: "friends" });
  const hidden = await http("POST", `/api/rooms/${RF}/tickets/refund`, S);
  const missing = await http("POST", `/api/rooms/00000000-0000-0000-0000-000000000000/tickets/refund`, S);
  check("a room the caller cannot see answers like a missing one", hidden.status === 404 && missing.status === 404 && hidden.text === missing.text, `${hidden.text} | ${missing.text}`);
  check("signed out: 401", (await http("POST", `/api/rooms/${R3}/tickets/refund`, null)).status === 401);

  // ---- host cancel
  const RC = await mkRoom(H2, { minutesAhead: 30 }); // inside the buyer cutoff: the host can still cancel
  const c1 = await mkTicket(RC, U1), c2 = await mkTicket(RC, U2), c3 = await mkTicket(RC, U3);
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at) values ($1, $2, $3, 'held', $4::timestamp)`,
    [RC, H2, 3 * B.host, new Date(Date.now() + 48 * 3600_000).toISOString()]); // should never exist for a scheduled room; the cancel must clear it
  const notHost = await http("POST", `/api/rooms/${RC}/cancel`, U1);
  check("a ticket holder cannot cancel the room (403)", notHost.status === 403, JSON.stringify(notHost));
  const cancel = await http("POST", `/api/rooms/${RC}/cancel`, H2);
  check("host cancel: 200, three refunded, nothing left owed", cancel.status === 200 && cancel.json?.refunds?.refunded === 3 && cancel.json?.refunds?.unsettled === 0 && cancel.json?.room?.status === "ended", JSON.stringify(cancel));
  const cancelled = await Promise.all([c1, c2, c3].map((t) => ticket(t.id)));
  check("every ticket refunded with reason host_cancelled", cancelled.every((t) => t.status === "refunded" && t.refund_reason === "host_cancelled" && t.refunded_at !== null), JSON.stringify(cancelled));
  check("one provider refund per ticket", [c1, c2, c3].every((t) => callsFor(t.ref) === 1));
  check("the payout row is removed on cancel", (await q(`select 1 from room_payouts where room_id = $1`, [RC])).length === 0);
  const again = await http("POST", `/api/rooms/${RC}/cancel`, H2);
  check("cancelling again: 409 BAD_STATE and nothing moves", again.status === 409 && again.json?.code === "BAD_STATE" && [c1, c2, c3].every((t) => callsFor(t.ref) === 1), JSON.stringify(again));
  const liveCancel = await http("POST", `/api/rooms/${RL}/cancel`, H2);
  check("a live room cannot be cancelled in this phase (409 ROOM_LIVE)", liveCancel.status === 409 && liveCancel.json?.code === "ROOM_LIVE", JSON.stringify(liveCancel));

  // ---- the host ends a scheduled (never started) room with POST /end: everyone is refunded (background + sweep)
  const RE = await mkRoom(H2, { minutesAhead: 600 });
  const e1 = await mkTicket(RE, U1);
  const endRes = await http("POST", `/api/rooms/${RE}/end`, H2);
  check("ending a scheduled room is allowed (existing route)", endRes.status === 200, JSON.stringify(endRes));
  const endRefunded = await waitFor(async () => (await ticket(e1.id)).refunded_at !== null);
  check("...and its paid ticket is refunded (host_cancelled), never paid out", endRefunded && (await ticket(e1.id)).refund_reason === "host_cancelled" && (await q(`select 1 from room_payouts where room_id = $1`, [RE])).length === 0);

  // ---- the job: never started, exactly once even when two passes run at the same time, and again after
  const RN = await mkRoom(H, { minutesAhead: -61 });
  const n1t = await mkTicket(RN, U1), n2t = await mkTicket(RN, U2);
  const RS = await mkRoom(H, { minutesAhead: -59 }); // not late enough yet
  const s1t = await mkTicket(RS, U1);
  const [p1, p2] = await Promise.all([refunds.runRoomRefundPass(new Date()), refunds.runRoomRefundPass(new Date())]);
  const p3 = await refunds.runRoomRefundPass(new Date());
  check("exactly one of two concurrent passes claimed the room", [p1, p2].filter((p) => p.claimed.includes(RN)).length === 1 && !p3.claimed.includes(RN), JSON.stringify([p1.claimed, p2.claimed, p3.claimed]));
  const nRows = await Promise.all([n1t, n2t].map((t) => ticket(t.id)));
  check("both tickets refunded (never_started) and confirmed", nRows.every((t) => t.status === "refunded" && t.refund_reason === "never_started" && t.refunded_at !== null), JSON.stringify(nRows));
  check("one provider refund, one ledger row and one notification per ticket",
    callsFor(n1t.ref) === 1 && callsFor(n2t.ref) === 1 && (await ledgerRows(n1t.id)).length === 1 && (await ledgerRows(n2t.id)).length === 1
    && (await refundNotes(U1, RN)).length === 1 && (await refundNotes(U2, RN)).length === 1);
  check("the room is ended (cancelled) and was never started", (await q(`select status, started_at from rooms where id = $1`, [RN]))[0].status === "ended");
  check("a room 59 minutes late is left alone", (await q(`select status from rooms where id = $1`, [RS]))[0].status === "scheduled" && (await ticket(s1t.id)).status === "paid");
  const lateNote = (await refundNotes(U1, RN))[0]?.message ?? "";
  check("never-started copy says the room did not start", lateNote.includes("The room did not start."), lateNote);

  // ---- the payout guard: no refund once the host's money left the hold
  const RP = await mkRoom(H, { minutesAhead: -300, status: "ended", started: true });
  const pt = await mkTicket(RP, U1);
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at, transfer_ref, paid_at)
           values ($1, $2, $3, 'paid', $4::timestamp, $5, $4::timestamp)`, [RP, H, B.host, new Date().toISOString(), `room-payout-${RP}`]);
  const guard = await refunds.refundTicket(pt.id, "host_cancelled");
  check("refund after the host was paid: not_allowed, ticket still paid, no provider call", guard === "not_allowed" && (await ticket(pt.id)).status === "paid" && callsFor(pt.ref) === 0, guard);
  await q(`update room_payouts set status = 'queued', paid_at = null where room_id = $1`, [RP]);
  check("...also while the payout is queued (a transfer may be on its way)", (await refunds.refundTicket(pt.id, "oversold")) === "not_allowed");
  await q(`update room_payouts set status = 'failed' where room_id = $1`, [RP]);
  check("...and when it failed (an admin's call)", (await refunds.refundTicket(pt.id, "never_started")) === "not_allowed");
  check("unknown ticket id and junk id: not_allowed", (await refunds.refundTicket("00000000-0000-4000-8000-000000000000", "buyer")) === "not_allowed" && (await refunds.refundTicket("nope'; drop table x", "buyer")) === "not_allowed");

  // ---- a payment the provider will not refund (already charged back): owed, alerted, retried, never double
  const RK = await mkRoom(H2, { minutesAhead: 900 });
  const kt = await mkTicket(RK, U3);
  refuse.add(kt.ref);
  const k1 = await refunds.refundTicketDetailed(kt.id, "host_cancelled");
  const krow = await ticket(kt.id);
  check("charged-back payment: the ticket is refunded (no entry, no payout) but not confirmed", k1.result === "refunded" && k1.settled === false && krow.status === "refunded" && krow.refunded_at === null, JSON.stringify([k1, krow]));
  const issues = await q(`select * from payment_issues where provider_payment_id = $1 and reason = 'refund_failed' and resolved_at is null`, [kt.ref]);
  check("one open refund_failed issue for finance, nothing told to the buyer yet, no ledger row", issues.length === 1 && (await refundNotes(U3, RK)).length === 0 && (await ledgerRows(kt.id)).length === 0, JSON.stringify(issues));
  await refunds.runRoomRefundPass(new Date());
  check("a retry while the provider still refuses keeps one issue (no duplicates)", (await q(`select 1 from payment_issues where provider_payment_id = $1 and resolved_at is null`, [kt.ref])).length === 1);
  check("asking again returns already", (await refunds.refundTicket(kt.id, "host_cancelled")) === "already");
  refuse.delete(kt.ref);
  const retry = await refunds.runRoomRefundPass(new Date());
  check("once the provider accepts, the job confirms it: refunded_at, one ledger row, buyer told, issue resolved",
    retry.retried >= 1 && (await ticket(kt.id)).refunded_at !== null && (await ledgerRows(kt.id)).length === 1 && (await refundNotes(U3, RK)).length === 1
    && (await q(`select 1 from payment_issues where provider_payment_id = $1 and resolved_at is null`, [kt.ref])).length === 0);

  // ---- the provider accepted but the answer was lost: the retry finds it and never refunds twice
  const RX = await mkRoom(H2, { minutesAhead: 900 });
  const xt = await mkTicket(RX, U2);
  loseResponse.add(xt.ref);
  const x1 = await refunds.refundTicketDetailed(xt.id, "host_cancelled");
  check("lost answer: refunded, not confirmed", x1.result === "refunded" && x1.settled === false && (await ticket(xt.id)).refunded_at === null);
  loseResponse.delete(xt.ref);
  await refunds.runRoomRefundPass(new Date());
  check("the retry looks the refund up, does NOT refund again, and confirms", callsFor(xt.ref) === 1 && (await ticket(xt.id)).refunded_at !== null && (await ledgerRows(xt.id)).length === 1);

  // ---- the lookup is down: no refund is attempted at all (fail closed)
  const RD = await mkRoom(H2, { minutesAhead: 900 });
  const dt = await mkTicket(RD, U1);
  lookupDown.add(dt.ref);
  const dres = await refunds.refundTicketDetailed(dt.id, "host_cancelled");
  check("lookup outage: the ticket is refunded but the provider was not asked to refund", dres.result === "refunded" && dres.settled === false && callsFor(dt.ref) === 0);
  lookupDown.delete(dt.ref);
  await refunds.runRoomRefundPass(new Date());
  check("...the next pass refunds it once", callsFor(dt.ref) === 1 && (await ticket(dt.id)).refunded_at !== null);

  // ---- held payout follows refunds (recomputed from the paid tickets)
  const RH = await mkRoom(H, { minutesAhead: -300, status: "ended", started: true });
  const h1 = await mkTicket(RH, U1), h2 = await mkTicket(RH, U2);
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at) values ($1, $2, $3, 'held', $4::timestamp)`,
    [RH, H, 2 * B.host, new Date(Date.now() + 40 * 3600_000).toISOString()]);
  check("refund while the payout is held: allowed", (await refunds.refundTicket(h1.id, "oversold")) === "refunded");
  check("...and the held payout drops to the remaining host share", Number((await q(`select amount_kobo from room_payouts where room_id = $1`, [RH]))[0].amount_kobo) === B.host);
  void h2;

  // ================================================================ fix round 4F (lane FS2)

  // ---- every refund carries our deterministic note; the holder is taken out of a live room after each commit (S3-I4)
  check("every refund is sent with the note ticket-refund-<ticketId>", notes.get(t1.ref) === `ticket-refund-${t1.id}`, String(notes.get(t1.ref)));
  check("enforceTicketFor ran after the buyer refund, the host cancel and the never-started job",
    enforced.includes(`${R1}:${U1}`) && enforced.includes(`${RC}:${U1}`) && enforced.includes(`${RN}:${U2}`), JSON.stringify(enforced.slice(0, 30)));
  check("...and not for a refusal (window closed: nothing committed)", !enforced.includes(`${R2}:${U1}`));

  // ---- accepted is not refunded: pending until the provider says processed (S3-I2)
  const RPd = await mkRoom(H2, { minutesAhead: 900 });
  const pd = await mkTicket(RPd, U1);
  afterRefund.set(pd.ref, "in_progress");
  const pd1 = await refunds.refundTicketDetailed(pd.id, "host_cancelled");
  const pdRow = await ticket(pd.id);
  const pdNotes1 = await refundNotes(U1, RPd);
  check("accepted is not refunded: settled false, refunded_at NULL, no ledger row",
    pd1.result === "refunded" && pd1.settled === false && pdRow.refunded_at === null && (await ledgerRows(pd.id)).length === 0, JSON.stringify([pd1, pdRow]));
  check("...the buyer is told 'Refund on its way' once, never 'refunded'",
    pdNotes1.length === 1 && pdNotes1[0].title === "Refund on its way" && !/was refunded/.test(pdNotes1[0].message), JSON.stringify(pdNotes1));
  const pass1 = await refunds.runRoomRefundPass(new Date());
  check("a poll while the provider still says pending: still owed, no second refund, no second notice",
    pass1.pending >= 1 && (await ticket(pd.id)).refunded_at === null && callsFor(pd.ref) === 1 && (await refundNotes(U1, RPd)).length === 1, JSON.stringify(pass1));
  providerHas.set(pd.ref, "done");
  const pass2 = await refunds.runRoomRefundPass(new Date());
  const pdNotes2 = await refundNotes(U1, RPd);
  check("processed later: the poll confirms (refunded_at, one ledger row) and tells the buyer 'refunded' once",
    pass2.retried >= 1 && (await ticket(pd.id)).refunded_at !== null && (await ledgerRows(pd.id)).length === 1
    && pdNotes2.length === 2 && pdNotes2[1].title === "Ticket refunded" && callsFor(pd.ref) === 1, JSON.stringify(pdNotes2));
  await refunds.runRoomRefundPass(new Date());
  check("...and nothing more on the next pass", (await ledgerRows(pd.id)).length === 1 && (await refundNotes(U1, RPd)).length === 2);
  check("...the refund_pending marker is resolved", (await q(`select 1 from payment_issues where provider_payment_id = $1 and resolved_at is null`, [pd.ref])).length === 0);

  // ---- pending, then the provider fails it: an issue, a new refund (same note), never "refunded"
  const RPf = await mkRoom(H2, { minutesAhead: 900 });
  const pf = await mkTicket(RPf, U2);
  afterRefund.set(pf.ref, "in_progress");
  await refunds.refundTicketDetailed(pf.id, "host_cancelled");
  providerHas.set(pf.ref, "failed");
  await refunds.runRoomRefundPass(new Date());
  const pfIssue = await q(`select error_message from payment_issues where provider_payment_id = $1 and reason = 'refund_failed' and resolved_at is null`, [pf.ref]);
  check("pending then failed at the provider: one refund_failed issue, one new refund, still owed, never told 'refunded'",
    pfIssue.length === 1 && /^REFUND_FAILED_AT_PROVIDER/.test(pfIssue[0].error_message) && callsFor(pf.ref) === 2
    && notes.get(pf.ref) === `ticket-refund-${pf.id}` && (await ticket(pf.id)).refunded_at === null
    && !(await refundNotes(U2, RPf)).some((n) => n.title === "Ticket refunded"), JSON.stringify(pfIssue));

  // ---- needs-attention: pending + an issue for finance, no second refund
  const RNa = await mkRoom(H2, { minutesAhead: 900 });
  const na = await mkTicket(RNa, U3);
  afterRefund.set(na.ref, "needs_attention");
  const na1 = await refunds.refundTicketDetailed(na.id, "host_cancelled");
  await refunds.runRoomRefundPass(new Date());
  check("needs-attention: not settled, one refund_failed issue (REFUND_NEEDS_ATTENTION), no second refund",
    na1.settled === false && callsFor(na.ref) === 1
    && (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'refund_failed' and error_message like 'REFUND_NEEDS_ATTENTION%' and resolved_at is null`, [na.ref])).length === 1);

  // ---- refused charges (lane S2 rows, refund_reason auto_*): never a ticket, never host money (S3-I1, M1)
  const RA = await mkRoom(H, { minutesAhead: 900 });
  const aOld = await mkRefused(RA, U2, { minutesOld: 30 }); // a straggler lane S2 did not finish
  const aNew = await mkRefused(RA, U3, { minutesOld: 0 });  // lane S2 is still on it
  await refunds.runRoomRefundPass(new Date());
  const aRow = await ticket(aOld.id);
  check("the job finishes a refused charge: one refund with the note, confirmed",
    callsFor(aOld.ref) === 1 && aRow.refunded_at !== null && notes.get(aOld.ref) === `ticket-refund-${aOld.id}`, JSON.stringify(aRow));
  check("...no ledger row of any type for it (no sale row to reverse, nothing against the host)",
    (await q(`select 1 from payment_transactions where provider_payment_id = $1`, [aOld.ref])).length === 0);
  const aNotes = await refundNotes(U2, RA);
  check("...the payer is told 'Your payment of ₦5,000 for the ticket was returned', never that the host cancelled",
    aNotes.length === 1 && aNotes[0].message.startsWith("Your payment of ₦5,000 for the ticket was returned") && !/host|cancel/i.test(aNotes[0].message), JSON.stringify(aNotes));
  check("a refused charge younger than 10 minutes is left to the request that refused it",
    callsFor(aNew.ref) === 0 && (await ticket(aNew.id)).refunded_at === null);
  const sumA = await http("GET", `/api/rooms/${RA}/tickets/summary`, H);
  check("host summary: refused charges are not refunds (refunded 0, sold 0), reported as refusedCharges",
    sumA.status === 200 && sumA.json?.summary?.refunded === 0 && sumA.json?.summary?.sold === 0
    && sumA.json?.summary?.refusedCharges?.count === 2 && sumA.json?.summary?.refusedCharges?.grossKobo === 2 * B.price, JSON.stringify(sumA.json));

  const UB = await mk("buyerb"); // fresh buyers: the refund route allows 3 quick calls per person (rate limit)
  const UR = await mk("buyerr");
  const RB = await mkRoom(H, { minutesAhead: 900 });
  await mkRefused(RB, UB, { confirmed: true });
  const nb = await http("POST", `/api/rooms/${RB}/tickets/refund`, UB);
  check("buyer refund with only a returned refused charge: 404 NO_TICKET", nb.status === 404 && nb.json?.code === "NO_TICKET", JSON.stringify(nb));
  const RB2 = await mkRoom(H, { minutesAhead: 900 });
  const ob = await mkRefused(RB2, UB, { minutesOld: 0 });
  const ob1 = await http("POST", `/api/rooms/${RB2}/tickets/refund`, UB);
  check("...with a refused charge still owed: the call only finishes the provider step (already, settled), once",
    ob1.status === 200 && ob1.json?.result === "already" && ob1.json?.settled === true && callsFor(ob.ref) === 1 && (await ticket(ob.id)).refunded_at !== null, JSON.stringify(ob1));
  const ob2 = await http("POST", `/api/rooms/${RB2}/tickets/refund`, UB);
  check("...after that it is no ticket again (404 NO_TICKET) and nothing is sent", ob2.status === 404 && ob2.json?.code === "NO_TICKET" && callsFor(ob.ref) === 1, JSON.stringify(ob2));

  // ---- a buyer refund racing a start: the refund waits on the room row lock, then re-reads 'live' (S3-I4)
  const RR = await mkRoom(H2, { minutesAhead: 600 });
  const rr = await mkTicket(RR, UR);
  const starter = await pool.connect();
  let raced: { status: number; json: any; text: string } | null = null;
  let waited = false;
  try {
    await starter.query("BEGIN");
    await starter.query(`update rooms set status = 'live', started_at = now() where id = $1 and status = 'scheduled'`, [RR]);
    const racing = http("POST", `/api/rooms/${RR}/tickets/refund`, UR);
    // The event: the refund's locking read is waiting on a lock (not a fixed sleep).
    waited = await waitFor(async () => Number((await q(
      `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%for update of t, r%'`))[0].n) > 0);
    await starter.query("COMMIT");
    raced = await racing;
  } finally {
    await starter.query("ROLLBACK").catch(() => {});
    starter.release();
  }
  check("refund vs start: the refund waited for the start, then 409 ROOM_NOT_SCHEDULED; ticket still paid, no provider call",
    waited && raced?.status === 409 && raced?.json?.code === "ROOM_NOT_SCHEDULED" && (await ticket(rr.id)).status === "paid" && callsFor(rr.ref) === 0, JSON.stringify(raced));

  // ---- refunded_at and the ledger row are one transaction (S3-I5)
  const RLf = await mkRoom(H2, { minutesAhead: 900 });
  const lf = await mkTicket(RLf, U3);
  refunds.refundTestHooks.failLedger = (id) => id === lf.id;
  const lf1 = await refunds.refundTicketDetailed(lf.id, "host_cancelled");
  check("ledger write fails: the confirmation rolls back (refunded_at NULL, no ledger row, no 'refunded' notice), not settled",
    lf1.result === "refunded" && lf1.settled === false && (await ticket(lf.id)).refunded_at === null && (await ledgerRows(lf.id)).length === 0
    && !(await refundNotes(U3, RLf)).some((n) => n.title === "Ticket refunded"), JSON.stringify(lf1));
  refunds.refundTestHooks.failLedger = undefined;
  await refunds.runRoomRefundPass(new Date());
  check("...the next pass confirms it once: refunded_at and exactly one ledger row, no second refund",
    (await ticket(lf.id)).refunded_at !== null && (await ledgerRows(lf.id)).length === 1 && callsFor(lf.ref) === 1);

  // ---- refund webhooks only trigger a lookup; the body is never trusted
  const RW = await mkRoom(H2, { minutesAhead: 900 });
  const rw = await mkTicket(RW, U3);
  afterRefund.set(rw.ref, "in_progress");
  await refunds.refundTicketDetailed(rw.id, "host_cancelled");
  check("refund.processed while the provider still says pending: ours, but nothing confirmed",
    (await refunds.handleRoomRefundWebhook({ status: "processed", transaction_reference: rw.ref })) === true && (await ticket(rw.id)).refunded_at === null);
  providerHas.set(rw.ref, "done");
  await refunds.handleRoomRefundWebhook({ status: "processed", transaction_reference: rw.ref });
  await refunds.handleRoomRefundWebhook({ status: "processed", transaction_reference: rw.ref }); // replay
  check("...once the provider confirms: refunded_at, one ledger row, one 'refunded' notice (the replay changes nothing)",
    (await ticket(rw.id)).refunded_at !== null && (await ledgerRows(rw.id)).length === 1
    && (await refundNotes(U3, RW)).filter((n) => n.title === "Ticket refunded").length === 1 && callsFor(rw.ref) === 1);
  check("a refund webhook for a payment that is not a room charge is left alone", (await refunds.handleRoomRefundWebhook({ transaction_reference: `evt_not_a_room_${stamp}` })) === false);

  // ---- a provider REJECTION stops automatic retries 24 hours after it (admins only); clock injected
  const RJ = await mkRoom(H2, { minutesAhead: 900 });
  const rj = await mkTicket(RJ, U2);
  refuse.add(rj.ref);
  await refunds.refundTicketDetailed(rj.id, "host_cancelled", { now: new Date(Date.now() - 25 * 3600_000) }); // rejected 25 hours ago
  const rjBefore = refundAttempts.filter((r) => r === rj.ref).length;
  await refunds.runRoomRefundPass(new Date());
  check("a refund the provider rejected more than 24 hours ago is no longer retried automatically",
    rjBefore === 1 && refundAttempts.filter((r) => r === rj.ref).length === rjBefore && (await ticket(rj.id)).refunded_at === null);
  refuse.delete(rj.ref);

  // ---- owed for more than 24 hours because of a lookup outage: one alert, and the retries never stop (S3-I3)
  const ROd = await mkRoom(H2, { minutesAhead: 900 });
  const od = await mkTicket(ROd, U1);
  lookupDown.add(od.ref);
  await refunds.refundTicketDetailed(od.id, "host_cancelled", { now: new Date(Date.now() - 25 * 3600_000) }); // owed since 25 hours ago
  const o1 = await refunds.runRoomRefundPass(new Date());
  const o2 = await refunds.runRoomRefundPass(new Date());
  check("a refund owed for more than 24 hours raises ONE refund_overdue alert over two passes",
    o1.overdueAlerts >= 1 && (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'refund_overdue' and resolved_at is null`, [od.ref])).length === 1, JSON.stringify([o1, o2]));
  check("...a lookup outage never becomes a refund_failed issue", (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'refund_failed'`, [od.ref])).length === 0);
  const lkBefore = lookups.filter((r) => r === od.ref).length;
  await refunds.runRoomRefundPass(new Date());
  await refunds.runRoomRefundPass(new Date());
  check("...past 24 hours every pass still asks the provider (no cap for outages), and never refunds blind",
    lookups.filter((r) => r === od.ref).length >= lkBefore + 2 && refundAttempts.filter((r) => r === od.ref).length === 0);
  lookupDown.delete(od.ref);
  await refunds.runRoomRefundPass(new Date());
  check("...when the provider answers again: refunded once, confirmed, every open issue for it resolved",
    callsFor(od.ref) === 1 && (await ticket(od.id)).refunded_at !== null
    && (await q(`select 1 from payment_issues where provider_payment_id = $1 and resolved_at is null`, [od.ref])).length === 0);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  setPaymentProviderForTests(null);
  refunds.refundTestHooks.onEnforce = undefined;
  refunds.refundTestHooks.failLedger = undefined;
  // Teardown, children first (room_payouts has no cascade and room_tickets becomes ON DELETE RESTRICT): payment rows,
  // notifications, payouts, tickets, rooms, then users. Only rows this run made (tr_ prefix + this stamp).
  try {
    await q(`delete from payment_issues where provider_payment_id = any($1::text[]) or ticket_id in (select id::text from room_tickets where room_id = any($2::varchar[]))`, [madeRefs, madeRooms]);
    await q(`delete from payment_transactions where provider_payment_id = any($1::text[])`, [madeRefs]);
    await q(`delete from notifications where user_id = any($1::varchar[])`, [madeUsers]);
    await q(`delete from room_payouts where room_id = any($1::varchar[])`, [madeRooms]);
    await q(`delete from room_tickets where room_id = any($1::varchar[])`, [madeRooms]);
    await q(`delete from room_members where room_id = any($1::varchar[])`, [madeRooms]);
    await q(`delete from rooms where id = any($1::varchar[])`, [madeRooms]);
    await q(`delete from users where id = any($1::varchar[])`, [madeUsers]);
  } catch (e: any) { console.log(`WARN teardown: ${e.message}`); }
  server.close();
  await pool.end();
  await appPool.end().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
