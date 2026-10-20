// Spraying (phase 5) storage helpers against a scratch database:   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-spraystorage.ts
// Refuses to run unless the database name contains "test" (it creates users). Usernames use the prefix sps_.
// No provider, no routes: only server/rooms/sprayStorage.ts and the schema SQL. Nothing waits on a fixed sleep.
import pg from "pg";
import { randomUUID } from "node:crypto";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { RoomMoneyRecordsError, storage, db } = await import("../server/storage");
const S = await import("../server/rooms/sprayStorage");
const { SPRAY_SCHEMA_SQL } = await import("../server/rooms/sprayMigration");
const { sprayBreakdown } = await import("../shared/money");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (e) => console.log(`(pool error ignored: ${e.message})`));
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};
const pgCode = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? String(e?.message ?? e); } };

const stamp = Date.now();
const created: string[] = [];
const mk = async (name: string) => {
  const id = (await q(
    `insert into users (email, username, user_type, is_verified, onboarding_complete, date_of_birth, created_at)
     values ($1,$2,'social',true,true,'1990-01-01', now() - interval '60 days') returning id`,
    [`sps_${name}${stamp}@t.dev`, `sps_${name}${stamp}`]))[0].id as string;
  created.push(id);
  return id;
};
const mkRoom = async (hostId: string) => (await q(
  `insert into rooms (host_id, title, status, age_limit, visibility) values ($1, 'spray storage', 'live', '18+', 'public') returning id`, [hostId]))[0].id as string;
let refSeq = 0;
const sprayRow = (roomId: string, hostId: string, payerId: string, recipientId: string, key = randomUUID(), tier: "note" | "bag" = "note") => {
  const b = sprayBreakdown(tier);
  return {
    idempotencyKey: key, requestHash: "a".repeat(64), roomId, hostId, payerId, recipientId, tier, v3c: b.price,
    amountKobo: b.price, vatKobo: b.vat, feeKobo: b.fee, reserveKobo: b.reserve, platformKobo: b.platform, hostKobo: b.host, guestKobo: null,
    provider: "mock", providerRef: `vib3rs_${stamp}_${++refSeq}`,
  };
};

