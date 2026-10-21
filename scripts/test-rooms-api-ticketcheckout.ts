// Room ticket checkout, verify and webhook against a throwaway database, with the MOCK payment provider:
//   npm run test:rooms     (or: DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-ticketcheckout.ts)
// Refuses to run unless the database name contains "test". Never reaches Paystack: every provider call goes to the mock
// installed with setPaymentProviderForTests, and PAYSTACK_SECRET_KEY is replaced with a fake used only to sign webhooks.
// Needs lane S1's schema (room_tickets, rooms.ticket_price_kobo / ticket_capacity).
//
// Remote database note: each query is about 200 ms. The last-seat race uses TC_TICKET_RACE_N buyers (default 30, set it
// to 150 on a local database). Calls beyond the per-room issue queue (10) answer 503, calls that time out answer 500, and
// both are retried the way Paystack retries a webhook, until every charge has its one row.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
if (process.env.NODE_ENV === "production") { console.error("Refusing to run with NODE_ENV=production"); process.exit(2); }
// Whatever .env holds, this process never has a real key: the fake below only signs webhook bodies for the HMAC check.
process.env.PAYSTACK_SECRET_KEY = "sk_test_tc_mock_only_not_a_real_key";
delete process.env.STRIPE_SECRET_KEY;
process.env.ROOM_TICKET_REF_SECRET = "tc_api_ref_secret";
for (const k of ["ROOMS_PAID", "ROOMS_SPRAY"]) delete process.env[k];
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { registerPaymentRoutes } = await import("../server/payment-routes");
const { roomFeatures } = await import("../server/rooms/features");
const { setPaymentProviderForTests } = await import("../server/payments/index");
const { normalizePaystackMetadata } = await import("../server/payments/paystack");
const { makeTicketReference } = await import("../server/rooms/ticketReference");
const { ticketBreakdown } = await import("../shared/money");
type CreateCheckoutParams = import("../server/payments/types").CreateCheckoutParams;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

// ------------------------------------------------------------ mock provider
// rawMeta: Paystack can hand metadata back as a JSON string; when set, the mock verify returns that string to the normaliser.
type MockTx = { amount: number; currency: "NGN" | "GBP"; meta: Record<string, string>; paid: boolean; rawMeta?: string };
const txs = new Map<string, MockTx>();
const checkouts: CreateCheckoutParams[] = [];
const refunds: string[] = [];
setPaymentProviderForTests({
  createCheckout: async (p) => {
    checkouts.push(p);
    const ref = p.reference!;
    // What createPaystackCheckout attaches as metadata.
    txs.set(ref, { amount: p.amountSmallestUnit, currency: p.currency, paid: false,
      meta: { ...(p.metadata ?? {}), ...(p.itemType === "room" ? { roomId: p.itemId } : {}), itemId: p.itemId, itemType: p.itemType, userId: p.userId } });
    return { provider: "paystack", currency: p.currency, sessionId: ref, url: `https://checkout.mock.invalid/${ref}`, amountSmallestUnit: p.amountSmallestUnit };
  },
  verifyCheckoutSession: async (ref) => {
    const t = txs.get(ref);
    if (!t) return null;
    return { paid: t.paid, providerPaymentId: ref, provider: "paystack", currency: t.currency, amountSmallestUnit: t.amount, metadata: normalizePaystackMetadata(t.rawMeta ?? t.meta) };
  },
  refundPayment: async (ref) => { refunds.push(ref); },
});
/** The buyer completes payment on the (mock) Paystack page, optionally with a tampered amount. */
const pay = (ref: string, over: Partial<MockTx> = {}) => { const t = txs.get(ref); if (!t) throw new Error(`no mock tx ${ref}`); Object.assign(t, { paid: true }, over); };
/** A paid charge that never went through our checkout route (to test what the server does with it). */
const charge = (ref: string, roomId: string, userId: string, amount: number) =>
  txs.set(ref, { amount, currency: "NGN", paid: true, meta: { itemId: roomId, itemType: "room", roomId, userId } });
const refundsOf = (ref: string) => refunds.filter((r) => r === ref).length;

// ------------------------------------------------------------ app
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) {
    const u = await storage.getUser(id);
    req.user = u ? userToSessionUser(u) : undefined;
  }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
registerPaymentRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

