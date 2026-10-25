// Spray event log and the admin money ledger (list, detail, outcomes, attention, CSV, Paystack look-up).
// Throwaway database:   npm run test:rooms   (written in task 8, not yet run)
// Refuses to run unless the database name contains "test". Usernames use the prefix sg_. MOCK split provider; no network.
import crypto from "node:crypto";
import express from "express";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
process.env.SESSION_SECRET ||= "spray-ledger-test-session-secret";
delete process.env.ADMIN_MFA_REQUIRED;

await import("../server/storage");
const { registerRoomsAdminRoutes } = await import("../server/rooms/adminRoutes");
const { setSplitProviderForTests } = await import("../server/payments/splitProvider");
const { MockSplitProvider } = await import("../server/payments/mockSplitProvider");
const { makeSprayReference } = await import("../server/payments/sprayReference");
const { SPRAY_CATALOGUE, sprayBreakdown } = await import("../shared/money");
const ss = await import("../server/rooms/sprayStorage");
const bs = await import("../server/rooms/sprayBatchStorage");
const ev = await import("../server/rooms/sprayEvents");
const { ledgerTuning, resetProviderCheckLimit, PROVIDER_CHECKS_PER_MINUTE } = await import("../server/rooms/adminSprayLedger");
const { handleSprayChargeWebhook } = await import("../server/rooms/spray");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const mock = new MockSplitProvider();
setSplitProviderForTests(mock);

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { const id = req.header("x-test-admin"); req.session = { adminId: id || undefined, destroy: (cb?: () => void) => cb?.() }; next(); });
registerRoomsAdminRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, path: string, as: string | null) => {
  const res = await fetch(base + path, { method, headers: as ? { "x-test-admin": as } : {} });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* csv or empty */ }
  return { status: res.status, json, text, headers: res.headers };
};
const get = (path: string, as: string | null) => call("GET", path, as);

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const madeUsers: string[] = [], madeRooms: string[] = [], madeAdmins: string[] = [], madeBatches: string[] = [];
let seq = 0;
const mk = async (name: string) => {
  const id = (await q(`insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
    values ($1,$2,'social',$3,true,true,'1990-01-01', now() - interval '60 days') returning id`, [`sg_${name}${stamp}${++seq}@t.dev`, `sg_${name}${stamp}${seq}`, hash]))[0].id as string;
  madeUsers.push(id); return id;
};
const mkAdmin = async (role: string) => {
  const id = (await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,$3,$4,$5) returning id`,
    [`sg_admin_${role}${stamp}${++seq}@t.dev`, `sg_admin_${role}${stamp}${seq}`, hash, `sg ${role}`, role]))[0].id as string;
  madeAdmins.push(id); return id;
};
const mkRoom = async (host: string, title: string) => {
  const id = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status, started_at, created_at)
    values ($1,$2,'party','public','18+','live', now(), now()) returning id`, [host, title]))[0].id as string;
  madeRooms.push(id); return id;
};
const AMOUNT = SPRAY_CATALOGUE.bundle.kobo;
const bd = sprayBreakdown("bundle");
interface Seed { room: string; host: string; payer: string; recipient?: string; status?: string; minutesAgo?: number; ref?: string; reason?: string | null; paidMinutesAgo?: number | null; batchId?: string | null; subaccount?: string | null; key?: string }
const spray = async (o: Seed) => {
  const ref = o.ref ?? makeSprayReference(o.room, o.payer, "bundle", o.recipient ?? o.host, process.env.SESSION_SECRET!);
  const row = (await q(`insert into spray_payments (idempotency_key, request_hash, room_id, host_id, payer_id, recipient_id, tier, v3c, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, guest_kobo,
      provider, provider_ref, status, reason, created_at, paid_at, delivered_at, reversed_at, refund_requested_at, batch_id, recipient_subaccount)
    values ($1,$2,$3,$4,$5,$6,'bundle',$7::bigint,$7::int,$8,$9,$10,$11,$12,null,'paystack',$13,$14,$15, now() - ($16::int * interval '1 minute'),
      case when $17::int is null then null else now() - ($17::int * interval '1 minute') end,
      case when $14 = 'delivered' then now() - ($16::int * interval '1 minute') + interval '30 seconds' end,
      case when $14 = 'reversed' then now() - ($16::int * interval '1 minute') + interval '2 minutes' end,
      case when $14 in ('reversing', 'reversed') then now() - ($16::int * interval '1 minute') + interval '1 minute' end,
      $18::uuid, $19) returning id`,
    [o.key ?? `sg-${stamp}-${++seq}`, `h${seq}`, o.room, o.host, o.payer, o.recipient ?? o.host, AMOUNT, bd.vat, bd.fee, bd.reserve, bd.platform, bd.host, ref,
      o.status ?? "delivered", o.reason ?? null, o.minutesAgo ?? 1, o.paidMinutesAgo ?? null, o.batchId ?? null, o.subaccount ?? null]))[0];
  return { id: row.id as string, ref };
};
const events = async (sprayId: string) => q(`select * from spray_events where spray_id = $1 order by at, id`, [sprayId]);
const audits = async (action: string) => q(`select * from admin_activity_logs where action = $1 order by created_at desc`, [action]);