try {
  // ---- schema SQL applies on top of whatever is there, twice, with each named constraint once
  check("spray schema SQL applies", (await pgCode(() => pool.query(SPRAY_SCHEMA_SQL))) === "ok");
  check("spray schema SQL is idempotent (second run)", (await pgCode(() => pool.query(SPRAY_SCHEMA_SQL))) === "ok");
  const cons = await q(`select conname, count(*)::int n from pg_constraint where conrelid in
    ('users'::regclass, 'spray_payments'::regclass, 'user_payment_methods'::regclass, 'room_spend'::regclass, 'host_clawbacks'::regclass)
    and contype in ('c','u','p') group by conname`);
  const names = new Map(cons.map((c: any) => [c.conname, c.n]));
  const want = ["users_spray_daily_limit_kobo_check", "user_payment_methods_user_signature_key", "spray_payments_provider_ref_key", "spray_payments_payer_key_key",
    "spray_payments_status_check", "spray_payments_tier_check", "spray_payments_amounts_check", "spray_payments_not_self_check", "room_spend_pkey",
    "room_spend_spent_check", "host_clawbacks_spray_beneficiary_key", "host_clawbacks_status_check", "host_clawbacks_amount_check",
    "room_spend_limit_check", "host_clawbacks_origin_check", "host_clawbacks_recovered_check", "host_clawbacks_written_off_check"];
  check("every named constraint exists exactly once", want.every((n) => names.get(n) === 1), JSON.stringify(Object.fromEntries(names)));
  const fk = await q(`select conrelid::regclass::text t, confdeltype from pg_constraint where contype = 'f' and conrelid in ('spray_payments'::regclass, 'host_clawbacks'::regclass)`);
  check("spray_payments and host_clawbacks foreign keys are all RESTRICT ('r')", fk.length >= 8 && fk.every((x: any) => x.confdeltype === "r"), JSON.stringify(fk));
  const wob = await q(`select confrelid::regclass::text as t from pg_constraint where contype = 'f' and conrelid = 'host_clawbacks'::regclass
                        and conkey = array[(select attnum from pg_attribute where attrelid = 'host_clawbacks'::regclass and attname = 'written_off_by')]::smallint[]`);
  check("fix round: host_clawbacks.written_off_by references admin_users", wob.length === 1 && wob[0].t === "admin_users", JSON.stringify(wob));

  const H = await mk("host"), P = await mk("payer"), P2 = await mk("payer2"), G = await mk("guest");
  const R = await mkRoom(H);

  // ---- addSpend: atomic, never over the limit
  check("addSpend within the limit", await S.addSpend(R, P, 50000, 200000));
  check("addSpend up to exactly the limit", await S.addSpend(R, P, 150000, 200000));
  check("addSpend one kobo over: false", !(await S.addSpend(R, P, 1, 200000)));
  check("spent unchanged after a refusal", (await S.getRoomSpend(R, P))?.spentKobo === 200000);
  await S.releaseSpend(R, P, 50000);
  check("releaseSpend gives it back", (await S.getRoomSpend(R, P))?.spentKobo === 150000);
  await S.releaseSpend(R, P, 999999);
  check("releaseSpend never goes below zero", (await S.getRoomSpend(R, P))?.spentKobo === 0);
  check("addSpend refuses bad input (fail closed)", !(await S.addSpend(R, P, 0, 200000)) && !(await S.addSpend(R, P, 1.5, 200000)) && !(await S.addSpend(R, P, 50000, -1)));
  const par = await Promise.all(Array.from({ length: 5 }, () => S.addSpend(R, P2, 50000, 100000)));
  check("5 parallel addSpend of 50,000 against 100,000: exactly 2 pass", par.filter(Boolean).length === 2, JSON.stringify(par));
  check("and spent is exactly the limit", (await S.getRoomSpend(R, P2))?.spentKobo === 100000);
  check("an existing row keeps its stored limit (the passed limit only seeds)", !(await S.addSpend(R, P2, 50000, 10000000)));
  const lowered = await S.setRoomLimit(R, P2, 50000);
  check("setRoomLimit below spent stores the spent amount", lowered.limitKobo === 100000 && lowered.spentKobo === 100000, JSON.stringify(lowered));
  const raised = await S.setRoomLimit(R, P2, 500000);
  check("setRoomLimit raise", raised.limitKobo === 500000);

  // ---- insertSprayIfNew: one row per (payer, key), parallel safe, per payer only
  const key = randomUUID();
  const ins = await Promise.all(Array.from({ length: 4 }, () => S.insertSprayIfNew(sprayRow(R, H, P, H, key))));
  check("4 parallel inserts with one key: exactly one created, one row", ins.filter((x) => x.created).length === 1 && new Set(ins.map((x) => x.row.id)).size === 1);
  const other = await S.insertSprayIfNew(sprayRow(R, H, P2, H, key));
  check("another payer can use the same key (unique per payer, no squatting)", other.created && other.row.id !== ins[0].row.id);
  const sp = ins[0].row;
  check("getSprayById / getSprayByRef", (await S.getSprayById(sp.id))?.id === sp.id && (await S.getSprayByRef(sp.providerRef))?.id === sp.id);
  check("getSprayById with a non-uuid is null, not an error", (await S.getSprayById("not-a-uuid")) === null);
  check("getSprayById with 36 dashes / misplaced dashes is null, not a SQL error (strict uuid)",
    (await S.getSprayById("-".repeat(36))) === null && (await S.getSprayById("0000000000000000000000000000000000-0")) === null);
  check("self spray refused by the database", (await pgCode(() => S.insertSprayIfNew(sprayRow(R, H, P, P)))) === "23514");
  check("a wrong split is refused by the database", (await pgCode(() => S.insertSprayIfNew({ ...sprayRow(R, H, P, H), hostKobo: 1 }))) === "23514");
  check("an amount under 50,000 is refused by the database", (await pgCode(() => S.insertSprayIfNew({ ...sprayRow(R, H, P, H), amountKobo: 2000, v3c: 2000 }))) === "23514");

  // ---- markSprayStatus: conditional, one winner
  const marks = await Promise.all([1, 2, 3].map(() => S.markSprayStatus(sp.id, ["created", "pending"], "paid", { paidAt: new Date() })));
  check("3 parallel created->paid: exactly one wins", marks.filter(Boolean).length === 1);
  check("paid->delivered once", !!(await S.markSprayStatus(sp.id, ["paid"], "delivered", { deliveredAt: new Date() })) && !(await S.markSprayStatus(sp.id, ["paid"], "delivered")));
  check("a terminal row does not move back", !(await S.markSprayStatus(sp.id, ["created", "pending", "paid"], "failed", { reason: "DECLINED" })));

  // ---- counts and sums
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  check("sumPayerKoboSince counts the delivered note", (await S.sumPayerKoboSince(db, P, since)) >= 50000);
  check("countPayerSprays / countPayerRecipientSprays", (await S.countPayerSprays(P, since)) >= 1 && (await S.countPayerRecipientSprays(P, H, since)) >= 1 && (await S.countPayerRecipientSprays(P, G, since)) === 0);
  const stale = await S.insertSprayIfNew(sprayRow(R, H, P2, H));
  check("listStaleSprays finds an old created row", (await S.listStaleSprays(["created"], new Date(Date.now() + 60000), 50)).some((r) => r.id === stale.row.id));
  check("listStaleSprays ignores a fresh row with an old cut-off", !(await S.listStaleSprays(["created"], new Date(Date.now() - 3600000), 50)).some((r) => r.id === stale.row.id));
  // fix round: fair order and backoff
  const stale2 = await S.insertSprayIfNew(sprayRow(R, H, P2, G));
  await S.noteSprayChecked(stale.row.id, new Date(), new Date(Date.now() + 10 * 60_000));
  const due = await S.listStaleSprays(["created"], new Date(Date.now() + 60000), 50, { dueAt: new Date() });
  check("noteSprayChecked: a row in backoff is skipped while it is not due", !due.some((r) => r.id === stale.row.id) && due.some((r) => r.id === stale2.row.id));
  const later = await S.listStaleSprays(["created"], new Date(Date.now() + 60000), 50, { dueAt: new Date(Date.now() + 11 * 60_000) });
  check("listStaleSprays: never-checked rows come before checked ones", later.findIndex((r) => r.id === stale2.row.id) < later.findIndex((r) => r.id === stale.row.id) && later.some((r) => r.id === stale.row.id));
  check("noteSprayChecked counts attempts", Number((await q(`select check_attempts from spray_payments where id = $1`, [stale.row.id]))[0]?.check_attempts) === 1);
  check("listStaleSprays createdSince filters old rows out", !(await S.listStaleSprays(["created"], new Date(Date.now() + 60000), 50, { createdSince: new Date(Date.now() + 60000) })).length);
  check("payerRecipientInFlight sees a created row of that pair only", await S.payerRecipientInFlight(P2, G, new Date(Date.now() - 60000)) && !(await S.payerRecipientInFlight(P2, P, new Date(Date.now() - 60000))));
  check("sumReceivedSince counts sprays a person hosted or received", (await S.sumReceivedSince(G, since, ["created"], null)) >= stale2.row.amountKobo
    && (await S.sumReceivedSince(G, since, ["created"], stale2.row.id)) === 0);

  // ---- clawbacks
  const cb = await Promise.all([1, 2].map(() => S.insertClawbackIfNew({ hostId: H, beneficiaryId: H, sprayId: sp.id, amountKobo: sp.hostKobo })));
  check("clawback idempotent per (spray, beneficiary)", cb.filter((c) => c.created).length === 1);
  check("openClawbacksFor the beneficiary", (await S.openClawbacksFor(H)).length === 1 && (await S.openClawbacksFor(G)).length === 0);
  check("hasOpenClawback for the beneficiary only", (await S.hasOpenClawback([H])) && !(await S.hasOpenClawback([G, P])) && !(await S.hasOpenClawback([])));
  check("markClawbacksRecovered once", (await S.markClawbacksRecovered([cb[0].row.id])).length === 1 && (await S.markClawbacksRecovered([cb[0].row.id])).length === 0);
  check("recovered means recovered_kobo = amount_kobo", (await q(`select recovered_kobo, amount_kobo from host_clawbacks where id = $1`, [cb[0].row.id])).every((r: any) => Number(r.recovered_kobo) === Number(r.amount_kobo)));
  check("hasOpenClawback is false once recovered", !(await S.hasOpenClawback([H])));
  const rc = await S.insertClawbackIfNew({ hostId: H, beneficiaryId: G, sprayId: sp.id, amountKobo: 1000, origin: "reversal" });
  check("insertClawbackIfNew stores the origin", rc.created && rc.row.origin === "reversal");
  check("the database refuses 'recovered' with less than the full amount", (await pgCode(() => q(`update host_clawbacks set status = 'recovered', recovered_kobo = 1 where id = $1`, [rc.row.id]))) === "23514");
  check("the database refuses a write-off without the admin", (await pgCode(() => q(`update host_clawbacks set status = 'written_off', written_off_reason = 'x' where id = $1`, [rc.row.id]))) === "23514");
  check("the database refuses written_off_by that is not an admin", (await pgCode(() => q(`update host_clawbacks set status = 'written_off', written_off_reason = 'x', written_off_by = $2 where id = $1`, [rc.row.id, H]))) === "23503");

  // ---- saved card
  check("a non-reusable card is never stored", (await S.saveMethod({ userId: P, provider: "mock", authEnc: "v1:x", last4: "4081", brand: "visa", bank: null, reusable: false, signature: "SIG_a" })) === null);
  const m1 = await S.saveMethod({ userId: P, provider: "mock", authEnc: "v1:x", last4: "4081", brand: "visa", bank: null, reusable: true, signature: "SIG_a" });
  const m2 = await S.saveMethod({ userId: P, provider: "mock", authEnc: "v1:y", last4: "4081", brand: "visa", bank: null, reusable: true, signature: "SIG_a" });
  check("the same card twice is one row", !!m1 && !!m2 && m1.id === m2.id);
  check("getSavedMethod", (await S.getSavedMethod(P))?.id === m1?.id);
  check("deleteMethod soft-deletes and wipes auth_enc", (await S.deleteMethod(P)) === 1 && (await S.getSavedMethod(P)) === null
    && (await q(`select auth_enc, deleted_at from user_payment_methods where id = $1`, [m1?.id]))[0]?.auth_enc === "");

  // ---- daily limit
  await S.setDailyLimit(P, 3000000);
  check("setDailyLimit / getDailyLimit", (await S.getDailyLimit(P)) === 3000000);
  await S.setDailyLimit(P, null);
  check("setDailyLimit null = default", (await S.getDailyLimit(P)) === null);

  // ---- money records block a hard delete
  let de: unknown = null;
  try { await storage.deleteUser(P); } catch (e) { de = e; }
  check("deleteUser of a payer with sprays is refused, account kept", de instanceof RoomMoneyRecordsError && !!(await storage.getUser(P)), String(de));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  try {
    if (created.length) {
      // Sprays and clawbacks are money records (RESTRICT): a scratch database is cleared explicitly first.
      await q(`delete from host_clawbacks where host_id = any($1::varchar[]) or beneficiary_id = any($1::varchar[])`, [created]);
      await q(`delete from spray_payments where payer_id = any($1::varchar[]) or host_id = any($1::varchar[])`, [created]);
      await q(`delete from users where id = any($1::varchar[])`, [created]); // rooms, room_spend, payment methods cascade
    }
  } catch (e: any) { console.log(`(cleanup failed: ${e.message})`); }
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