async function http(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, json, text };
}
const checkout = (roomId: string, as: string, body: unknown = {}) => http("POST", `/api/rooms/${roomId}/tickets/checkout`, as, body);
const verify = (roomId: string, as: string, reference: string) => http("POST", `/api/rooms/${roomId}/tickets/verify`, as, { reference });
/** Paystack's webhook. The payload amount is deliberately wrong: the server must use the re-verified amount. */
async function webhook(reference: string, sign: "valid" | "none" | "bad" = "valid", payloadMetadata: unknown = { itemType: "room" }) {
  const body = JSON.stringify({ event: "charge.success", data: { reference, amount: 1, currency: "NGN", metadata: payloadMetadata } });
  const sig = sign === "valid" ? crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!).update(body).digest("hex")
    : sign === "bad" ? crypto.createHmac("sha512", "tc_wrong_key").update(body).digest("hex") : undefined;
  const res = await fetch(base + "/api/webhooks/paystack", { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "x-paystack-signature": sig } : {}) }, body });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

// ------------------------------------------------------------ fixtures
const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const mk = async (name: string, age: number | null, verified: boolean) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, age_verified_at, age_verified_method)
   values ($1,$2,'social',$3,true,true,$4,$5,$6) returning id`,
  [`tc_${name}${stamp}@t.dev`, `tc_${name}${stamp}`, hash, age === null ? null : yearsAgo(age), verified ? new Date() : null, verified ? "admin" : null]))[0].id as string;
const mkMany = async (name: string, n: number) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, age_verified_at, age_verified_method)
   select 'tc_' || $1 || g || '_' || $2 || '@t.dev', 'tc_' || $1 || g || '_' || $2, 'social', $3, true, true, $4, now(), 'admin'
   from generate_series(1, $5::int) g returning id`, [name, String(stamp), hash, yearsAgo(30), n])).map((r) => r.id as string);
const PRICE = 500000; // 5,000 naira
const mkRoom = async (hostId: string, o: { price?: number | null; cap?: number | null; ageLimit?: string; minors?: boolean; status?: string } = {}) => (await q(
  `insert into rooms (host_id, title, visibility, age_limit, status, capacity, minors_room, ticket_price_kobo, ticket_capacity)
   values ($1, $2, 'public', $3, $4, 50, $5, $6, $7) returning id`,
  [hostId, `tc_room_${stamp}`, o.ageLimit ?? "18+", o.status ?? "scheduled", o.minors ?? false,
   o.price === undefined ? PRICE : o.price, o.cap === undefined ? 20 : o.cap]))[0].id as string;
/** Fill seats with paid tickets owned by fresh users (two statements, whatever the count). */
let fillSeq = 0;
const fillSeats = async (roomId: string, n: number) => {
  const ids = await mkMany(`fill${++fillSeq}_`, n);
  const b = ticketBreakdown(PRICE);
  await q(`insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status)
           select $1, u, $2, $3, $4, $5, $6, $7, 'paystack', 'tc_fill_' || u, 'paid' from unnest($8::varchar[]) u`,
    [roomId, b.price, b.vat, b.fee, b.reserve, b.platform, b.host, ids]);
};
const rowsFor = (ref: string) => q(`select * from room_tickets where provider_ref = $1`, [ref]);
const ledgerFor = (ref: string) => q(`select * from payment_transactions where provider_payment_id = $1 and type = 'room_ticket'`, [ref]);
const issueRefs: string[] = []; // references whose payment issues this run opens (cleared at the end)
const payoutAccount = (userId: string) => q(
  `insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, room_verified_subaccount_code, name_matched_at) values ($1,'paystack',$2,true,true,$2,now())`,
  [userId, `ACCT_tc_${userId.slice(0, 8)}`]);
const issuesFor = (ref: string) => q(`select * from payment_issues where provider_payment_id = $1 and reason = 'room_charge_unhandled' and resolved_at is null`, [ref]);
const paidIn = async (roomId: string) => Number((await q(`select count(*)::int n from room_tickets where room_id = $1 and status = 'paid'`, [roomId]))[0].n);

