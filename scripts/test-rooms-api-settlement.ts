// Paid rooms: paying the host 48 hours after the end, the sales summary, the admin finance list
// (throwaway database, mock provider, injected clock):
//   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-settlement.ts
// Refuses to run unless the database name contains "test", because it creates users. Usernames use the prefix tr_.
// Tickets are inserted with SQL (lane S2's issuing code is not needed). No transfer ever reaches Paystack.
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
delete process.env.PAYSTACK_SECRET_KEY;
delete process.env.ADMIN_MFA_REQUIRED;

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { registerRoomFinanceAdminRoutes } = await import("../server/admin-routes");
const { setPaymentProviderForTests } = await import("../server/payments");
const { endRoom } = await import("../server/rooms/roomSocket");
const settlement = await import("../server/rooms/settlement");
const refunds = await import("../server/rooms/refunds");
const { ticketBreakdown } = await import("../shared/money");

// ---------------------------------------------------------------- mock provider (transfers)
type Mode = "success" | "pending" | "error" | "outage" | "lost";
const modes = new Map<string, Mode>();                       // per transfer reference
const transfers = new Map<string, { status: string; amountKobo: number }>(); // what the "provider" holds
const transferCalls: { reference: string; amountKobo: number; recipientCode: string }[] = [];
const verifyDown = new Set<string>();
const recipients: string[] = [];
setPaymentProviderForTests({
  refundState: async () => "none",
  refund: async () => {},
  createTransferRecipient: async ({ subaccountCode }) => { recipients.push(subaccountCode); return { recipientCode: `RCP_${subaccountCode}` }; },
  createTransfer: async (p) => {
    const mode = modes.get(p.reference) ?? "success";
    if (mode === "error") throw new Error("Paystack error: Your balance is not enough to fulfil this request");
    if (mode === "outage") throw new TypeError("fetch failed");
    if (transfers.has(p.reference)) return { status: transfers.get(p.reference)!.status }; // Paystack: same reference, same transfer
    transferCalls.push(p);
    transfers.set(p.reference, { status: mode === "pending" ? "pending" : "success", amountKobo: p.amountKobo });
    if (mode === "lost") throw new TypeError("socket hang up"); // accepted, but the answer never arrived
    return { status: transfers.get(p.reference)!.status };
  },
  verifyTransfer: async (ref) => {
    if (verifyDown.has(ref)) throw new TypeError("fetch failed");
    const t = transfers.get(ref);
    return t ? { status: t.status } : null;
  },
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

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
// The admin finance routes on their own app with a stand-in admin session (the real one is express-session + pg store).
const adminApp = express();
adminApp.use((req: any, _res, next) => {
  const id = req.header("x-test-admin");
  req.session = { adminId: id || undefined, destroy: (cb?: () => void) => cb?.() };
  next();
});
registerRoomFinanceAdminRoutes(adminApp);
const server = app.listen(0);
const adminServer = adminApp.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const adminBase = `http://127.0.0.1:${(adminServer.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null, body?: unknown, admin = false) {
  const res = await fetch((admin ? adminBase : base) + path, {
    method,
    headers: {
      "content-type": "application/json", "x-forwarded-for": `10.15.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`,
      ...(as ? { [admin ? "x-test-admin" : "x-test-user"]: as } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, json, text };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
let seq = 0;
const mk = async (name: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`,
  [`tr_${name}${stamp}_${++seq}@t.dev`, `tr_${name}${stamp}_${seq}`, hash, yearsAgo(30)]))[0].id as string;
const payoutAccount = (userId: string) => q(
  `insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled)
   values ($1, 'paystack', $2, true, true) on conflict do nothing`, [userId, `ACCT_tr${stamp}_${++seq}`]);
const mkAdmin = async (role: string) => (await q(
  `insert into admin_users (email, username, password_hash, display_name, role) values ($1, $2, $3, $4, $5) returning id`,
  [`tr_admin_${role}${stamp}@t.dev`, `tr_admin_${role}${stamp}`, hash, `tr ${role}`, role]))[0].id as string;

