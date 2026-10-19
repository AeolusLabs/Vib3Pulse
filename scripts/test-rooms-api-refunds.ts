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

// ---------------------------------------------------------------- mock provider
const refundCalls: string[] = [];                  // provider refs, one entry per refund the provider received
const providerHas = new Map<string, string>();     // provider ref -> refund state the provider reports
const refuse = new Set<string>();                  // refs whose refund the provider refuses (e.g. charged back)
const loseResponse = new Set<string>();            // refs whose refund is accepted but the answer never comes back
const lookupDown = new Set<string>();              // refs whose lookup fails (outage)
setPaymentProviderForTests({
  refundState: async (ref) => {
    if (lookupDown.has(ref)) throw new TypeError("fetch failed");
    return (providerHas.get(ref) as any) ?? "none";
  },
  refund: async (ref) => {
    if (refuse.has(ref)) throw new Error("Paystack error: Transaction has a chargeback and cannot be refunded");
    refundCalls.push(ref);
    providerHas.set(ref, "in_progress");
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
const mk = async (name: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`,
  [`tr_${name}${stamp}_${++userSeq}@t.dev`, `tr_${name}${stamp}_${userSeq}`, hash, yearsAgo(30)]))[0].id as string;

const PRICE = 500000; // 5,000 naira
const B = ticketBreakdown(PRICE);
/** A ticketed room, written straight to the table. scheduled_for is an ISO string (UTC, the drizzle convention). */
async function mkRoom(host: string, o: { minutesAhead?: number | null; status?: string; visibility?: string; refundBeforeStart?: boolean; started?: boolean } = {}) {
  const at = o.minutesAhead === null ? null : new Date(Date.now() + (o.minutesAhead ?? 180) * 60_000).toISOString();
  const status = o.status ?? "scheduled";
  return (await q(
    `insert into rooms (host_id, title, kind, visibility, age_limit, status, scheduled_for, started_at, ended_at, ticket_price_kobo, ticket_capacity, refund_before_start)
     values ($1, $2, 'party', $3, '18+', $4, $5::timestamp,
             case when $6 then $7::timestamp else null end,
             case when $4 = 'ended' then $7::timestamp else null end,
             $8, 50, $9)
     returning id`,
    [host, `tr room ${stamp} ${++userSeq}`, o.visibility ?? "public", status, at, o.started === true || status === "live", new Date().toISOString(), PRICE, o.refundBeforeStart ?? true],
  ))[0].id as string;
}
let refSeq = 0;
async function mkTicket(roomId: string, userId: string) {
  const ref = `tr_ref_${stamp}_${++refSeq}`;
  const id = (await q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,'paid') returning id`,
    [roomId, userId, B.price, B.vat, B.fee, B.reserve, B.platform, B.host, ref],
  ))[0].id as string;
  return { id, ref };
}
const ticket = async (id: string) => (await q(`select status, refund_reason, refunded_at from room_tickets where id = $1`, [id]))[0];
const ledgerRows = async (ticketId: string) => (await q(`select * from payment_transactions where ticket_id = $1 and type = 'room_ticket_refund'`, [ticketId]));
const refundNotes = async (userId: string, roomId: string) => (await q(`select title, message, link from notifications where user_id = $1 and related_entity_id = $2 and type = 'room_refund'`, [userId, roomId]));
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
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  setPaymentProviderForTests(null);
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