try {
  const FIN = await mkAdmin("finance_manager"), SA = await mkAdmin("super_admin"), MOD = await mkAdmin("content_moderator");
  const H = await mk("host"), P1 = await mk("payer1"), P2 = await mk("payer2"), G = await mk("guest");
  const ROOM = await mkRoom(H, "sg room =1+1,\"x\"");

  // ---------------------------------------------------------------- the event log
  {
    const a = await spray({ room: ROOM, host: H, payer: P1, status: "created", minutesAgo: 30 });
    const row = await ss.getSprayById(a.id);
    const pend = await ev.withSpraySource("api", () => ss.markSprayStatus(a.id, ["created"], "pending", { authorizationUrl: "https://checkout.test/x" }));
    const paid = await ev.withSpraySource("callback", () => ss.markSprayStatus(a.id, ["created", "pending"], "paid", { paidAt: new Date() }));
    const del = await ev.withSpraySource("sweep", () => ss.markSprayStatus(a.id, ["paid"], "delivered", { deliveredAt: new Date() }));
    const rev = await ev.withSpraySource("admin", () => ss.markSprayStatus(a.id, ["delivered"], "disputed", { reason: "DISPUTED" }));
    const log = await events(a.id);
    check("a status move returns the row and writes an event", !!row && !!pend && !!paid && !!del && !!rev && log.length === 4, JSON.stringify(log.map((e) => e.to_status)));
    check("webhook callback writes source callback", log[1]?.to_status === "paid" && log[1]?.source === "callback");
    check("sweep writes source sweep", log[2]?.to_status === "delivered" && log[2]?.source === "sweep");
    check("admin action writes source admin", log[3]?.to_status === "disputed" && log[3]?.source === "admin" && log[3]?.detail === "DISPUTED");
    check("api writes source api and from_status when one status was named", log[0]?.source === "api" && log[0]?.from_status === "created" && log[1]?.from_status === null);
    const lost = await ss.markSprayStatus(a.id, ["created"], "pending");
    check("a lost conditional move writes no event", lost === null && (await events(a.id)).length === 4);

    // a log write failure must not fail the spray
    const b = await spray({ room: ROOM, host: H, payer: P1, status: "created", minutesAgo: 30 });
    const errs: string[] = [];
    const origErr = console.error; console.error = (...x: any[]) => { errs.push(x.join(" ")); };
    ev.sprayEventTestHooks.failWrite = () => true;
    const moved = await ss.markSprayStatus(b.id, ["created"], "pending");
    ev.sprayEventTestHooks.failWrite = undefined;
    console.error = origErr;
    check("a log write failure does not fail the spray", moved?.status === "pending" && (await ss.getSprayById(b.id))?.status === "pending"
      && (await events(b.id)).length === 0 && errs.some((e) => e.includes("ALERT")), JSON.stringify(errs));

    // inside a raw transaction the failed write must not poison it
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`update spray_payments set status = 'paid' where id = $1`, [b.id]);
      await ev.recordSprayEvent({ sprayId: b.id, roomId: ROOM, from: "pending", to: "not-a-source", source: "bogus" as any }, c);
      const still = await c.query(`select status from spray_payments where id = $1`, [b.id]);
      await c.query("COMMIT");
      check("a failed event in a transaction does not abort it (savepoint)", still.rows[0]?.status === "paid");
    } finally { c.release(); }

    // team: batch + shares
    const batchRef = makeSprayReference(ROOM, P1, "bundle", H, process.env.SESSION_SECRET!);
    const batch = (await q(`insert into spray_batches (idempotency_key, request_hash, room_id, host_id, payer_id, featured_id, side, tier, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, host_subaccount, provider, provider_ref, status)
      values ($1,'h',$2,$3,$4,$5,'A','bundle',$6,$7,$8,$9,'ACCT_hostbatch0001','paystack',$10,'created') returning id`, [`sg-b-${stamp}`, ROOM, H, P1, G, AMOUNT * 2, bd.vat * 2, bd.fee * 2, bd.reserve * 2, batchRef]))[0].id as string;
    madeBatches.push(batch);
    const s1 = await spray({ room: ROOM, host: H, payer: P1, recipient: H, status: "created", batchId: batch, subaccount: "ACCT_hostbatch0001", ref: `${batchRef}.0`, key: `sg-b-${stamp}:0` });
    const s2 = await spray({ room: ROOM, host: H, payer: P1, recipient: G, status: "created", batchId: batch, subaccount: "ACCT_guestshare01", ref: `${batchRef}.1`, key: `sg-b-${stamp}:1` });
    const moved2 = await ev.withSpraySource("callback", () => bs.markBatchStatus(batch, ["created"], "pending"));
    const shareEv = [...await events(s1.id), ...await events(s2.id)];
    const batchEv = await q(`select * from spray_events where batch_id = $1 and spray_id is null`, [batch]);
    check("team share events carry batch_id", !!moved2 && shareEv.length === 2 && shareEv.every((e) => e.batch_id === batch && e.to_status === "pending" && e.source === "callback") && batchEv.length === 1);
  }

  // an end-to-end webhook: a real finalize through the mock provider
  {
    const w = await spray({ room: ROOM, host: H, payer: P1, status: "pending", minutesAgo: 1 });
    await mock.startFirstPayment({ reference: w.ref, email: "x@example.com", amountKobo: AMOUNT, split: { shares: [{ subaccountCode: "ACCT_hosthost01", amountKobo: bd.host }] }, metadata: { roomId: ROOM }, callbackUrl: "https://vib3pulse.test/cb" });
    mock.completeCheckout(w.ref);
    await handleSprayChargeWebhook(w.ref);
    const log = await events(w.id);
    check("a webhook finalize logs paid then delivered, source callback", log.map((e) => e.to_status).join(",") === "paid,delivered" && log.every((e) => e.source === "callback"), JSON.stringify(log.map((e) => [e.to_status, e.source])));
  }

  // ---------------------------------------------------------------- the ledger API
  const day = new Date().toISOString().slice(0, 10);
  const range = `from=${day}&to=${day}`;
  const base0 = (await get(`/api/admin/rooms/sprays/outcomes?${range}`, FIN)).json;

  const ROOM2 = await mkRoom(H, "sg ledger room");
  const mine = [
    await spray({ room: ROOM2, host: H, payer: P1, status: "delivered", minutesAgo: 50 }),
    await spray({ room: ROOM2, host: H, payer: P2, status: "reversed", reason: "AMOUNT_MISMATCH", minutesAgo: 49, paidMinutesAgo: 49 }),
    await spray({ room: ROOM2, host: H, payer: P1, status: "failed", reason: "DECLINED", minutesAgo: 48 }),
    await spray({ room: ROOM2, host: H, payer: P2, status: "disputed", minutesAgo: 47, paidMinutesAgo: 47 }),
    await spray({ room: ROOM2, host: H, payer: P1, status: "pending", minutesAgo: 20 }),   // attention: pending over 15 minutes
    await spray({ room: ROOM2, host: H, payer: P2, status: "pending", minutesAgo: 2 }),    // fresh: not in attention
    await spray({ room: ROOM2, host: H, payer: P1, status: "paid", minutesAgo: 12, paidMinutesAgo: 10 }), // attention: paid, not delivered
    await spray({ room: ROOM2, host: H, payer: P2, status: "reversing", minutesAgo: 40, paidMinutesAgo: 40 }),
  ];
  const ids = new Set(mine.map((m) => m.id));

  const L = await get(`/api/admin/rooms/sprays/transactions?${range}&roomId=${ROOM2}&limit=100`, FIN);
  const r0 = (L.json?.rows ?? []).find((r: any) => r.id === mine[0].id);
  check("list returns the row shape", L.status === 200 && L.json.rows.length === 8 && r0?.kind === "single" && r0.roomTitle === "sg ledger room" && /^sg_host/.test(r0.hostUsername)
    && r0.status === "delivered" && r0.endedAs.startsWith("Delivered to sg_host") && r0.amountKobo === AMOUNT && typeof r0.providerRef === "string" && typeof r0.createdAt === "string", JSON.stringify(L.json?.rows?.[0]));
  const endedMap = Object.fromEntries(L.json.rows.map((r: any) => [r.id, r.endedAs]));
  check("endedAs reads plainly per status", endedMap[mine[1].id] === "Refunded to payer" && endedMap[mine[2].id] === "Failed: card declined" && endedMap[mine[3].id] === "Disputed"
    && endedMap[mine[4].id] === "Still pending" && endedMap[mine[6].id] === "Paid, not yet delivered" && endedMap[mine[7].id] === "Reversing", JSON.stringify(endedMap));

  // paging, no duplicates
  const seen: string[] = [];
  let cursor = "", pages = 0;
  do {
    const pg = await get(`/api/admin/rooms/sprays/transactions?${range}&roomId=${ROOM2}&limit=3${cursor ? `&cursor=${cursor}` : ""}`, FIN);
    seen.push(...pg.json.rows.map((r: any) => r.id));
    cursor = pg.json.nextCursor ?? ""; pages++;
  } while (cursor && pages < 10);
  check("transactions list filters and paginates, no duplicates across pages", seen.length === 8 && new Set(seen).size === 8 && seen.every((i) => ids.has(i)) && pages === 3, `${seen.length} ${pages}`);
  const orderOk = (await get(`/api/admin/rooms/sprays/transactions?${range}&roomId=${ROOM2}&limit=100`, FIN)).json.rows.every((r: any, i: number, a: any[]) => i === 0 || a[i - 1].createdAt >= r.createdAt);
  check("newest first", orderOk);
  const f1 = await get(`/api/admin/rooms/sprays/transactions?${range}&roomId=${ROOM2}&status=pending`, FIN);
  const f2 = await get(`/api/admin/rooms/sprays/transactions?${range}&roomId=${ROOM2}&payerId=${P2}`, FIN);
  const f3 = await get(`/api/admin/rooms/sprays/transactions?${range}&roomId=${ROOM2}&hostId=${H}&recipientId=${H}&status=delivered`, FIN);
  check("filters: status, payer, host + recipient", f1.json.rows.length === 2 && f2.json.rows.length === 4 && f3.json.rows.length === 1);
  check("bad filters are 400", (await get(`/api/admin/rooms/sprays/transactions?${range}&status=nope`, FIN)).status === 400
    && (await get(`/api/admin/rooms/sprays/transactions?${range}&cursor=garbage`, FIN)).status === 400
    && (await get(`/api/admin/rooms/sprays/transactions?from=2020-01-01&to=2022-01-01`, FIN)).status === 400
    && (await get(`/api/admin/rooms/sprays/transactions?${range}&limit=0`, FIN)).status === 400);
  const big = await get(`/api/admin/rooms/sprays/transactions?${range}&limit=5000`, FIN);
  check("limit is capped at 100", big.status === 200 && big.json.rows.length <= 100);
  const byRef = await get(`/api/admin/rooms/sprays/transactions?${range}&q=${mine[0].ref}`, FIN);
  const byUser = await get(`/api/admin/rooms/sprays/transactions?${range}&roomId=${ROOM2}&q=${encodeURIComponent(r0.payerUsername.slice(0, 12).toUpperCase())}`, FIN);
  const byPct = await get(`/api/admin/rooms/sprays/transactions?${range}&q=${encodeURIComponent("%")}`, FIN);
  check("q finds by provider_ref (exact) and by username prefix; % is not a wildcard", byRef.json.rows.length === 1 && byRef.json.rows[0].id === mine[0].id && byUser.json.rows.length >= 4 && byPct.json.rows.length === 0);

  // detail
  const D = await get(`/api/admin/rooms/sprays/transactions/${mine[0].id}`, FIN);
  check("detail: full split, masked host subaccount, synthetic timeline for a row with no events", D.status === 200 && D.json.synthetic === true
    && D.json.tx.vatKobo === bd.vat && D.json.tx.feeKobo === bd.fee && D.json.tx.reserveKobo === bd.reserve && D.json.tx.platformKobo === bd.platform && D.json.tx.hostKobo === bd.host && D.json.tx.provider === "paystack"
    && D.json.timeline.map((t: any) => t.toStatus).join(",") === "created,delivered" && D.json.siblings.length === 0, JSON.stringify(D.json));
  const tl = await spray({ room: ROOM2, host: H, payer: P1, status: "created", minutesAgo: 5 });
  await ev.withSpraySource("api", () => ss.markSprayStatus(tl.id, ["created"], "pending"));
  await ev.withSpraySource("callback", () => ss.markSprayStatus(tl.id, ["pending"], "paid", { paidAt: new Date() }));
  await ev.withSpraySource("callback", () => ss.markSprayStatus(tl.id, ["paid"], "delivered", { deliveredAt: new Date() }));
  const D2 = await get(`/api/admin/rooms/sprays/transactions/${tl.id}`, FIN);
  check("detail returns timeline in order, from the event log", D2.json.synthetic === false && D2.json.timeline.map((t: any) => t.toStatus).join(",") === "pending,paid,delivered"
    && D2.json.timeline.every((t: any, i: number, a: any[]) => i === 0 || a[i - 1].at <= t.at) && D2.json.timeline[0].source === "api", JSON.stringify(D2.json.timeline));
  check("detail 404s for an unknown or malformed id", (await get(`/api/admin/rooms/sprays/transactions/${crypto.randomUUID()}`, FIN)).status === 404 && (await get(`/api/admin/rooms/sprays/transactions/not-a-uuid`, FIN)).status === 404);

  // a team share shows its batch, siblings and the share's subaccount, masked
  const sh = (await q(`select id, batch_id from spray_payments where batch_id = $1 order by idempotency_key`, [madeBatches[0]]));
  const DS = await get(`/api/admin/rooms/sprays/transactions/${sh[1].id}`, FIN);
  check("a team share lists its siblings and masks subaccounts to the last 4", DS.status === 200 && DS.json.tx.kind === "team_share" && DS.json.tx.batchId === madeBatches[0] && DS.json.siblings.length === 1
    && DS.json.tx.hostSubaccountLast4 === "0001" && DS.json.tx.recipientSubaccountLast4 === "re01" && !DS.text.includes("ACCT_"), JSON.stringify(DS.json?.tx));

  // outcomes
  const O = await get(`/api/admin/rooms/sprays/outcomes?${range}`, FIN);
  const fb = (j: any, k: string) => (j.funnel[k].count) - (base0.funnel[k].count);
  check("outcomes reconcile to the list", O.status === 200 && fb(O.json, "initiated") >= 9
    && ["paid", "delivered", "failed", "reversed", "disputed", "pending"].reduce((n, k) => n + O.json.funnel[k].count, 0) === O.json.funnel.initiated.count
    && ["paid", "delivered", "failed", "reversed", "disputed", "pending"].reduce((n, k) => n + O.json.funnel[k].kobo, 0) === O.json.funnel.initiated.kobo
    && O.json.byDay.reduce((n: number, d: any) => n + d.initiated.count, 0) === O.json.funnel.initiated.count, JSON.stringify(O.json.funnel));
  let listed = 0, cur = "";
  do {
    const pg = await get(`/api/admin/rooms/sprays/transactions?${range}&limit=100${cur ? `&cursor=${cur}` : ""}`, FIN);
    listed += pg.json.rows.length; cur = pg.json.nextCursor ?? "";
  } while (cur);
  check("outcomes: every listed row is in exactly one bucket", listed === O.json.funnel.initiated.count, `${listed} vs ${O.json.funnel.initiated.count}`);

  // attention
  const A = await get(`/api/admin/rooms/sprays/attention`, FIN);
  const att = (i: string) => (A.json.items ?? []).find((x: any) => x.tx.id === i);
  check("attention lists pending > 15 min, paid not delivered > 5 min, reversing, disputed; not a fresh pending",
    A.status === 200 && !!att(mine[4].id) && /pending/i.test(att(mine[4].id).why) && !!att(mine[6].id) && /not delivered/i.test(att(mine[6].id).why)
    && !!att(mine[7].id) && !!att(mine[3].id) && !att(mine[5].id) && !att(mine[0].id) && A.json.items.length <= 200, JSON.stringify(A.json.items?.map((x: any) => x.why)));

  // CSV
  const C = await get(`/api/admin/rooms/sprays/transactions.csv?${range}&roomId=${ROOM2}`, FIN);
  const lines = C.text.trim().split("\r\n");
  check("csv: columns", C.status === 200 && lines[0] === "id,created_at,status,ended_as,room,host,payer,recipient,tier,amount_ngn,vat,fee,reserve,platform,host_share,recipient_share,provider_ref,batch_id");
  check("csv: attachment, one row per spray", /attachment/.test(C.headers.get("content-disposition") ?? "") && /text\/csv/.test(C.headers.get("content-type") ?? "") && lines.length === 9);
  const C2 = await get(`/api/admin/rooms/sprays/transactions.csv?${range}&roomId=${ROOM}&status=delivered`, FIN);
  check("csv: a cell with a comma and quotes is quoted and doubled", C2.text.includes(`"sg room =1+1,""x"""`), C2.text);
  const injected = await mkRoom(H, "=cmd|' /C calc'!A0");
  await spray({ room: injected, host: H, payer: P1, status: "delivered" });
  const C3 = await get(`/api/admin/rooms/sprays/transactions.csv?${range}&roomId=${injected}`, FIN);
  check("csv: a cell starting with = gets a leading '", C3.text.includes("'=cmd|"), C3.text);
  ledgerTuning.csvMaxRows = 3;
  const C4 = await get(`/api/admin/rooms/sprays/transactions.csv?${range}&roomId=${ROOM2}`, FIN);
  ledgerTuning.csvMaxRows = 50_000;
  check("csv: over the cap is a 413 TOO_MANY_ROWS with no data", C4.status === 413 && C4.json?.code === "TOO_MANY_ROWS" && !C4.text.includes("id,created_at"));
  const ex = await audits("room_spray.export");
  check("csv export audited", ex.length >= 3 && /"rows":8/.test(ex.find((a) => a.details.includes(ROOM2))?.details ?? ""), JSON.stringify(ex[0]));

  // Paystack look-up (read-only)
  const vref = mine[0].ref;
  await mock.startFirstPayment({ reference: vref, email: "x@example.com", amountKobo: AMOUNT, split: { shares: [{ subaccountCode: "ACCT_hosthost01", amountKobo: bd.host }] }, metadata: { roomId: ROOM2 }, callbackUrl: "https://vib3pulse.test/cb" });
  mock.completeCheckout(vref);
  const snap = async () => JSON.stringify(await q(`select * from spray_payments where id = $1`, [mine[0].id]));
  const before = await snap(), refundsBefore = mock.refunds.length, evBefore = (await events(mine[0].id)).length;
  const ck = await call("POST", `/api/admin/rooms/sprays/transactions/${mine[0].id}/paystack-check`, FIN);
  check("paystack-check: match", ck.status === 200 && ck.json.match === true && ck.json.mismatches.length === 0 && ck.json.ours.status === "delivered" && ck.json.provider.status === "success"
    && ck.json.provider.amountKobo === AMOUNT && typeof ck.json.checkedAt === "string" && ck.json.provider.split.subaccountLast4[0] === "st01", JSON.stringify(ck.json));
  mock.tamper(vref, { amountKobo: AMOUNT + 5 });
  const mm = await call("POST", `/api/admin/rooms/sprays/transactions/${mine[0].id}/paystack-check`, FIN);
  check("paystack-check: mismatch", mm.status === 200 && mm.json.match === false && mm.json.mismatches.length === 1 && /Amount differs/.test(mm.json.mismatches[0]), JSON.stringify(mm.json));
  mock.tamper(vref, { amountKobo: AMOUNT });
  const unk = await call("POST", `/api/admin/rooms/sprays/transactions/${mine[4].id}/paystack-check`, FIN);
  check("paystack-check: the provider has no record is a mismatch, not an error", unk.status === 200 && unk.json.provider === null && unk.json.match === false);
  mock.verifyMode = "outage";
  const down = await call("POST", `/api/admin/rooms/sprays/transactions/${mine[0].id}/paystack-check`, FIN);
  mock.verifyMode = "ok";
  check("paystack-check: provider down is 502 PROVIDER_UNAVAILABLE with no detail", down.status === 502 && down.json?.code === "PROVIDER_UNAVAILABLE" && !/outage|mock/i.test(down.text), down.text);
  check("paystack-check: read-only (rows unchanged, no refund, no events)", (await snap()) === before && mock.refunds.length === refundsBefore && (await events(mine[0].id)).length === evBefore);
  const au = await audits("room_spray.provider_check");
  check("paystack-check: audited", au.filter((a) => a.target_id === mine[0].id).length === 3 && au.some((a) => /"result":"provider_unavailable"/.test(a.details)) && au.some((a) => /"result":"mismatch"/.test(a.details)) && au.some((a) => /"result":"match"/.test(a.details)));
  const rl = await mkAdmin("finance_manager");
  resetProviderCheckLimit();
  let limited = 0;
  for (let i = 0; i < PROVIDER_CHECKS_PER_MINUTE + 2; i++) if ((await call("POST", `/api/admin/rooms/sprays/transactions/${mine[0].id}/paystack-check`, rl)).status === 429) limited++;
  check("paystack-check: rate limited at 20 a minute per admin", limited === 2);


  // events in one transaction come back in write order (seq), not by random id
  {
    const sq = await spray({ room: ROOM2, host: H, payer: P1, status: "created", minutesAgo: 3 });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const to of ["pending", "paid", "delivered", "reversing", "reversed"]) await ev.recordSprayEvent({ sprayId: sq.id, roomId: ROOM2, from: null, to, source: "api" }, c);
      await c.query("COMMIT");
    } finally { c.release(); }
    const order = (await get(`/api/admin/rooms/sprays/transactions/${sq.id}`, FIN)).json.timeline.map((t: any) => t.toStatus).join(",");
    check("two events in one transaction come back in write order", order === "pending,paid,delivered,reversing,reversed", order);
  }

  // 60 old disputes must not hide a new stuck pending (attention is capped and ordered per kind, newest first)
  {
    const R3 = await mkRoom(H, "sg attention room");
    for (let i = 0; i < 60; i++) await spray({ room: R3, host: H, payer: P1, status: "disputed", minutesAgo: 600 + i, paidMinutesAgo: 600 + i });
    const fresh = await spray({ room: R3, host: H, payer: P2, status: "pending", minutesAgo: 30 });
    const A2 = await get(`/api/admin/rooms/sprays/attention`, FIN);
    const disputed = (A2.json.items as any[]).filter((x) => x.kind === "disputed");
    check("60 old disputes do not hide a new stuck pending", A2.status === 200 && (A2.json.items as any[]).some((x) => x.tx.id === fresh.id && x.kind === "pending")
      && disputed.length === 50 && A2.json.capped.disputed === true && typeof A2.json.capped.pending === "boolean", JSON.stringify(A2.json.capped));
  }

  // roles
  const paths: [string, string][] = [
    ["GET", `/api/admin/rooms/sprays/transactions?${range}`], ["GET", `/api/admin/rooms/sprays/transactions.csv?${range}`], ["GET", `/api/admin/rooms/sprays/transactions/${mine[0].id}`],
    ["GET", `/api/admin/rooms/sprays/outcomes?${range}`], ["GET", `/api/admin/rooms/sprays/attention`], ["POST", `/api/admin/rooms/sprays/transactions/${mine[0].id}/paystack-check`],
  ];
  const denied = await Promise.all(paths.map(([m, p]) => call(m, p, MOD)));
  const anon = await Promise.all(paths.map(([m, p]) => call(m, p, null)));
  const sa = await get(`/api/admin/rooms/sprays/attention`, SA);
  check("non-finance admin 403 (and no session 401)", denied.every((r) => r.status === 403) && anon.every((r) => r.status === 401) && sa.status === 200, JSON.stringify([denied.map((r) => r.status), anon.map((r) => r.status)]));

  // no secrets or PII anywhere
  const all = [L.text, D.text, D2.text, DS.text, O.text, A.text, C.text, ck.text, mm.text, unk.text].join("\n");
  const FORBIDDEN = [/@t\.dev/, /auth_enc/i, /AUTH_/, /authorization_code|authorizationCode/, /password/i, /ACCT_/, /date_of_birth|dateOfBirth/, /\bemail\b/i, /\bphone/i];
  check("no secret/PII fields in any response", FORBIDDEN.every((re) => !re.test(all)), FORBIDDEN.filter((re) => re.test(all)).join(" "));
} finally {
  await q(`delete from spray_events where room_id = any($1)`, [madeRooms]).catch(() => {});
  await q(`delete from host_clawbacks where host_id = any($1)`, [madeUsers]).catch(() => {});
  await q(`delete from payment_transactions where buyer_user_id = any($1)`, [madeUsers]).catch(() => {});
  await q(`delete from spray_payments where room_id = any($1)`, [madeRooms]).catch(() => {});
  await q(`delete from spray_batches where id = any($1)`, [madeBatches]).catch(() => {});
  await q(`delete from admin_activity_logs where admin_id = any($1)`, [madeAdmins]).catch(() => {});
  await q(`delete from rooms where id = any($1)`, [madeRooms]).catch((e) => console.log(`(cleanup rooms failed: ${e.message})`));
  await q(`delete from users where id = any($1)`, [madeUsers]).catch((e) => console.log(`(cleanup users failed: ${e.message})`));
  await q(`delete from admin_users where id = any($1)`, [madeAdmins]).catch(() => {});
  setSplitProviderForTests(null);
  server.close(); await pool.end();
}
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