const savedFlags = { ...roomFeatures };
try {
  const host = await mk("host", 30, true);
  const host2 = await mk("host2", 30, true);
  // A host may sell only while ID-verified with a verified payout account (re-checked at checkout and at issue).
  await payoutAccount(host); await payoutAccount(host2);
  const teenHost = await mk("teenhost", 15, false);
  const [a, b, c, d, e, f, g, h, i] = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n) => mk(`buyer_${n}`, 30, true)));
  const teen = await mk("teen", 16, false);
  const teenVerified = await mk("teenv", 16, true);
  const unverified = await mk("unverified", 30, false);

  const room = await mkRoom(host);
  const room2 = await mkRoom(host2);
  // No price on it: whatever lane S1's constraints allow, the point is that the adult learns nothing about the room.
  const minorsRoom = await mkRoom(teenHost, { ageLimit: "all", minors: true, price: null, cap: null });
  const breakdownOf = ticketBreakdown(PRICE);

  // ------------------------------------------------------------ flag
  roomFeatures.paidRooms = false;
  const off = await checkout(room, a);
  check("flag off: checkout is 403 FEATURE_OFF", off.status === 403 && off.json?.code === "FEATURE_OFF", JSON.stringify(off.json));
  check("flag off: no provider call", checkouts.length === 0);
  check("flag off: no price in the body", !off.text.includes(String(PRICE)));
  roomFeatures.paidRooms = true;

  // ------------------------------------------------------------ admin pause (rooms admin plan, task 2)
  {
    const controls = await import("../server/rooms/roomControls");
    await controls.setControl({ key: "tickets_paused", on: true, adminId: "ctl-test-admin", reason: "test pause" });
    const paused = await checkout(room, a);
    check("tickets paused: checkout is 403 FEATURE_OFF", paused.status === 403 && paused.json?.code === "FEATURE_OFF", JSON.stringify(paused.json));
    check("tickets paused: no provider call and no price in the body", checkouts.length === 0 && !paused.text.includes(String(PRICE)));
    await controls.setControl({ key: "tickets_paused", on: false, adminId: "ctl-test-admin", reason: "test resume" });
  }

  // ------------------------------------------------------------ admin host freeze (rooms admin plan, task 3)
  {
    const controls = await import("../server/rooms/roomControls");
    await controls.freezeHost({ hostId: host, adminId: "ctl-test-admin", reason: "test freeze" });
    const fz = await checkout(room, a);
    check("host frozen: checkout is 403 FEATURE_OFF and nothing is charged", fz.status === 403 && fz.json?.code === "FEATURE_OFF" && checkouts.length === 0 && !fz.text.includes(String(PRICE)), JSON.stringify(fz.json));
    await controls.unfreezeHost({ hostId: host, adminId: "ctl-test-admin" });
  }

  // ------------------------------------------------------------ gates before price
  const anon = await http("POST", `/api/rooms/${room}/tickets/checkout`, null, {});
  check("signed out: 401", anon.status === 401, JSON.stringify(anon.json));
  const mr = await checkout(minorsRoom, a);
  check("minors' room, adult without an invite: 404 Room not found (nothing about the room)", mr.status === 404 && mr.json?.message === "Room not found" && !mr.json?.code, JSON.stringify(mr.json));
  check("minors' room: no price in the body", !mr.text.includes(String(PRICE)));
  const missing = await checkout("tc-no-such-room", g);
  check("unknown room: 404", missing.status === 404, JSON.stringify(missing.json));
  const t1 = await checkout(room, teen);
  check("under-18: checkout 404 NOT_ELIGIBLE", t1.status === 404 && t1.json?.code === "NOT_ELIGIBLE", JSON.stringify(t1.json));
  check("under-18: no price in the body", !t1.text.includes(String(PRICE)) && !/kobo|price/i.test(t1.text), t1.text);
  const t2 = await checkout(room, teenVerified);
  check("under-18 even if marked verified: 404 NOT_ELIGIBLE", t2.status === 404 && t2.json?.code === "NOT_ELIGIBLE", JSON.stringify(t2.json));
  const uv = await checkout(room, unverified);
  check("unverified adult: same 404 NOT_ELIGIBLE body as a teen", uv.status === 404 && JSON.stringify(uv.json) === JSON.stringify(t1.json), JSON.stringify(uv.json));
  const freeRoom = await mkRoom(host, { price: null, cap: null });
  const tf = await checkout(freeRoom, teen);
  check("teen gets the same answer for a free room as for a ticketed one", JSON.stringify(tf.json) === JSON.stringify(t1.json) && tf.status === t1.status, JSON.stringify(tf.json));
  const af = await checkout(freeRoom, g);
  check("verified adult, free room: 409 NOT_TICKETED", af.status === 409 && af.json?.code === "NOT_TICKETED", JSON.stringify(af.json));
  const hostBuy = await checkout(room, host);
  check("host: 409 IS_HOST", hostBuy.status === 409 && hostBuy.json?.code === "IS_HOST", JSON.stringify(hostBuy.json));
  check("no provider call for any refused checkout", checkouts.length === 0, String(checkouts.length));

  // ------------------------------------------------------------ webhook first, then verify
  const before = checkouts.length;
  const coA = await checkout(room, a, { amount: 1, priceKobo: 1, amountSmallestUnit: 1, amountKobo: 1, currency: "GBP" });
  check("checkout: 200 with url and reference", coA.status === 200 && typeof coA.json?.url === "string" && /^vib3rt_[0-9a-f]{24}_[0-9a-f]{32}$/.test(coA.json?.reference ?? ""), JSON.stringify(coA.json));
  const sent = checkouts[before];
  check("tampered client price ignored: provider charged the stored price in NGN", sent?.amountSmallestUnit === PRICE && sent?.currency === "NGN", JSON.stringify(sent));
  check("checkout: itemType room, itemId room id, our reference passed through", sent?.itemType === "room" && sent?.itemId === room && sent?.reference === coA.json?.reference);
  check("checkout: response has exactly url and reference", JSON.stringify(Object.keys(coA.json ?? {}).sort()) === JSON.stringify(["reference", "url"]));
  const refA = coA.json.reference as string;

  const early = await verify(room, a, refA);
  check("verify before paying: 402 NOT_PAID, nothing written", early.status === 402 && early.json?.code === "NOT_PAID" && (await rowsFor(refA)).length === 0, JSON.stringify(early.json));

  pay(refA);
  const w1 = await webhook(refA);
  check("signed webhook: 200", w1.status === 200, JSON.stringify(w1.json));
  const rowsA = await rowsFor(refA);
  check("webhook first: one paid ticket", rowsA.length === 1 && rowsA[0].status === "paid", JSON.stringify(rowsA));
  check("ticket split is ticketBreakdown(stored price)", rowsA[0]?.amount_kobo === breakdownOf.price && rowsA[0]?.vat_kobo === breakdownOf.vat && rowsA[0]?.fee_kobo === breakdownOf.fee
    && rowsA[0]?.reserve_kobo === breakdownOf.reserve && rowsA[0]?.platform_kobo === breakdownOf.platform && rowsA[0]?.host_kobo === breakdownOf.host, JSON.stringify(rowsA[0]));
  const ledA = await ledgerFor(refA);
  check("webhook first: one ledger row, gross price, platform and host from the breakdown", ledA.length === 1 && ledA[0].gross_amount === PRICE
    && ledA[0].platform_fee_amount === breakdownOf.platform && ledA[0].net_to_organizer_amount === breakdownOf.host && ledA[0].organizer_id === host && ledA[0].buyer_user_id === a
    && ledA[0].ticket_id === rowsA[0]?.id, JSON.stringify(ledA));
  const vA = await verify(room, a, refA);
  check("then verify: 200 with the same ticket", vA.status === 200 && vA.json?.ticket?.id === rowsA[0]?.id, JSON.stringify(vA.json));
  check("ticket view: exactly id, roomId, code, amountKobo, status, createdAt", JSON.stringify(Object.keys(vA.json?.ticket ?? {}).sort()) === JSON.stringify(["amountKobo", "code", "createdAt", "id", "roomId", "status"]), JSON.stringify(vA.json));
  check("ticket view: code is the short form of the id, status paid, amount the price", vA.json?.ticket?.code === String(rowsA[0]?.id).replace(/[^0-9a-f]/gi, "").slice(0, 8).toUpperCase().replace(/^(.{4})/, "$1-")
    && vA.json?.ticket?.status === "paid" && vA.json?.ticket?.amountKobo === PRICE && vA.json?.ticket?.roomId === room, JSON.stringify(vA.json?.ticket));
  check("ticket view: never the payment reference", !vA.text.includes(refA));
  const w1b = await webhook(refA); // Paystack retries
  check("webhook retry and verify: still one ticket, one ledger row", w1b.status === 200 && (await rowsFor(refA)).length === 1 && (await ledgerFor(refA)).length === 1);
  const again = await checkout(room, a);
  check("already ticketed: checkout 409 ALREADY_TICKETED", again.status === 409 && again.json?.code === "ALREADY_TICKETED", JSON.stringify(again.json));

  // ------------------------------------------------------------ verify first, then webhook
  const coB = await checkout(room, b);
  const refB = coB.json?.reference as string;
  pay(refB);
  const vB = await verify(room, b, refB);
  check("verify first: 200 ticket", vB.status === 200 && vB.json?.ticket?.status === "paid", JSON.stringify(vB.json));
  const wB = await webhook(refB);
  check("then webhook: 200, still one ticket and one ledger row", wB.status === 200 && (await rowsFor(refB)).length === 1 && (await ledgerFor(refB)).length === 1);

  // ------------------------------------------------------------ concurrent webhook + verify
  const coC = await checkout(room, c);
  const refC = coC.json?.reference as string;
  pay(refC);
  const [cw1, cv1, cw2, cv2] = await Promise.all([webhook(refC), verify(room, c, refC), webhook(refC), verify(room, c, refC)]);
  const rowsC = await rowsFor(refC);
  check("concurrent webhook+verify: exactly one ticket and one ledger row", rowsC.length === 1 && rowsC[0].status === "paid" && (await ledgerFor(refC)).length === 1, JSON.stringify(rowsC));
  check("concurrent: both verifies return that ticket; both webhooks 200 (or 500 to be retried)",
    cv1.json?.ticket?.id === rowsC[0]?.id && cv2.json?.ticket?.id === rowsC[0]?.id && [200, 500].includes(cw1.status) && [200, 500].includes(cw2.status),
    JSON.stringify([cw1, cv1.json, cw2, cv2.json]));
  check("concurrent: no refund for a good charge", refundsOf(refC) === 0);

  // ------------------------------------------------------------ double-click Pay (two checkouts, both paid)
  const [d1, d2] = await Promise.all([checkout(room, d), checkout(room, d)]);
  check("double-click: both checkouts answer (two references)", d1.status === 200 && d2.status === 200 && d1.json.reference !== d2.json.reference, JSON.stringify([d1.json, d2.json]));
  pay(d1.json.reference); pay(d2.json.reference);
  const [dv1, dv2] = await Promise.all([verify(room, d, d1.json.reference), verify(room, d, d2.json.reference)]);
  const paidD = await q(`select * from room_tickets where room_id = $1 and user_id = $2 and status = 'paid'`, [room, d]);
  check("double-click: one paid ticket for the buyer", paidD.length === 1, JSON.stringify(paidD));
  check("double-click: both verifies return that ticket; one says duplicateRefunded", dv1.json?.ticket?.id === paidD[0]?.id && dv2.json?.ticket?.id === paidD[0]?.id
    && [dv1.json?.duplicateRefunded, dv2.json?.duplicateRefunded].filter(Boolean).length === 1, JSON.stringify([dv1.json, dv2.json]));
  check("double-click: the second charge refunded exactly once, the first not at all",
    refundsOf(d1.json.reference) + refundsOf(d2.json.reference) === 1, JSON.stringify(refunds));
  const dupRef = refundsOf(d1.json.reference) ? d1.json.reference : d2.json.reference;
  const dupAgain = await verify(room, d, dupRef);
  await webhook(dupRef);
  check("double-click: replaying the refunded charge refunds nothing more and returns the held ticket",
    refundsOf(dupRef) === 1 && dupAgain.json?.ticket?.id === paidD[0]?.id && dupAgain.json?.duplicateRefunded === true, JSON.stringify(dupAgain.json));
  check("double-click: one ledger row in total for the buyer",
    (await q(`select count(*)::int n from payment_transactions where type = 'room_ticket' and buyer_user_id = $1`, [d]))[0].n === 1);

  // ------------------------------------------------------------ amount mismatch
  const coE = await checkout(room, e);
  const refE = coE.json?.reference as string;
  pay(refE, { amount: 100000 }); // the buyer somehow paid 1,000 naira instead of 5,000
  const vE = await verify(room, e, refE);
  check("amount mismatch: 409 AMOUNT_MISMATCH refunded", vE.status === 409 && vE.json?.code === "AMOUNT_MISMATCH" && vE.json?.refunded === true, JSON.stringify(vE.json));
  const rowsE = await rowsFor(refE);
  check("amount mismatch: one refunded row, no paid ticket, refunded_at set", rowsE.length === 1 && rowsE[0].status === "refunded"
    && rowsE[0].refund_reason === "auto_amount_mismatch" && rowsE[0].refunded_at !== null && rowsE[0].host_kobo === 0, JSON.stringify(rowsE));
  check("amount mismatch: refunded once, no ledger row", refundsOf(refE) === 1 && (await ledgerFor(refE)).length === 0);
  const vE2 = await verify(room, e, refE);
  const wE = await webhook(refE);
  check("amount mismatch: verify again and webhook do not refund twice", vE2.json?.code === "AMOUNT_MISMATCH" && wE.status === 200 && refundsOf(refE) === 1, JSON.stringify(refunds));
  const coE2 = await checkout(room, e);
  check("after a refunded mismatch the buyer can try again (not ALREADY_TICKETED)", coE2.status === 200, JSON.stringify(coE2.json));
  const overRef = coE2.json?.reference as string;
  pay(overRef, { amount: PRICE + 1 });
  const vOver = await verify(room, e, overRef);
  check("overpayment by one kobo is a mismatch too (refunded)", vOver.json?.code === "AMOUNT_MISMATCH" && refundsOf(overRef) === 1, JSON.stringify(vOver.json));
  const coE3 = await checkout(room, e);
  const gbpRef = coE3.json?.reference as string;
  pay(gbpRef, { currency: "GBP" });
  const vGbp = await verify(room, e, gbpRef);
  check("right number in the wrong currency is a mismatch (refunded)", vGbp.json?.code === "AMOUNT_MISMATCH" && refundsOf(gbpRef) === 1, JSON.stringify(vGbp.json));

  // ------------------------------------------------------------ under-18 buyer whose charge reaches us anyway
  const teenRef = makeTicketReference(room, teen, process.env.ROOM_TICKET_REF_SECRET!);
  charge(teenRef, room, teen, PRICE);
  const wT = await webhook(teenRef);
  const vT = await verify(room, teen, teenRef);
  check("under-18 charge: refunded INELIGIBLE, once", wT.status === 200 && vT.status === 409 && vT.json?.code === "INELIGIBLE" && refundsOf(teenRef) === 1, JSON.stringify([wT, vT.json, refunds]));
  check("under-18 charge: refusal body has no price", !vT.text.includes(String(PRICE)));
  check("under-18 charge: no paid ticket", (await q(`select count(*)::int n from room_tickets where room_id = $1 and user_id = $2 and status = 'paid'`, [room, teen]))[0].n === 0);

  // ------------------------------------------------------------ references bound to user and room
  const coF = await checkout(room, f);
  const refF = coF.json?.reference as string;
  pay(refF);
  const stolen = await verify(room, g, refF);
  check("another user's reference: 404 PAYMENT_NOT_FOUND, nothing issued", stolen.status === 404 && stolen.json?.code === "PAYMENT_NOT_FOUND" && (await rowsFor(refF)).length === 0, JSON.stringify(stolen.json));
  const otherRoom = await verify(room2, f, refF);
  check("own reference against another room: 404, nothing issued", otherRoom.status === 404 && (await rowsFor(refF)).length === 0, JSON.stringify(otherRoom.json));
  const stolenDone = await verify(room, g, refA);
  check("another user's already-issued reference: 404, never their ticket", stolenDone.status === 404 && !stolenDone.text.includes(String(rowsA[0]?.id)), JSON.stringify(stolenDone.json));
  const junk = await verify(room, f, "vib3_123_abc");
  check("junk reference: 400", junk.status === 400, JSON.stringify(junk.json));
  const vF = await verify(room, f, refF);
  check("the owner can still verify it: 200", vF.status === 200 && vF.json?.ticket?.status === "paid", JSON.stringify(vF.json));

  // A charge someone set up themselves (not through our checkout), with room metadata and a reference we never made.
  const forged = `vib3_${Date.now()}_tcforged`;
  charge(forged, room, g, PRICE);
  const wForged = await webhook(forged);
  const forgedRows = await rowsFor(forged);
  check("forged (unbound) charge via webhook: no ticket, refunded once as ineligible", wForged.status === 200 && forgedRows.length === 1
    && forgedRows[0].status === "refunded" && forgedRows[0].refund_reason === "auto_ineligible" && refundsOf(forged) === 1, JSON.stringify([wForged, forgedRows]));

  // ------------------------------------------------------------ webhook signature
  const coH = await checkout(room, h);
  const refH = coH.json?.reference as string;
  pay(refH);
  const unsigned = await webhook(refH, "none");
  const badSig = await webhook(refH, "bad");
  check("unsigned webhook: 400", unsigned.status === 400, JSON.stringify(unsigned));
  check("wrongly signed webhook: 400", badSig.status === 400, JSON.stringify(badSig));
  check("rejected webhooks issued nothing and refunded nothing", (await rowsFor(refH)).length === 0 && refundsOf(refH) === 0);

  // ------------------------------------------------------------ sold out
  const small = await mkRoom(host2, { cap: 20 });
  await fillSeats(small, 19);
  const coI = await checkout(small, i);
  check("one seat left: checkout allowed", coI.status === 200, JSON.stringify(coI.json));
  await fillSeats(small, 1); // someone else takes the last seat while i is on the Paystack page
  const soldNow = await checkout(small, h);
  check("sold out: checkout 409 SOLD_OUT", soldNow.status === 409 && soldNow.json?.code === "SOLD_OUT", JSON.stringify(soldNow.json));
  const refI = coI.json?.reference as string;
  pay(refI);
  const vI = await verify(small, i, refI);
  check("sold out after paying: 409 SOLD_OUT, refunded once", vI.status === 409 && vI.json?.code === "SOLD_OUT" && refundsOf(refI) === 1, JSON.stringify(vI.json));
  check("sold out: still exactly 20 paid", (await paidIn(small)) === 20);

  // ------------------------------------------------------------ last seat race
  const N = Math.max(2, Number(process.env.TC_TICKET_RACE_N) || 30);
  const race = await mkRoom(host2, { cap: 20 });
  await fillSeats(race, 19);
  const racers = await mkMany("race", N);
  const refs = racers.map((u) => { const r = makeTicketReference(race, u, process.env.ROOM_TICKET_REF_SECRET!); charge(r, race, u, PRICE); return r; });
  const first = await Promise.all(refs.map((r) => webhook(r)));
  let pending = refs.filter((_, k) => first[k].status !== 200);
  for (let round = 0; round < 8 && pending.length; round++) {
    // Paystack retries a webhook that did not get a 200. Here: sequentially, so the retries cannot time out on the lock.
    const left: string[] = [];
    for (const r of pending) if ((await webhook(r)).status !== 200) left.push(r);
    pending = left;
  }
  check(`last seat, ${N} buyers at once: every charge processed (after webhook retries)`, pending.length === 0, `${pending.length} still failing`);
  const raceRows = await q(`select provider_ref, status, refund_reason from room_tickets where provider_ref = any($1::text[])`, [refs]);
  const winners = raceRows.filter((r) => r.status === "paid");
  check(`last seat: exactly one of ${N} got the ticket`, winners.length === 1, JSON.stringify(winners));
  check("last seat: everyone else refunded as sold out, exactly once each", raceRows.length === N
    && raceRows.filter((r) => r.status === "refunded" && r.refund_reason === "auto_sold_out").length === N - 1
    && refs.every((r) => refundsOf(r) === (r === winners[0]?.provider_ref ? 0 : 1)), JSON.stringify(raceRows.slice(0, 5)));
  check("last seat: room has exactly 20 paid, one ledger row for the winner", (await paidIn(race)) === 20
    && Number((await q(`select count(*)::int n from payment_transactions where type = 'room_ticket' and provider_payment_id = any($1::text[])`, [refs]))[0].n) === 1);

  // ------------------------------------------------------------ fix round 4F
  // M2: a co-host never needs (or buys) a ticket.
  const coBuyer = await mk("cohost", 30, true);
  await q(`insert into room_members (room_id, user_id, role) values ($1,$2,'cohost') on conflict (room_id, user_id) do update set role = 'cohost'`, [room, coBuyer]);
  const callsBefore = checkouts.length;
  const coCo = await checkout(room, coBuyer);
  check("co-host: checkout 409 IS_COHOST, no provider call", coCo.status === 409 && coCo.json?.code === "IS_COHOST" && checkouts.length === callsBefore, JSON.stringify(coCo.json));

  // M7: a stored price outside the limits pauses sales (never "not ticketed", never a checkout).
  const badPrice = await mkRoom(host, { price: 50000 });
  const bp = await checkout(badPrice, g);
  check("stored price below the limit: checkout 409 SALES_PAUSED, no provider call", bp.status === 409 && bp.json?.code === "SALES_PAUSED" && checkouts.length === callsBefore, JSON.stringify(bp.json));

  // M1: the host loses eligibility while a buyer is on the Paystack page.
  const host3 = await mk("host3", 30, true);
  await payoutAccount(host3);
  const room3 = await mkRoom(host3);
  const [j, k] = await Promise.all([mk("buyer_j", 30, true), mk("buyer_k", 30, true)]);
  const coJ = await checkout(room3, j);
  check("eligible host: checkout 200", coJ.status === 200, JSON.stringify(coJ.json));
  const refJ = coJ.json?.reference as string;
  await q(`update organizer_payment_accounts set payouts_enabled = false where user_id = $1`, [host3]);
  const coK = await checkout(room3, k);
  check("host's payout account gone: checkout 409 SALES_PAUSED with plain words and no price", coK.status === 409 && coK.json?.code === "SALES_PAUSED" && !coK.text.includes(String(PRICE)) && !/—/.test(coK.text), JSON.stringify(coK.json));
  pay(refJ);
  const vJ = await verify(room3, j, refJ);
  const rowsJ = await rowsFor(refJ);
  check("in-flight charge after the host lost eligibility: 409 INELIGIBLE refunded, once", vJ.status === 409 && vJ.json?.code === "INELIGIBLE" && vJ.json?.refunded === true && refundsOf(refJ) === 1, JSON.stringify([vJ.json, refunds.length]));
  check("in-flight charge: one refunded row with reason auto_host_ineligible, no paid ticket, no ledger row",
    rowsJ.length === 1 && rowsJ[0].status === "refunded" && rowsJ[0].refund_reason === "auto_host_ineligible" && rowsJ[0].host_kobo === 0 && (await ledgerFor(refJ)).length === 0, JSON.stringify(rowsJ));
  const vJ2 = await verify(room3, j, refJ);
  const wJ = await webhook(refJ);
  check("in-flight charge: replays answer the same and never refund again", vJ2.json?.code === "INELIGIBLE" && wJ.status === 200 && refundsOf(refJ) === 1, JSON.stringify(vJ2.json));
  await q(`update organizer_payment_accounts set payouts_enabled = true where user_id = $1`, [host3]);
  await q(`update users set age_verified_at = null where id = $1`, [host3]);
  const coK2 = await checkout(room3, k);
  check("host's ID verification revoked: checkout 409 SALES_PAUSED", coK2.status === 409 && coK2.json?.code === "SALES_PAUSED", JSON.stringify(coK2.json));
  await q(`update users set age_verified_at = now() where id = $1`, [host3]);
  const coK3 = await checkout(room3, k);
  check("host eligible again: checkout 200", coK3.status === 200, JSON.stringify(coK3.json));

  // M4: Paystack metadata as a JSON string (in the webhook payload and in the verify answer) still finishes the ticket.
  const [sb1, sb2, sb3] = await Promise.all([mk("strmeta", 30, true), mk("nometa", 30, true), mk("zero", 30, true)]);
  const refS = makeTicketReference(room2, sb1, process.env.ROOM_TICKET_REF_SECRET!);
  txs.set(refS, { amount: PRICE, currency: "NGN", paid: true, meta: {}, rawMeta: JSON.stringify({ itemId: room2, itemType: "room", userId: sb1 }) });
  const wS = await webhook(refS, "valid", JSON.stringify({ itemType: "room" }));
  const rowsS = await rowsFor(refS);
  check("string metadata: webhook 200 and one paid ticket", wS.status === 200 && rowsS.length === 1 && rowsS[0].status === "paid" && rowsS[0].user_id === sb1, JSON.stringify([wS, rowsS]));

  // A paid charge with our reference shape whose verified metadata names no room: a payment issue for a person, 200, no
  // refund guessed, no row; Paystack's retry does not add a second issue.
  const refX = makeTicketReference(room2, sb2, process.env.ROOM_TICKET_REF_SECRET!);
  txs.set(refX, { amount: PRICE, currency: "NGN", paid: true, meta: {} });
  issueRefs.push(refX);
  const wX = await webhook(refX, "valid", "not json at all");
  const wX2 = await webhook(refX);
  check("ticket reference without a room in the verified metadata: 200, no row, no refund", wX.status === 200 && wX2.status === 200 && (await rowsFor(refX)).length === 0 && refundsOf(refX) === 0, JSON.stringify([wX, wX2]));
  check("... and exactly one open room_charge_unhandled payment issue", (await issuesFor(refX)).length === 1);

  // M5: a verified amount of 0 can never be stored (CHECK amount_kobo > 0): payment issue and 200, never a 500 loop.
  const refZ = makeTicketReference(room2, sb3, process.env.ROOM_TICKET_REF_SECRET!);
  charge(refZ, room2, sb3, 0);
  issueRefs.push(refZ);
  const wZ = await webhook(refZ);
  const wZ2 = await webhook(refZ);
  check("zero amount: webhook 200 (twice), no row, no refund call", wZ.status === 200 && wZ2.status === 200 && (await rowsFor(refZ)).length === 0 && refundsOf(refZ) === 0, JSON.stringify([wZ, wZ2]));
  check("zero amount: exactly one open payment issue", (await issuesFor(refZ)).length === 1);
  const vZ = await verify(room2, sb3, refZ);
  check("zero amount: the buyer's verify says payment not found (nothing to give), still one issue", vZ.status === 404 && vZ.json?.code === "PAYMENT_NOT_FOUND" && (await issuesFor(refZ)).length === 1, JSON.stringify(vZ.json));

  // ------------------------------------------------------------ ended room
  const ended = await mkRoom(host, { status: "ended" });
  const endedCo = await checkout(ended, b);
  check("ended room: checkout 409 ROOM_ENDED", endedCo.status === 409 && endedCo.json?.code === "ROOM_ENDED", JSON.stringify(endedCo.json));

  check("no payment issues were raised (all mock refunds succeeded)",
    Number((await q(`select count(*)::int n from payment_issues where provider_payment_id = any($1::text[])`, [[...refunds]]))[0].n) === 0);
} catch (err: any) {
  failed++; console.log(`FAIL uncaught: ${err.stack || err}`);
} finally {
  Object.assign(roomFeatures, savedFlags);
  setPaymentProviderForTests(null);
  try {
    // Throwaway database, but leave it tidy: everything here is prefixed tc_.
    await q(`delete from payment_transactions where type = 'room_ticket' and buyer_user_id in (select id from users where username like $1)`, [`tc\\_%`]);
    await q(`delete from payment_issues where provider_payment_id in (select provider_ref from room_tickets where room_id in (select id from rooms where title = $1)) or provider_payment_id = any($2::text[])`, [`tc_room_${stamp}`, issueRefs]);
    // Tickets are money records (RESTRICT): a scratch database clears them explicitly before the rooms and users.
    await q(`delete from room_tickets where room_id in (select id from rooms where title = $1)`, [`tc_room_${stamp}`]);
    await q(`delete from rooms where title = $1`, [`tc_room_${stamp}`]);
    await q(`delete from users where username like $1 and username like $2`, [`tc\\_%`, `%${stamp}%`]);
  } catch (err: any) { console.log(`cleanup: ${err.message}`); }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
