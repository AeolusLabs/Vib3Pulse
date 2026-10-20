// Rooms phase 6 (tasks 6.1 to 6.3): payout account, earnings, payments and receipts over HTTP, against a MOCK payout
// provider (no Paystack call is ever made). Revision section D items for this lane each have a case here: IDOR on
// earnings / payments / receipts, another person's money or identity visible, the resolve endpoint as a name oracle (rate
// limit, no name echoed, one answer for not found and mismatch), a mismatched name accepted, an account changed while a
// payout is in flight, "settled" without provider confirmation, receipt HTML injection.
//   npm run test:rooms      (needs a scratch database whose name contains "test"; usernames use the prefix ea_)
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
process.env.PAYSTACK_SECRET_KEY = "sk_test_earnings_mock_only_not_a_real_key";
process.env.SESSION_SECRET ||= "earnings-test-session-secret";

const logged: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { setPayoutProviderForTests, payoutTestHooks, hostPayoutReady, payableSubaccountOf, maskAccountName, ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR } = await import("../server/rooms/payouts");
const { registerOrganizerPaymentsRoutes } = await import("../server/organizer-payments-routes");
const { setPaymentProviderForTests } = await import("../server/payments/index");
const { runSettlementPass } = await import("../server/rooms/settlement");
const { hasVerifiedPayoutAccount } = await import("../server/rooms/ticketStorage");
const { ticketBreakdown, sprayBreakdown } = await import("../shared/money");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (e) => console.log(`(pool error ignored: ${e.message})`));
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

// ---------------------------------------------------------------- the mock payout provider
const BANKS = [{ name: "Test Bank Plc", code: "058" }, { name: "Other Bank", code: "044" }];
const OWNER = new Map<string, string>(); // account number -> the bank's account name
const mock = {
  calls: { banks: 0, resolve: [] as string[], create: [] as any[], update: [] as any[] },
  outage: false,
};
setPayoutProviderForTests({
  listBanks: async () => { mock.calls.banks++; return BANKS; },
  resolve: async (n, b) => {
    mock.calls.resolve.push(`${b}:${n}`);
    if (mock.outage) throw new Error("Paystack unavailable: HTTP 502");
    const name = OWNER.get(n);
    if (!name) throw new Error("Paystack error: Could not resolve account name");
    return { accountNumber: n, accountName: name };
  },
  createSubaccount: async (p) => { mock.calls.create.push(p); return { subaccountCode: `ACCT_ea_${mock.calls.create.length}_${Date.now()}` }; },
  updateSubaccount: async (code, p) => { mock.calls.update.push({ code, ...p }); },
});
const VERIFIED_NAME = new Map<string, string>();
payoutTestHooks.verifiedName = (userId) => VERIFIED_NAME.get(userId) ?? null;

// ---------------------------------------------------------------- server
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) { const u = await storage.getUser(id); req.user = u ? userToSessionUser(u) : undefined; }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
registerOrganizerPaymentsRoutes(app);
setVoiceServiceForTests(null);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let ipSeq = 1;
async function rest(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* html or none */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ---------------------------------------------------------------- data
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const hash = await bcrypt.hash("Passw0rd!earn", 4);
const stamp = Date.now();
const created: string[] = [];
const madeRooms: string[] = [];
let seq = 0;
const mk = async (name: string, o: { verified?: boolean } = {}) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4,$5,$6) returning id`,
    [`ea_${name}${stamp}@t.dev`, `ea_${name}${stamp}`, hash, yearsAgo(30), o.verified === false ? null : new Date(), o.verified === false ? null : "admin"],
  ))[0].id as string;
  created.push(id);
  return id;
};
const mkRoom = async (hostId: string, title: string) => {
  const id = (await q(`insert into rooms (host_id, title, status, age_limit, started_at, ended_at) values ($1,$2,'ended','18+', now() - interval '3 hours', now() - interval '1 hour') returning id`, [hostId, title]))[0].id as string;
  madeRooms.push(id);
  return id;
};
const mkTicket = async (roomId: string, userId: string, price: number, o: { status?: string; refundedAt?: boolean; ago?: string } = {}) => {
  const b = ticketBreakdown(price);
  return (await q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status, created_at, refunded_at, refund_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,$10, now() - $11::interval, $12, $13) returning id`,
    [roomId, userId, b.price, b.vat, b.fee, b.reserve, b.platform, b.host, `ea_tk_${stamp}_${++seq}`, o.status ?? "paid", o.ago ?? "1 hour",
      o.refundedAt ? new Date() : null, o.status === "refunded" ? "buyer" : null],
  ))[0].id as string;
};
const mkSpray = async (o: { roomId: string; hostId: string; payerId: string; recipientId: string; tier?: "note" | "bundle"; status: string; methodId?: string | null; ago?: string }) => {
  const stage = o.recipientId !== o.hostId;
  const b = sprayBreakdown(o.tier ?? "bundle", stage);
  const delivered = o.status === "delivered";
  return (await q(
    `insert into spray_payments (idempotency_key, request_hash, room_id, host_id, payer_id, recipient_id, tier, v3c, amount_kobo, vat_kobo, fee_kobo,
       reserve_kobo, platform_kobo, host_kobo, guest_kobo, provider, provider_ref, payment_method_id, status, created_at, paid_at, delivered_at, reversed_at)
     values ($1,'h',$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,'paystack',$14,$15,$16, now() - $17::interval, now() - $17::interval,
       case when $18 then now() - $17::interval end, case when $16 = 'reversed' then now() end) returning id`,
    [crypto.randomUUID(), o.roomId, o.hostId, o.payerId, o.recipientId, o.tier ?? "bundle", b.price, b.vat, b.fee, b.reserve, b.platform, b.host,
      stage ? b.guest : null, `ea_sp_${stamp}_${++seq}`, o.methodId ?? null, o.status, o.ago ?? "2 hours", delivered],
  ))[0].id as string;
};