const PRICE = 500000;
const B = ticketBreakdown(PRICE);
/** A live (started) ticketed room, or another state, written straight to the table. */
async function mkRoom(host: string, o: { status?: string; started?: boolean; visibility?: string } = {}) {
  const status = o.status ?? "live";
  const nowIso = new Date().toISOString();
  return (await q(
    `insert into rooms (host_id, title, kind, visibility, age_limit, status, scheduled_for, started_at, ended_at, ticket_price_kobo, ticket_capacity, refund_before_start)
     values ($1, $2, 'party', $3, '18+', $4, $5::timestamp, case when $6 then $5::timestamp else null end,
             case when $4 = 'ended' then $5::timestamp else null end, $7, 50, true) returning id`,
    [host, `tr pay room ${stamp} ${++seq}`, o.visibility ?? "public", status, nowIso, o.started ?? status !== "scheduled", PRICE],
  ))[0].id as string;
}
let refSeq = 0;
/** hostKobo can be overridden to prove the payout uses the STORED share, never a recomputation from the price. */
async function mkTicket(roomId: string, userId: string, o: { hostKobo?: number; status?: string } = {}) {
  const ref = `tr_sref_${stamp}_${++refSeq}`;
  return (await q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status, refunded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,$10, case when $10 = 'refunded' then now() else null end) returning id`,
    [roomId, userId, B.price, B.vat, B.fee, B.reserve, B.platform, o.hostKobo ?? B.host, ref, o.status ?? "paid"],
  ))[0].id as string;
}
const payout = async (roomId: string) => (await q(
  `select id, status, amount_kobo, attempts, last_error, transfer_ref,
          round(extract(epoch from release_at) * 1000)::float8 as release_ms, round(extract(epoch from paid_at) * 1000)::float8 as paid_ms
     from room_payouts where room_id = $1`, [roomId]))[0];
const endedMs = async (roomId: string) => Number((await q(`select round(extract(epoch from ended_at) * 1000)::float8 as ms from rooms where id = $1`, [roomId]))[0].ms);
const HOUR = 3600_000;
const ref = (roomId: string) => `room-payout-${roomId}`;
const callsFor = (reference: string) => transferCalls.filter((t) => t.reference === reference);
const payoutLedger = async (reference: string) => q(`select * from payment_transactions where type = 'room_payout' and provider_payment_id = $1`, [reference]);

try {
  const H = await mk("host"); await payoutAccount(H);
  const HN = await mk("hostnoacct"); // no payout account
  const U = await Promise.all([mk("b1"), mk("b2"), mk("b3"), mk("b4")]);
  const S = await mk("stranger");

  // ---- scheduling on end: amount = sum of stored host_kobo of paid tickets, release = end + 48 h
  const R1 = await mkRoom(H);
  await mkTicket(R1, U[0]); await mkTicket(R1, U[1]); await mkTicket(R1, U[2], { hostKobo: B.host + 7 });
  await mkTicket(R1, U[3], { status: "refunded" }); // never counted
  check("no payout while the room is live", (await payout(R1)) === undefined);
  await endRoom(R1);
  const p1 = await payout(R1);
  const want1 = 3 * B.host + 7;
  check("ending the room creates a held payout", p1?.status === "held", JSON.stringify(p1));
  check("amount equals the sum of host_kobo of the paid tickets (stored values, refunded one excluded)", Number(p1?.amount_kobo) === want1, `${p1?.amount_kobo} want ${want1}`);
  const end1 = await endedMs(R1);
  check("release_at is exactly 48 hours after ended_at", Number(p1?.release_ms) === end1 + 48 * HOUR, `${p1?.release_ms} vs ${end1}`);
  await endRoom(R1); // the grace timer or a second end
  check("ending again changes nothing (one row, same release time)", (await q(`select 1 from room_payouts where room_id = $1`, [R1])).length === 1 && Number((await payout(R1)).release_ms) === end1 + 48 * HOUR);

  // ---- nothing before 48 hours
  await settlement.runSettlementPass(new Date(end1 + 47 * HOUR));
  check("47 hours after the end: still held, nothing sent", (await payout(R1)).status === "held" && callsFor(ref(R1)).length === 0);
  await settlement.runSettlementPass(new Date(end1 + 48 * HOUR - 1000));
  check("one second before release: still held", (await payout(R1)).status === "held");

  // ---- after 48 hours: paid once, with the deterministic reference and the stored amount
  const due1 = new Date(end1 + 48 * HOUR + 60_000);
  await settlement.runSettlementPass(due1);
  const paid1 = await payout(R1);
  check("after 48 hours: paid", paid1.status === "paid" && paid1.paid_ms !== null, JSON.stringify(paid1));
  check("exactly one transfer, reference room-payout-<roomId>, amount = the stored sum", callsFor(ref(R1)).length === 1 && callsFor(ref(R1))[0].amountKobo === want1 && paid1.transfer_ref === ref(R1), JSON.stringify(callsFor(ref(R1))));
  check("the recipient came from the host's verified payout account", recipients.some((s) => s.startsWith(`ACCT_tr${stamp}`)));
  await Promise.all([settlement.runSettlementPass(due1), settlement.runSettlementPass(due1)]);
  await settlement.runSettlementPass(new Date(end1 + 100 * HOUR));
  check("more passes (two at once, then later) never pay again", callsFor(ref(R1)).length === 1 && (await payoutLedger(ref(R1))).length === 1);

  // ---- two passes racing on a fresh due payout: one transfer
  const R2 = await mkRoom(H);
  await mkTicket(R2, U[0]); await mkTicket(R2, U[1]);
  await endRoom(R2);
  const due2 = new Date((await endedMs(R2)) + 48 * HOUR + 60_000);
  await Promise.all([settlement.runSettlementPass(due2), settlement.runSettlementPass(due2), settlement.runSettlementPass(due2)]);
  await settlement.runSettlementPass(due2); // a pass that lost the lock above finishes nothing twice
  check("three concurrent passes: one transfer with the same reference, paid, one ledger row",
    callsFor(ref(R2)).length === 1 && (await payout(R2)).status === "paid" && (await payoutLedger(ref(R2))).length === 1, JSON.stringify(callsFor(ref(R2))));

  // ---- a refund after the end but before release reduces the payout; after the payout left the hold, none
  const R3 = await mkRoom(H);
  const r3a = await mkTicket(R3, U[0]); await mkTicket(R3, U[1]);
  await endRoom(R3);
  const end3 = await endedMs(R3);
  check("refund 10 hours after the end (payout held): allowed", (await refunds.refundTicket(r3a, "host_cancelled", { now: new Date(end3 + 10 * HOUR) })) === "refunded");
  check("...the held payout drops to one host share", Number((await payout(R3)).amount_kobo) === B.host);
  await settlement.runSettlementPass(new Date(end3 + 49 * HOUR));
  check("...and the transfer sends the reduced amount", callsFor(ref(R3)).length === 1 && callsFor(ref(R3))[0].amountKobo === B.host, JSON.stringify(callsFor(ref(R3))));
  const r3b = (await q(`select id from room_tickets where room_id = $1 and status = 'paid'`, [R3]))[0].id;
  check("a refund after the host was paid: not_allowed", (await refunds.refundTicket(r3b, "host_cancelled")) === "not_allowed");

  // ---- the provider answers with an error: retried, the 5th failure marks failed + alert
  const R4 = await mkRoom(H);
  await mkTicket(R4, U[0]);
  await endRoom(R4);
  modes.set(ref(R4), "error");
  const due4 = new Date((await endedMs(R4)) + 49 * HOUR);
  const seen: string[] = [];
  for (let i = 1; i <= 4; i++) { await settlement.runSettlementPass(due4); const p = await payout(R4); seen.push(`${p.status}/${p.attempts}`); }
  check("attempts 1 to 4 stay queued with the error recorded", seen.join(",") === "queued/1,queued/2,queued/3,queued/4" && /balance/i.test((await payout(R4)).last_error ?? ""), seen.join(","));
  await settlement.runSettlementPass(due4);
  const p4 = await payout(R4);
  check("the 5th failure marks the payout failed", p4.status === "failed" && Number(p4.attempts) === 5, JSON.stringify(p4));
  check("...and raises one admin alert (payment_issues payout_failed)", (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'payout_failed' and resolved_at is null`, [ref(R4)])).length === 1);
  modes.delete(ref(R4));
  await settlement.runSettlementPass(due4);
  check("a failed payout is never retried automatically", (await payout(R4)).status === "failed" && callsFor(ref(R4)).length === 0);
  check("no bank details in last_error", !/\d{6,}/.test(p4.last_error ?? ""));

  // ---- Paystack unreachable: stays queued, attempts untouched, paid once when it is back
  const R5 = await mkRoom(H);
  await mkTicket(R5, U[1]);
  await endRoom(R5);
  verifyDown.add(ref(R5));
  const due5 = new Date((await endedMs(R5)) + 49 * HOUR);
  for (let i = 0; i < 6; i++) await settlement.runSettlementPass(due5);
  const p5 = await payout(R5);
  check("outage: six passes later still queued, PROVIDER_UNAVAILABLE, no attempts burned, nothing sent",
    p5.status === "queued" && p5.last_error === "PROVIDER_UNAVAILABLE" && Number(p5.attempts) === 0 && callsFor(ref(R5)).length === 0, JSON.stringify(p5));
  verifyDown.delete(ref(R5));
  await settlement.runSettlementPass(due5);
  check("...back up: paid once", (await payout(R5)).status === "paid" && callsFor(ref(R5)).length === 1);

  // ---- the transfer went through but the answer was lost: next pass finds it, never sends twice
  const R6 = await mkRoom(H);
  await mkTicket(R6, U[2]);
  await endRoom(R6);
  modes.set(ref(R6), "lost");
  const due6 = new Date((await endedMs(R6)) + 49 * HOUR);
  await settlement.runSettlementPass(due6);
  check("lost answer: still queued (not counted as a failure)", (await payout(R6)).status === "queued" && Number((await payout(R6)).attempts) === 0);
  modes.delete(ref(R6));
  await settlement.runSettlementPass(due6);
  check("...the next pass verifies the reference, marks it paid, one transfer only", (await payout(R6)).status === "paid" && callsFor(ref(R6)).length === 1);

  // ---- pending transfer: waits, then paid when Paystack says success
  const R7 = await mkRoom(H);
  await mkTicket(R7, U[3]);
  await endRoom(R7);
  modes.set(ref(R7), "pending");
  const due7 = new Date((await endedMs(R7)) + 49 * HOUR);
  await settlement.runSettlementPass(due7);
  await settlement.runSettlementPass(due7);
  check("pending transfer: queued, TRANSFER_PENDING, one transfer, no attempts", (await payout(R7)).status === "queued" && (await payout(R7)).last_error === "TRANSFER_PENDING" && callsFor(ref(R7)).length === 1 && Number((await payout(R7)).attempts) === 0);
  transfers.set(ref(R7), { ...transfers.get(ref(R7))!, status: "success" });
  await settlement.runSettlementPass(due7);
  check("...success later: paid, still one transfer", (await payout(R7)).status === "paid" && callsFor(ref(R7)).length === 1);

  // ---- a final transfer failure (reversed): failed at once, never re-sent
  const R8 = await mkRoom(H);
  await mkTicket(R8, U[0]);
  await endRoom(R8);
  transfers.set(ref(R8), { status: "reversed", amountKobo: B.host }); // Paystack already gave up on it
  await settlement.runSettlementPass(new Date((await endedMs(R8)) + 49 * HOUR));
  check("reversed transfer: failed + alert, no new transfer", (await payout(R8)).status === "failed" && /REVERSED/.test((await payout(R8)).last_error ?? "") && callsFor(ref(R8)).length === 0
    && (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'payout_failed' and resolved_at is null`, [ref(R8)])).length === 1);

  // ---- no verified payout account at release: stays queued, alerted once, paid when the host adds one
  const R9 = await mkRoom(HN);
  await mkTicket(R9, U[1]);
  await endRoom(R9);
  const due9 = new Date((await endedMs(R9)) + 49 * HOUR);
  await settlement.runSettlementPass(due9);
  await settlement.runSettlementPass(due9);
  const p9 = await payout(R9);
  check("no payout account: queued, NO_PAYOUT_ACCOUNT, attempts untouched, nothing sent", p9.status === "queued" && p9.last_error === "NO_PAYOUT_ACCOUNT" && Number(p9.attempts) === 0 && callsFor(ref(R9)).length === 0, JSON.stringify(p9));
  check("...one alert, not one per pass", (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'payout_failed' and resolved_at is null`, [ref(R9)])).length === 1);
  await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled) values ($1,'paystack',$2,true,false)`, [HN, `ACCT_tr_unverified_${stamp}`]);
  await settlement.runSettlementPass(due9);
  check("an account with payouts not enabled is not used", (await payout(R9)).status === "queued" && callsFor(ref(R9)).length === 0);
  await q(`update organizer_payment_accounts set payouts_enabled = true where user_id = $1`, [HN]);
  await settlement.runSettlementPass(due9);
  check("...verified account added: paid once, alert resolved", (await payout(R9)).status === "paid" && callsFor(ref(R9)).length === 1
    && (await q(`select 1 from payment_issues where provider_payment_id = $1 and resolved_at is null`, [ref(R9)])).length === 0);

  // ---- a room that never started never pays out, even with a (wrong) held payout row
  const R10 = await mkRoom(H, { status: "ended", started: false });
  await mkTicket(R10, U[2]);
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at) values ($1,$2,$3,'held',$4::timestamp)`, [R10, H, B.host, new Date(Date.now() - HOUR).toISOString()]);
  await settlement.runSettlementPass(new Date());
  check("never-started room: the payout row is removed, nothing sent", (await payout(R10)) === undefined && callsFor(ref(R10)).length === 0);
  check("scheduleRoomPayout refuses a room that never started", (await settlement.scheduleRoomPayout(R10)) === null);

  // ---- safety net: an ended room whose hook never ran gets its payout on the next pass
  const R11 = await mkRoom(H, { status: "ended", started: true });
  await mkTicket(R11, U[3]);
  await settlement.runSettlementPass(new Date());
  check("missed hook: the next pass creates the held payout", (await payout(R11))?.status === "held");

  // ---- host sales summary (host only, counts and sums only)
  const R12 = await mkRoom(H, { visibility: "friends" });
  await mkTicket(R12, U[0]); await mkTicket(R12, U[1]); await mkTicket(R12, U[2], { status: "refunded" });
  await endRoom(R12);
  const sum = await http("GET", `/api/rooms/${R12}/tickets/summary`, H);
  const s = sum.json?.summary;
  check("summary for the host: sold 2, refunded 1, sums from the stored rows",
    sum.status === 200 && s?.sold === 2 && s?.refunded === 1 && s?.grossKobo === 2 * B.price && s?.platformKobo === 2 * B.platform && s?.hostKobo === 2 * B.host && s?.vatKobo === 2 * B.vat,
    JSON.stringify(sum));
  check("...with the payout status and release date", s?.payout?.status === "held" && s?.payout?.releaseAt === new Date((await endedMs(R12)) + 48 * HOUR).toISOString(), JSON.stringify(s?.payout));
  check("...and no buyer identities", !U.some((u) => sum.text.includes(u)));
  const buyerSum = await http("GET", `/api/rooms/${R12}/tickets/summary`, U[0]);
  check("a buyer cannot read the summary (403 or 404)", buyerSum.status === 403 || buyerSum.status === 404, JSON.stringify(buyerSum));
  const strangerSum = await http("GET", `/api/rooms/${R12}/tickets/summary`, S);
  const missingSum = await http("GET", `/api/rooms/00000000-0000-0000-0000-000000000000/tickets/summary`, S);
  check("a stranger gets the same 404 as a missing room", strangerSum.status === 404 && strangerSum.text === missingSum.text);

  // ---- admin finance (read-only, finance roles only)
  const FM = await mkAdmin("finance_manager");
  const SA = await mkAdmin("super_admin");
  const CM = await mkAdmin("content_moderator");
  const none = await http("GET", `/api/admin/finance/room-payouts`, null, undefined, true);
  check("admin list without an admin session: 401", none.status === 401, JSON.stringify(none));
  const mod = await http("GET", `/api/admin/finance/room-payouts`, CM, undefined, true);
  const modT = await http("GET", `/api/admin/finance/room-tickets`, CM, undefined, true);
  check("a content moderator cannot read room finance (403)", mod.status === 403 && modT.status === 403);
  const fm = await http("GET", `/api/admin/finance/room-payouts?limit=200`, FM, undefined, true);
  const failedRow = (fm.json?.payouts ?? []).find((p: any) => p.roomId === R4);
  check("finance manager reads payouts; the failed one is flagged", fm.status === 200 && failedRow?.status === "failed" && failedRow?.alert === true, JSON.stringify(failedRow));
  const sa = await http("GET", `/api/admin/finance/room-tickets`, SA, undefined, true);
  check("super admin reads ticket totals and the open alerts", sa.status === 200 && Array.isArray(sa.json?.tickets) && (sa.json?.alerts ?? []).some((a: any) => a.reference === ref(R4) && a.kind === "payout_failed"), sa.text.slice(0, 300));
  check("no mutation route exists", (await http("POST", `/api/admin/finance/room-payouts`, SA, {}, true)).status === 404);
  check("no bank or card data in the admin responses", !/account_number|accountNumber|subaccount|authorization/i.test(fm.text + sa.text));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  setPaymentProviderForTests(null);
  server.close();
  adminServer.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