const ALL_PATHS: Array<[string, string]> = [
  ["GET", "/api/rooms/payouts/status"], ["GET", "/api/rooms/payouts/banks"], ["POST", "/api/rooms/payouts/account"],
  ["GET", "/api/users/me/room-earnings"], ["GET", "/api/users/me/room-payments"], ["GET", `/api/users/me/room-payments/tk_${crypto.randomUUID()}/receipt`],
];

try {
  // =============================================================== 401 everywhere
  for (const [m, p] of ALL_PATHS) {
    const r = await rest(m, p, null, m === "POST" ? { bankCode: "058", accountNumber: "0123456789" } : undefined);
    check(`unauthenticated ${m} ${p.replace(/tk_.*\//, "tk_<id>/")}: 401`, r.status === 401, String(r.status));
  }

  // =============================================================== 6.1 payout account
  const U0 = await mk("unver", { verified: false });
  const H1 = await mk("host1");
  const H2 = await mk("host2");
  const HR = await mk("rate");
  const HF = await mk("inflight");
  const HO = await mk("organiser");

  let r = await rest("GET", "/api/rooms/payouts/status", U0);
  check("status unverified: verifiedAdult false, no account, cannot link", r.status === 200 && r.json.verifiedAdult === false && r.json.account === null
    && r.json.subaccountReady === false && r.json.canLinkAccount === false, r.text);
  r = await rest("GET", "/api/rooms/payouts/status", H1);
  check("verified adult WITHOUT a verified legal name: canLinkAccount false (the page says to contact support)", r.json?.verifiedAdult === true && r.json?.canLinkAccount === false, r.text);
  r = await rest("POST", "/api/rooms/payouts/account", U0, { bankCode: "058", accountNumber: "0123456789" });
  check("unverified user: 403 NOT_VERIFIED, no lookup", r.status === 403 && r.json?.code === "NOT_VERIFIED" && mock.calls.resolve.length === 0, r.text);

  r = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "058", accountNumber: "0123456789" });
  check("no verified legal name: 422 NO_VERIFIED_NAME before any lookup", r.status === 422 && r.json?.code === "NO_VERIFIED_NAME" && mock.calls.resolve.length === 0, r.text);
  const attemptsAfterNoName = Number((await q(`select count(*)::int as n from room_payout_account_events where user_id = $1 and action = 'attempt'`, [H1]))[0].n);
  check("NO_VERIFIED_NAME spends no attempt", attemptsAfterNoName === 0);

  VERIFIED_NAME.set(H1, "Adébáyọ̀ Okafor");
  VERIFIED_NAME.set(H2, "Grace Bello");
  VERIFIED_NAME.set(HR, "Rate Limited");
  VERIFIED_NAME.set(HF, "Flight Person");
  OWNER.set("0123456789", "OKAFOR ADEBAYO");
  OWNER.set("1111111111", "SOMEONE ELSE ENTIRELY");
  OWNER.set("2222222222", "ADEBAYO OKAFOR");
  OWNER.set("3333333333", "FLIGHT PERSON");

  r = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "058", accountNumber: "12345" });
  check("bad account number: 400 BAD_INPUT", r.status === 400 && r.json?.code === "BAD_INPUT", r.text);
  r = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "058", accountNumber: 123 });
  check("account number not a string: 400 BAD_INPUT", r.status === 400 && r.json?.code === "BAD_INPUT", r.text);

  const mismatch = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "058", accountNumber: "1111111111" });
  check("someone else's account: 422 NAME_MISMATCH", mismatch.status === 422 && mismatch.json?.code === "NAME_MISMATCH", mismatch.text);
  check("the bank's account name is never echoed", !/SOMEONE|ELSE|ENTIRELY/i.test(mismatch.text));
  const notFound = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "058", accountNumber: "9999999999" });
  check("an unknown number gets the SAME answer as a mismatch (no existence oracle)", notFound.status === 422 && JSON.stringify(notFound.json) === JSON.stringify(mismatch.json), notFound.text);
  r = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "999", accountNumber: "0123456789" });
  check("a bank not on the list: 400 BAD_BANK", r.status === 400 && r.json?.code === "BAD_BANK", r.text);
  check("no subaccount made for a refused account", mock.calls.create.length === 0 && mock.calls.update.length === 0);

  const ok1 = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "058", accountNumber: "0123456789" });
  check("matching name (accents, order, case): 200, last four only", ok1.status === 200 && ok1.json?.account?.last4 === "6789" && ok1.json?.account?.nameMatches === true && ok1.json?.updated === false, ok1.text);
  check("response never carries the full number or the account name", !ok1.text.includes("0123456789") && !/OKAFOR/i.test(ok1.text) && !/accountName|account_name/.test(ok1.text));
  check("one subaccount created, business name = the verified name", mock.calls.create.length === 1 && mock.calls.create[0].businessName === "Adébáyọ̀ Okafor");
  r = await rest("GET", "/api/rooms/payouts/status", H1);
  check("with a verified legal name: canLinkAccount true", r.json?.canLinkAccount === true, r.text);
  check("status after linking: bank name, last four, name matches, ready", r.status === 200 && r.json.verifiedAdult === true && r.json.account?.bankName === "Test Bank Plc"
    && r.json.account?.last4 === "6789" && r.json.account?.nameMatches === true && r.json.subaccountReady === true && !r.text.includes("0123456789"), r.text);
  check("hostPayoutReady and hasVerifiedPayoutAccount agree (one helper)", (await hostPayoutReady(H1)) === true && (await hasVerifiedPayoutAccount(H1)) === true
    && (await hostPayoutReady(H2)) === false && (await hasVerifiedPayoutAccount(H2)) === false);

  const ok2 = await rest("POST", "/api/rooms/payouts/account", H1, { bankCode: "044", accountNumber: "2222222222" });
  const rows1 = await q(`select paystack_subaccount_code, bank_code, account_last4, bank_name from organizer_payment_accounts where user_id = $1`, [H1]);
  check("second call UPDATES the same subaccount (no duplicate)", ok2.status === 200 && ok2.json?.updated === true && mock.calls.create.length === 1
    && mock.calls.update.length === 1 && rows1.length === 1 && mock.calls.update[0].code === rows1[0].paystack_subaccount_code
    && rows1[0].account_last4 === "2222" && rows1[0].bank_code === "044" && rows1[0].bank_name === "Other Bank", JSON.stringify(rows1));
  const audit1 = await q(`select action, outcome from room_payout_account_events where user_id = $1 order by created_at, id`, [H1]);
  check("an audit row for every lookup outcome; refusals before any lookup write nothing (review r1 m6)",
    audit1.filter((a) => a.action === "account_set").length === 2 && audit1.filter((a) => a.action === "account_refused").length === 2
    && !audit1.some((a) => a.outcome === "NO_VERIFIED_NAME" || a.outcome === "BAD_BANK"), JSON.stringify(audit1));
  check("an unknown bank spends no attempt (review r1 m3)", audit1.filter((a) => a.action === "attempt").length === 4, JSON.stringify(audit1));

  // ---- C1: an organiser re-onboarding replaces the code with an UNCHECKED one: no longer payable in rooms.
  const goodCode = rows1[0].paystack_subaccount_code;
  await q(`update organizer_payment_accounts set paystack_subaccount_code = $2 where user_id = $1`, [H1, `ACCT_ea_reonboard_${stamp}`]);
  r = await rest("GET", "/api/rooms/payouts/status", H1);
  check("C1: a replaced (unchecked) subaccount is not payable, not shown, not ready", (await hostPayoutReady(H1)) === false && (await payableSubaccountOf(H1)) === null
    && r.json?.account === null && r.json?.subaccountReady === false, r.text);
  await q(`update organizer_payment_accounts set paystack_subaccount_code = $2 where user_id = $1`, [H1, goodCode]);
  check("C1: back to the checked code: payable again", (await payableSubaccountOf(H1)) === goodCode);

  // Rate limit: per user, in the database.
  const before = mock.calls.resolve.length;
  for (let i = 0; i < ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR; i++) await rest("POST", "/api/rooms/payouts/account", HR, { bankCode: "058", accountNumber: "1111111111" });
  const limited = await rest("POST", "/api/rooms/payouts/account", HR, { bankCode: "058", accountNumber: "1111111111" });
  check(`attempt ${ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR + 1} in an hour: 429 with Retry-After, no lookup`, limited.status === 429 && limited.json?.code === "RATE_LIMITED"
    && Number(limited.headers.get("retry-after")) > 0 && mock.calls.resolve.length - before === ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR, `${limited.status} ${mock.calls.resolve.length - before}`);
  // Concurrent attempts cannot get past the limit either.
  const HC = await mk("concurrent");
  VERIFIED_NAME.set(HC, "Concurrent Person");
  const beforeC = mock.calls.resolve.length;
  await Promise.all(Array.from({ length: 12 }, () => rest("POST", "/api/rooms/payouts/account", HC, { bankCode: "058", accountNumber: "1111111111" })));
  check("12 concurrent attempts: at most 5 lookups", mock.calls.resolve.length - beforeC <= ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR, String(mock.calls.resolve.length - beforeC));

  // Outage: 503, nothing saved.
  mock.outage = true;
  r = await rest("POST", "/api/rooms/payouts/account", H2, { bankCode: "058", accountNumber: "0123456789" });
  mock.outage = false;
  check("provider outage: 503 PROVIDER_UNAVAILABLE, nothing saved", r.status === 503 && r.json?.code === "PROVIDER_UNAVAILABLE"
    && (await q(`select 1 from organizer_payment_accounts where user_id = $1`, [H2])).length === 0, r.text);

  // In flight: a queued payout blocks the change; held does not.
  const roomF = await mkRoom(HF, "Inflight room");
  await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled) values ($1,'paystack',$2,true,true)`, [HF, `ACCT_ea_f_${stamp}`]);
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at, transfer_ref) values ($1,$2,5000,'queued', now(), $3)`, [roomF, HF, `room-payout-${roomF}`]);
  const updBefore = mock.calls.update.length;
  r = await rest("POST", "/api/rooms/payouts/account", HF, { bankCode: "058", accountNumber: "3333333333" });
  check("a queued payout: 409 PAYOUT_IN_FLIGHT, the subaccount is not touched", r.status === 409 && r.json?.code === "PAYOUT_IN_FLIGHT" && mock.calls.update.length === updBefore, r.text);
  r = await rest("GET", "/api/rooms/payouts/status", HF);
  check("C1: organiser-made account (never name-checked): account null, NOT ready, not payable",
    r.json?.account === null && r.json?.subaccountReady === false && (await hostPayoutReady(HF)) === false, r.text);
  await q(`update room_payouts set status = 'held' where room_id = $1`, [roomF]);
  r = await rest("POST", "/api/rooms/payouts/account", HF, { bankCode: "058", accountNumber: "3333333333" });
  check("a held payout does not block: 200, updates the organiser subaccount", r.status === 200 && r.json?.updated === true && mock.calls.update.length === updBefore + 1, r.text);
  check("after the rooms name check the same subaccount is payable", (await hostPayoutReady(HF)) === true);

  // I3: Paystack clearly refuses an update: the old verification is restored (still payable); an outage leaves it cleared.
  const { setPayoutProviderForTests: setProv } = await import("../server/rooms/payouts");
  const keep = { listBanks: async () => BANKS, resolve: async (n: string) => ({ accountNumber: n, accountName: OWNER.get(n) ?? "" }) };
  await q(`update room_payouts set status = 'paid' where room_id = $1`, [roomF]);
  setProv({ ...keep, updateSubaccount: async () => { throw new Error("Paystack error: Account details invalid"); } });
  r = await rest("POST", "/api/rooms/payouts/account", HF, { bankCode: "058", accountNumber: "3333333333" });
  check("I3: a clear Paystack refusal: 503 and the account stays payable", r.status === 503 && (await hostPayoutReady(HF)) === true, r.text);
  setProv({ ...keep, updateSubaccount: async () => { throw new Error("Paystack unavailable: The operation was aborted due to timeout"); } });
  r = await rest("POST", "/api/rooms/payouts/account", HF, { bankCode: "058", accountNumber: "3333333333" });
  check("I3: an unclear answer (timeout): 503 and the account is NOT payable until saved again (fail closed)", r.status === 503 && (await hostPayoutReady(HF)) === false, r.text);
  setProv({ ...keep, updateSubaccount: async () => {} });
  r = await rest("POST", "/api/rooms/payouts/account", HF, { bankCode: "058", accountNumber: "3333333333" });
  check("I3: saving again restores it", r.status === 200 && (await hostPayoutReady(HF)) === true, r.text);
  // I3: while a change holds the lock, settlement may not queue (the shared lock is refused).
  const lockC = await pool.connect();
  try {
    await lockC.query("select pg_advisory_lock(41004, hashtext($1::text))", [HF]);
    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      const ok = (await probe.query("select pg_try_advisory_xact_lock_shared(41004, hashtext($1::text)) as ok", [HF])).rows[0].ok;
      await probe.query("ROLLBACK");
      check("I3: a change in progress refuses settlement's shared lock (no queueing meanwhile)", ok === false);
    } finally { probe.release(); }
  } finally {
    await lockC.query("select pg_advisory_unlock(41004, hashtext($1::text))", [HF]).catch(() => {});
    lockC.release();
  }
  setPayoutProviderForTests({
    listBanks: async () => { mock.calls.banks++; return BANKS; },
    resolve: async (n, b) => {
      mock.calls.resolve.push(`${b}:${n}`);
      if (mock.outage) throw new Error("Paystack unavailable: HTTP 502");
      const name = OWNER.get(n);
      if (!name) throw new Error("Paystack error: Could not resolve account name");
      return { accountNumber: n, accountName: name };
    },
    createSubaccount: async (p) => { mock.calls.create.push(p); return { subaccountCode: `ACCT_ea_${mock.calls.create.length}_${Date.now()}` }; },
    updateSubaccount: async (code, p) => { mock.calls.update.push({ code, ...p }); },
  });

  // ---- I1: the organiser lookup routes share the durable per-user limit; onboarding masks the holder's name.
  const ORG = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth)
     values ($1,$2,'organizer',$3,true,true,$4) returning id`,
    [`ea_org${stamp}@t.dev`, `ea_org${stamp}`, hash, yearsAgo(30)],
  ))[0].id as string;
  created.push(ORG);
  for (let i = 0; i < ROOMS_ACCOUNT_ATTEMPTS_PER_HOUR; i++) {
    await q(`insert into room_payout_account_events (user_id, action, outcome) values ($1, 'attempt', 'organizer_resolve')`, [ORG]);
  }
  const orgResolve = await rest("POST", "/api/organizer/payments/paystack/resolve-account", ORG, { accountNumber: "0123456789", bankCode: "058" });
  check("I1: organiser resolve-account past 5 lookups an hour: 429, no lookup made", orgResolve.status === 429 && orgResolve.json?.code === "RATE_LIMITED"
    && Number(orgResolve.headers.get("retry-after")) > 0, orgResolve.text);
  const orgOnboard = await rest("POST", "/api/organizer/payments/paystack/onboard", ORG, { accountNumber: "0123456789", bankCode: "058", businessName: "X" });
  check("I1: organiser onboard shares the same limit: 429", orgOnboard.status === 429, orgOnboard.text);
  check("I1: the onboarding name is masked", maskAccountName("ADEBAYO OKAFOR") === "A****** O*****" && maskAccountName(null) === "");

  r = await rest("GET", "/api/rooms/payouts/banks", HO);
  check("banks: any signed-in user (no organiser role), names and codes only", r.status === 200 && Array.isArray(r.json?.banks) && r.json.banks.length === 2
    && Object.keys(r.json.banks[0]).sort().join() === "code,name", r.text);

  check("no log line carries an account number or a bank account name",
    !logged.some((l) => /0123456789|1111111111|2222222222|3333333333|OKAFOR|SOMEONE ELSE/i.test(l)));

  // =============================================================== review r3 N1: an unpayable host's payout is never stranded
  // Transfers are mocked (no Paystack): no transfer exists for a reference until we "create" it, and it succeeds at once.
  const transfers = new Map<string, string>();
  const transferCalls: string[] = [];
  setPaymentProviderForTests({
    verifyTransfer: async (ref) => (transfers.has(ref) ? { status: transfers.get(ref)! } : null),
    createTransferRecipient: async ({ subaccountCode }) => ({ recipientCode: `RCP_${subaccountCode}` }),
    createTransfer: async ({ reference, recipientCode }) => { transferCalls.push(`${reference}>${recipientCode}`); transfers.set(reference, "success"); return { status: "success" }; },
  });
  const restoreProv = () => setPayoutProviderForTests({
    listBanks: async () => BANKS,
    resolve: async (n: string) => ({ accountNumber: n, accountName: OWNER.get(n) ?? "" }),
    createSubaccount: async (p) => { mock.calls.create.push(p); return { subaccountCode: `ACCT_ea_n1_${mock.calls.create.length}_${Date.now()}` }; },
    updateSubaccount: async (code, p) => { mock.calls.update.push({ code, ...p }); },
  });
  const payoutOf = async (roomId: string) => (await q(`select status, last_error, amount_kobo from room_payouts where room_id = $1`, [roomId]))[0];
  const dueRoom = async (hostId: string, title: string) => {
    const room = await mkRoom(hostId, title);
    await mkTicket(room, P_N1, 500000);
    await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at) values ($1,$2,$3,'held', now() - interval '1 minute')`,
      [room, hostId, ticketBreakdown(500000).host]);
    return room;
  };
  const P_N1 = await mk("n1payer");

  // (1) An unclear Paystack answer during a change leaves the account unpayable; the payout falls due meanwhile.
  const HN = await mk("n1host");
  VERIFIED_NAME.set(HN, "Nnamdi Host");
  OWNER.set("4444444444", "HOST NNAMDI");
  restoreProv();
  r = await rest("POST", "/api/rooms/payouts/account", HN, { bankCode: "058", accountNumber: "4444444444" });
  check("N1 setup: account saved", r.status === 200, r.text);
  const roomN = await dueRoom(HN, "N1 room");
  setPayoutProviderForTests({ listBanks: async () => BANKS, resolve: async (n: string) => ({ accountNumber: n, accountName: OWNER.get(n) ?? "" }),
    updateSubaccount: async () => { throw new Error("Paystack unavailable: The operation was aborted due to timeout"); } });
  r = await rest("POST", "/api/rooms/payouts/account", HN, { bankCode: "058", accountNumber: "4444444444" });
  check("N1 setup: an unclear answer leaves the account unpayable", r.status === 503 && (await hostPayoutReady(HN)) === false, r.text);
  restoreProv();
  await runSettlementPass();
  let po = await payoutOf(roomN);
  check("N1 (a): a due payout of an unpayable host stays HELD (never queued, nothing applied)", po?.status === "held", JSON.stringify(po));
  check("N1 (a): finance gets a NO_PAYOUT_ACCOUNT issue for it",
    (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'payout_failed' and resolved_at is null and error_message like 'NO_PAYOUT_ACCOUNT%'`, [`room-payout-${roomN}`])).length === 1);
  r = await rest("POST", "/api/rooms/payouts/account", HN, { bankCode: "058", accountNumber: "4444444444" });
  check("N1: the host can save again (no false 'payout being sent')", r.status === 200 && (await hostPayoutReady(HN)) === true, r.text);
  await runSettlementPass();
  po = await payoutOf(roomN);
  check("N1: once payable, the next pass queues and pays it to the name-checked account", po?.status === "paid"
    && transferCalls.some((t) => t.startsWith(`room-payout-${roomN}>RCP_`)), JSON.stringify({ po, transferCalls }));

  // (2) A row queued before the fix and parked with NO_PAYOUT_ACCOUNT never blocks a change, and is paid afterwards.
  const HL = await mk("n1legacy");
  VERIFIED_NAME.set(HL, "Legacy Host");
  OWNER.set("5555555555", "LEGACY HOST");
  await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled) values ($1,'paystack',$2,true,true)`,
    [HL, `ACCT_ea_legacy_${stamp}`]); // organiser-made: not payable in rooms (C1)
  const roomL = await mkRoom(HL, "Legacy room");
  await mkTicket(roomL, P_N1, 500000);
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at, transfer_ref, last_error) values ($1,$2,$3,'queued', now() - interval '1 hour', $4, 'NO_PAYOUT_ACCOUNT')`,
    [roomL, HL, ticketBreakdown(500000).host, `room-payout-${roomL}`]);
  r = await rest("POST", "/api/rooms/payouts/account", HL, { bankCode: "058", accountNumber: "5555555555" });
  check("N1 (b): a queued NO_PAYOUT_ACCOUNT row does not block the change (200, not 409)", r.status === 200 && r.json?.updated === true, r.text);
  await runSettlementPass();
  po = await payoutOf(roomL);
  check("N1 (b): it is then paid to the new name-checked account", po?.status === "paid", JSON.stringify(po));
  // A real in-flight row (any other note) still blocks.
  const roomL2 = await mkRoom(HL, "Legacy room 2");
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at, transfer_ref, last_error) values ($1,$2,5000,'queued', now(), $3, 'TRANSFER_PENDING')`,
    [roomL2, HL, `room-payout-${roomL2}`]);
  r = await rest("POST", "/api/rooms/payouts/account", HL, { bankCode: "058", accountNumber: "5555555555" });
  check("N1: a payout really being sent still answers 409 PAYOUT_IN_FLIGHT", r.status === 409 && r.json?.code === "PAYOUT_IN_FLIGHT", r.text);
  await q(`update room_payouts set status = 'paid' where room_id = $1`, [roomL2]);

  // (3) Organiser re-onboarding makes the host unpayable; the due payout waits held; a rooms save releases it.
  const roomO = await dueRoom(HN, "N1 room after re-onboard");
  const goodN = (await q(`select paystack_subaccount_code from organizer_payment_accounts where user_id = $1`, [HN]))[0].paystack_subaccount_code;
  await q(`update organizer_payment_accounts set paystack_subaccount_code = $2 where user_id = $1`, [HN, `ACCT_ea_reon_${stamp}`]);
  await runSettlementPass();
  check("N1 (3): after an organiser re-onboarding the due payout stays held", (await payoutOf(roomO))?.status === "held");
  r = await rest("POST", "/api/rooms/payouts/account", HN, { bankCode: "058", accountNumber: "4444444444" });
  await runSettlementPass();
  check("N1 (3): a rooms save makes it payable and it is paid", r.status === 200 && (await payoutOf(roomO))?.status === "paid", JSON.stringify(await payoutOf(roomO)));
  void goodN;

  // ---- review r3 m3: a double submit is "busy", never "a payout is being sent"
  await q(`delete from room_payout_account_events where user_id = $1`, [HN]); // a fresh hourly budget for this case
  setPayoutProviderForTests({ listBanks: async () => BANKS, resolve: async (n: string) => ({ accountNumber: n, accountName: OWNER.get(n) ?? "" }),
    updateSubaccount: async () => { await new Promise((res) => setTimeout(res, 9000)); } });
  const [d1, d2] = await Promise.all([
    rest("POST", "/api/rooms/payouts/account", HN, { bankCode: "058", accountNumber: "4444444444" }),
    new Promise<any>((res) => setTimeout(() => res(rest("POST", "/api/rooms/payouts/account", HN, { bankCode: "058", accountNumber: "4444444444" })), 300)),
  ]);
  check("m3: the second of two quick saves answers 409 BUSY (not PAYOUT_IN_FLIGHT)", [d1, d2].some((x) => x.status === 409 && x.json?.code === "BUSY")
    && ![d1, d2].some((x) => x.json?.code === "PAYOUT_IN_FLIGHT"), JSON.stringify([d1.json, d2.json]));

  // ---- review r3 m5: organiser onboarding waits for (or refuses during) a rooms change
  const lockM5 = await pool.connect();
  try {
    await lockM5.query("select pg_advisory_lock(41004, hashtext($1::text))", [ORG]);
    await q(`delete from room_payout_account_events where user_id = $1`, [ORG]);
    const busy = await rest("POST", "/api/organizer/payments/paystack/onboard", ORG, { accountNumber: "0123456789", bankCode: "058", businessName: "X" });
    // The lookup itself happens before the lock (it is outside the critical section); with the real Paystack unreachable in
    // tests it may fail first. Either way the subaccount row is never written while a rooms change holds the lock.
    check("m5: no organiser subaccount write while a rooms change holds the lock",
      (busy.status === 409 && busy.json?.code === "BUSY") || busy.status === 400, JSON.stringify(busy.json));
    check("m5: nothing was written", (await q(`select 1 from organizer_payment_accounts where user_id = $1`, [ORG])).length === 0);
  } finally {
    await lockM5.query("select pg_advisory_unlock(41004, hashtext($1::text))", [ORG]).catch(() => {});
    lockM5.release();
  }
  restoreProv();
  setPaymentProviderForTests(null);

  // =============================================================== 6.2 earnings
  const V = await mk("viewer");
  const O = await mk("otherhost");
  const P = await mk("payer");
  const P2 = await mk("payer2");
  const G = await mk("guest");
  const rv1 = await mkRoom(V, "Viewer paid room");
  const rv2 = await mkRoom(V, "Viewer held room");
  const ro = await mkRoom(O, "Other room");
  await mkTicket(rv1, P, 500000);
  await mkTicket(rv1, P2, 500000);
  await mkTicket(rv2, P, 250000);
  await mkTicket(rv2, P2, 250000, { status: "refunded", refundedAt: true });
  await mkTicket(ro, P, 1000000);
  const tb5 = ticketBreakdown(500000).host, tb25 = ticketBreakdown(250000).host;
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at, paid_at, transfer_ref) values ($1,$2,$3,'paid', now() - interval '1 hour', now(), $4)`, [rv1, V, 2 * tb5 - 1000, `room-payout-${rv1}`]);
  await q(`insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo, recovered_kobo, origin, status)
           values ($1,$1,$2,3000,1000,'reversal','open')`, [V, await mkSpray({ roomId: rv1, hostId: V, payerId: P, recipientId: V, status: "reversed" })]);
  await mkSpray({ roomId: rv1, hostId: V, payerId: P, recipientId: V, status: "delivered" });
  await mkSpray({ roomId: ro, hostId: O, payerId: P, recipientId: V, status: "delivered" }); // V on O's stage
  await mkSpray({ roomId: ro, hostId: O, payerId: P2, recipientId: O, status: "delivered" }); // nothing of V's
  await mkSpray({ roomId: rv1, hostId: V, payerId: P, recipientId: G, status: "failed" });

  const bHost = sprayBreakdown("bundle", false).host, bStage = sprayBreakdown("bundle", true);
  r = await rest("GET", "/api/users/me/room-earnings?range=all", V);
  const e = r.json;
  check("earnings: own tickets only, refunds excluded", r.status === 200 && e.totals.ticketKobo === 2 * tb5 + tb25, r.text);
  check("earnings: own spray shares only (host share + stage share elsewhere)", e.totals.sprayKobo === bHost + (bStage.guest as number), r.text);
  check("settled = the payout Paystack confirmed (net of the clawback taken)", e.settledKobo === 2 * tb5 - 1000 && e.clawbackAppliedKobo === 1000, r.text);
  check("held = tickets of the room with no payout yet", e.heldTicketKobo === tb25, r.text);
  check("sprays are paid straight to the bank by Paystack, never 'settled' (r2 I4)",
    e.sprayDirectKobo === bHost + (bStage.guest as number) && e.onItsWayKobo === e.sprayDirectKobo + e.ticketSendingKobo, r.text);
  check("I2: the reversed spray's split share is returned (received, then clawed back), not earnings", e.sprayReturnedKobo === bHost && e.totals.sprayKobo === bHost + (bStage.guest as number), r.text);
  check("open clawback = amount minus recovered", e.clawbackOpenKobo === 2000, r.text);
  check("balance: settled + on its way + held = totals + returned - applied",
    e.settledKobo + e.onItsWayKobo + e.needsAttentionKobo + e.heldTicketKobo + e.sprayReturnedKobo
      === e.totals.sprayKobo + e.totals.ticketKobo + e.sprayReturnedKobo - e.clawbackAppliedKobo, r.text);
  check("byRoom: the viewer's rooms and the room where they were sprayed on stage, titles only",
    e.byRoom.length === 3 && e.byRoom.some((b: any) => b.roomId === ro && b.ticketKobo === 0 && b.sprayKobo === bStage.guest), r.text);
  check("no payer identity anywhere in the earnings answer", ![P, P2, G, "ea_payer"].some((s) => r.text.includes(s)));
  const eo = (await rest("GET", "/api/users/me/room-earnings?range=all", O)).json;
  check("another host sees only their own (never the viewer's)", eo.totals.ticketKobo === ticketBreakdown(1000000).host && eo.byRoom.every((b: any) => b.roomId === ro), JSON.stringify(eo));
  r = await rest("GET", "/api/users/me/room-earnings?range=year", V);
  check("bad range: 400", r.status === 400);
  r = await rest("GET", "/api/users/me/room-earnings", V);
  check("default range (week) works", r.status === 200 && typeof r.json?.settledKobo === "number");
  await q(`update users set age_verified_at = null where id = $1`, [V]);
  r = await rest("GET", "/api/users/me/room-earnings?range=all", V);
  check("lost verification keeps the history readable", r.status === 200 && r.json.totals.ticketKobo === e.totals.ticketKobo);

  // =============================================================== 6.3 payments and receipts
  const card = (await q(`insert into user_payment_methods (user_id, provider, auth_enc, last4, brand, reusable, signature) values ($1,'paystack','x','4242','visa',true,$2) returning id`, [P, `SIG_ea_${stamp}`]))[0].id;
  const evilTitle = `<script>alert('x')</script><img src=x onerror=alert(1)>`;
  const revil = await mkRoom(O, evilTitle);
  const tEvil = await mkTicket(revil, P, 100000, { ago: "30 minutes" });
  for (let n = 0; n < 23; n++) await mkTicket(await mkRoom(O, `Bulk room ${n}`), P, 100000, { ago: `${2 + n} days` });
  const sDel = await mkSpray({ roomId: ro, hostId: O, payerId: P, recipientId: O, status: "delivered", methodId: card, ago: "40 minutes" });
  const sRev = await mkSpray({ roomId: ro, hostId: O, payerId: P, recipientId: O, status: "reversed", methodId: card, ago: "50 minutes" });
  const tRef = await mkTicket(await mkRoom(O, "Refunded room"), P, 250000, { status: "refunded", refundedAt: false, ago: "20 minutes" });
  const theirs = await mkTicket(await mkRoom(O, "Someone else's"), P2, 100000);

  const seen: any[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    r = await rest("GET", `/api/users/me/room-payments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, P);
    if (r.status !== 200) break;
    seen.push(...r.json.items);
    cursor = r.json.next;
    pages++;
  } while (cursor && pages < 20);
  const ids = seen.map((i) => i.id);
  check("payments pages: every line once, more than one page", pages >= 2 && new Set(ids).size === ids.length, `${pages} ${ids.length}`);
  check("own lines only (another payer's ticket never listed)", !ids.includes(`tk_${theirs}`) && seen.every((i) => typeof i.title === "string"));
  check("refund lines are negative, with negative VAT", seen.filter((i) => i.kind === "refund").every((i) => i.amountKobo < 0 && i.vatKobo <= 0)
    && ids.includes(`tr_${tRef}`) && ids.includes(`sr_${sRev}`), JSON.stringify(seen.filter((i) => i.kind === "refund")));
  check("a refund not yet confirmed is pending; a confirmed one refunded",
    seen.find((i) => i.id === `tr_${tRef}`)?.status === "pending" && seen.find((i) => i.id === `sr_${sRev}`)?.status === "refunded");
  check("a refund line sits just above its purchase", ids.indexOf(`tr_${tRef}`) === ids.indexOf(`tk_${tRef}`) - 1 && ids.indexOf(`sr_${sRev}`) === ids.indexOf(`sp_${sRev}`) - 1, ids.slice(0, 8).join());
  check("lines never carry a host, a recipient or a reference", !seen.some((i) => JSON.stringify(i).match(new RegExp(`${O}|${V}|ea_sp_|ea_tk_|providerRef|recipient`))));
  // Stable: listing again from a cursor gives the same continuation.
  const first = await rest("GET", "/api/users/me/room-payments", P);
  const again = await rest("GET", `/api/users/me/room-payments?cursor=${encodeURIComponent(first.json.next)}`, P);
  check("pagination is stable (same cursor, same next page)", JSON.stringify(again.json.items.map((i: any) => i.id)) === JSON.stringify(ids.slice(first.json.items.length, first.json.items.length + again.json.items.length)));
  r = await rest("GET", "/api/users/me/room-payments?cursor=1%27%20or%201%3D1", P);
  check("a cursor we did not make: 400", r.status === 400 && r.json?.code === "BAD_CURSOR", r.text);

  const rc = await rest("GET", `/api/users/me/room-payments/tk_${tEvil}/receipt`, P);
  check("receipt: 200 with the exact safety headers", rc.status === 200
    && rc.headers.get("content-type") === "text/html; charset=utf-8"
    && (rc.headers.get("content-security-policy") ?? "").startsWith("default-src 'none'; style-src 'unsafe-inline'")
    && rc.headers.get("x-content-type-options") === "nosniff" && rc.headers.get("cache-control") === "private, no-store", JSON.stringify(Object.fromEntries(rc.headers)));
  check("receipt: the room title is escaped (no script, no img)", !/<script|<img|onerror=/i.test(rc.text) && rc.text.includes("&#60;script&#62;"), rc.text.slice(0, 300));
  check("receipt: never a host's or recipient's details", ![O, "ea_otherhost", `ea_otherhost${stamp}@t.dev`].some((s) => rc.text.includes(s)));
  const rs = await rest("GET", `/api/users/me/room-payments/sp_${sDel}/receipt`, P);
  check("spray receipt: card last four, the tier, VAT", rs.status === 200 && rs.text.includes("Card ending 4242") && rs.text.includes("Spray: Bundle") && rs.text.includes("VAT"), rs.text.slice(0, 200));
  for (const [label, as, id] of [
    ["another payer's ticket", P, `tk_${theirs}`],
    ["my ticket, asked by someone else", P2, `tk_${tEvil}`],
    ["my spray, asked by its host", O, `sp_${sDel}`],
    ["a refund line for a ticket that was not refunded", P, `tr_${tEvil}`],
    ["a malformed id", P, `tk_../../etc`],
    ["an unknown prefix", P, `zz_${tEvil}`],
  ] as const) {
    const x = await rest("GET", `/api/users/me/room-payments/${encodeURIComponent(id)}/receipt`, as);
    check(`receipt IDOR: ${label}: 404`, x.status === 404 && !x.text.includes("Receipt"), `${x.status}`);
  }
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  setPayoutProviderForTests(null);
  delete payoutTestHooks.verifiedName;
  try {
    if (created.length) {
      await q(`delete from payment_transactions where organizer_id = any($1::varchar[])`, [created]);
      await q(`delete from payment_issues where provider_payment_id in (select 'room-payout-' || room_id from room_payouts where host_id = any($1::varchar[]))`, [created]);
      await q(`delete from host_clawbacks where host_id = any($1::varchar[]) or beneficiary_id = any($1::varchar[])`, [created]);
      await q(`delete from spray_payments where payer_id = any($1::varchar[]) or host_id = any($1::varchar[])`, [created]);
      await q(`delete from user_payment_methods where user_id = any($1::varchar[])`, [created]);
      await q(`delete from room_payouts where host_id = any($1::varchar[])`, [created]);
      await q(`delete from room_tickets where room_id = any($1::varchar[])`, [madeRooms]);
      await q(`delete from rooms where id = any($1::varchar[])`, [madeRooms]);
      await q(`delete from organizer_payment_accounts where user_id = any($1::varchar[])`, [created]);
      await q(`delete from users where id = any($1::varchar[])`, [created]);
    }
  } catch (e: any) { console.log(`(cleanup failed: ${e.message})`); }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
