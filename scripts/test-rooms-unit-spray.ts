// Spraying (phase 5): pure rules, limits, price and split, idempotency shape, the migration text, schema names and the
// redaction keys (no database):   npx tsx scripts/test-rooms-unit-spray.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  sprayEligibility, sprayLimits, sprayPrice, exceedsRoomLimit, isRoomLimitOption, requiresThreeDs, sprayTargetKind, spraySplit,
  idempotencyKeyShape, isTerminal, isSprayStatus, SPRAY_STATUSES, SPRAY_SPEND_STATUSES, SPRAY_REASONS,
  ROOM_LIMIT_OPTIONS_KOBO, ROOM_LIMIT_DEFAULT_KOBO, DAILY_DEFAULT_KOBO, DAILY_VERIFIED_MAX_KOBO, ID_REQUIRED_ABOVE_KOBO,
  THREE_DS_AT_KOBO, DELIVERY_DEADLINE_MS, NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT, NEW_HOST_WINDOW_DAYS, VELOCITY,
  type SprayEligibilityInput, type SprayCode,
} from "../shared/spray";
import { sprayBreakdown, SPRAY_TIERS, type SprayTier } from "../shared/money";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------- sprayEligibility
const base = (): SprayEligibilityInput => ({
  room: { ageLimit: "18+", status: "live", minorsRoom: false },
  payer: { userId: "payer", idVerifiedAdult: true, inRoom: true },
  recipient: { userId: "host", idVerifiedAdult: true, hasSubaccount: true, role: "host", onStage: false },
  host: { idVerifiedAdult: true, hasPayoutAccount: true },
  flags: { spray: true },
});
const guestOnStage = (): SprayEligibilityInput => ({ ...base(), recipient: { userId: "guest", idVerifiedAdult: true, hasSubaccount: true, role: "guest", onStage: true } });
const tweak = (f: (i: SprayEligibilityInput) => void, from = base) => { const i = from(); f(i); return i; };
const cases: Array<[string, SprayEligibilityInput, SprayCode | null]> = [
  ["host target, all good", base(), null],
  ["21+ room", tweak((i) => { i.room.ageLimit = "21+"; }), null],
  ["adult stage guest with a subaccount is payable", guestOnStage(), null],
  ["adult co-host on stage is payable", tweak((i) => { i.recipient.role = "cohost"; }, guestOnStage), null],
  ["flag off", tweak((i) => { i.flags.spray = false; }), "FEATURE_OFF"],
  ["flag off wins over everything", { ...tweak((i) => { i.flags.spray = false; i.payer.idVerifiedAdult = false; i.room.ageLimit = "13+"; }) }, "FEATURE_OFF"],
  ["flag missing (fail closed)", tweak((i) => { (i as any).flags = {}; }), "FEATURE_OFF"],
  ["flag truthy but not true (fail closed)", tweak((i) => { (i.flags as any).spray = "yes"; }), "FEATURE_OFF"],
  ["payer not ID-verified (teen or unverified adult)", tweak((i) => { i.payer.idVerifiedAdult = false; }), "PAYER_NOT_VERIFIED"],
  ["payer not verified wins over a 13+ room (no room information)", tweak((i) => { i.payer.idVerifiedAdult = false; i.room.ageLimit = "13+"; }), "PAYER_NOT_VERIFIED"],
  ["13+ room", tweak((i) => { i.room.ageLimit = "13+"; }), "ROOM_NOT_ELIGIBLE"],
  ["all-ages room", tweak((i) => { i.room.ageLimit = "all"; }), "ROOM_NOT_ELIGIBLE"],
  ["16+ room", tweak((i) => { i.room.ageLimit = "16+"; }), "ROOM_NOT_ELIGIBLE"],
  ["an 18+ minors' room never has spray", tweak((i) => { i.room.minorsRoom = true; }), "ROOM_NOT_ELIGIBLE"],
  ["scheduled room", tweak((i) => { i.room.status = "scheduled"; }), "ROOM_NOT_LIVE"],
  ["ended room", tweak((i) => { i.room.status = "ended"; }), "ROOM_NOT_LIVE"],
  ["payer not in the room", tweak((i) => { i.payer.inRoom = false; }), "PAYER_NOT_IN_ROOM"],
  ["payer banned or kicked", tweak((i) => { i.payer.banned = true; }), "PAYER_NOT_IN_ROOM"],
  ["self spray", tweak((i) => { i.recipient.userId = "payer"; }), "SELF"],
  ["host spraying themselves", tweak((i) => { i.payer.userId = "host"; }), "SELF"],
  ["guest off stage", tweak((i) => { i.recipient.onStage = false; }, guestOnStage), "RECIPIENT_NOT_ALLOWED"],
  ["teen recipient on stage", tweak((i) => { i.recipient.idVerifiedAdult = false; }, guestOnStage), "RECIPIENT_NOT_ALLOWED"],
  ["unverified host as recipient", tweak((i) => { i.recipient.idVerifiedAdult = false; }), "RECIPIENT_NOT_ALLOWED"],
  ["blocked pair", tweak((i) => { i.blocked = true; }), "RECIPIENT_NOT_ALLOWED"],
  ["recipient not present", tweak((i) => { i.recipient.present = false; }, guestOnStage), "RECIPIENT_NOT_ALLOWED"],
  ["unknown role (fail closed)", tweak((i) => { (i.recipient as any).role = "admin"; i.recipient.onStage = true; }), "RECIPIENT_NOT_ALLOWED"],
  ["stage guest without a payout account", tweak((i) => { i.recipient.hasSubaccount = false; }, guestOnStage), "RECIPIENT_NOT_PAYABLE"],
  ["host recipient without a payout account", tweak((i) => { i.recipient.hasSubaccount = false; }), "RECIPIENT_NOT_PAYABLE"],
  ["host not verified (stage guest target)", tweak((i) => { i.host.idVerifiedAdult = false; }, guestOnStage), "HOST_NOT_PAYABLE"],
  ["host without payout account (stage guest target)", tweak((i) => { i.host.hasPayoutAccount = false; }, guestOnStage), "HOST_NOT_PAYABLE"],
];
for (const [name, input, code] of cases) {
  test(`sprayEligibility: ${name} -> ${code ?? "ok"}`, () => assert.deepEqual(sprayEligibility(input), code === null ? { ok: true } : { ok: false, code }));
}
test("sprayEligibility: no anonymous field anywhere", () => {
  assert.doesNotMatch(src("shared/spray.ts"), /anonymous/i);
});

// ---------------------------------------------------------------- limits
test("limit constants (revisions C)", () => {
  assert.deepEqual([...ROOM_LIMIT_OPTIONS_KOBO], [50000, 100000, 200000, 500000, 1000000, 10000000]);
  assert.equal(ROOM_LIMIT_DEFAULT_KOBO, 200000);
  assert.equal(DAILY_DEFAULT_KOBO, 2000000);
  assert.equal(DAILY_VERIFIED_MAX_KOBO, 10000000);
  assert.equal(ID_REQUIRED_ABOVE_KOBO, 2000000);
  assert.equal(THREE_DS_AT_KOBO, 1000000);
  assert.equal(DELIVERY_DEADLINE_MS, 60000);
  assert.equal(NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT, 5000000);
  assert.equal(NEW_HOST_WINDOW_DAYS, 14);
  assert.deepEqual({ ...VELOCITY }, { perMinute: 10, perHour: 60, perRecipientPerMinute: 3 });
  assert.ok(ROOM_LIMIT_OPTIONS_KOBO.includes(ROOM_LIMIT_DEFAULT_KOBO));
});
test("sprayLimits works as an object and as a function with config", () => {
  assert.equal(sprayLimits.DAILY_DEFAULT_KOBO, 2000000);
  assert.equal(sprayLimits().NEW_HOST_RECEIVE_CAP_KOBO, 5000000);
  assert.equal(sprayLimits({ newHostReceiveCapKobo: 1000000 }).NEW_HOST_RECEIVE_CAP_KOBO, 1000000);
  for (const bad of [0, -1, 1.5, NaN, null]) assert.equal(sprayLimits({ newHostReceiveCapKobo: bad as number }).NEW_HOST_RECEIVE_CAP_KOBO, 5000000, String(bad));
  assert.ok(Object.isFrozen(ROOM_LIMIT_OPTIONS_KOBO) && Object.isFrozen(VELOCITY));
});
test("exceedsRoomLimit: equal to the limit is allowed, one kobo over is not", () => {
  assert.equal(exceedsRoomLimit(150000, 200000, 50000), false);
  assert.equal(exceedsRoomLimit(150001, 200000, 50000), true);
  assert.equal(exceedsRoomLimit(0, 50000, 50000), false);
  assert.equal(exceedsRoomLimit(0, 49999, 50000), true);
  for (const bad of [[-1, 200000, 50000], [0, NaN, 50000], [0, 200000, 0.5], [0, Infinity, 50000]]) {
    assert.equal(exceedsRoomLimit(bad[0], bad[1], bad[2]), true, `fail closed ${bad}`);
  }
});
test("isRoomLimitOption", () => {
  for (const o of ROOM_LIMIT_OPTIONS_KOBO) assert.equal(isRoomLimitOption(o), true);
  for (const o of [0, 150000, "200000", 200000.5, null]) assert.equal(isRoomLimitOption(o), false, String(o));
});

// ---------------------------------------------------------------- price, 3DS, target, split
test("sprayPrice: kobo, v3c, label, display (payer price text only)", () => {
  assert.deepEqual(sprayPrice("note"), { kobo: 50000, v3c: 50000, label: "Note", display: "₦500" });
  assert.deepEqual(sprayPrice("bundle"), { kobo: 100000, v3c: 100000, label: "Bundle", display: "₦1,000" });
  assert.deepEqual(sprayPrice("bag"), { kobo: 1000000, v3c: 1000000, label: "Money bag", display: "₦10,000" });
  assert.deepEqual(sprayPrice("rain"), { kobo: 10000000, v3c: 10000000, label: "Make it Rain", display: "₦100,000" });
  assert.throws(() => sprayPrice("n20" as SprayTier), RangeError);
});
test("labels never say cash", () => {
  for (const t of SPRAY_TIERS) assert.doesNotMatch(sprayPrice(t).label, /cash/i);
});
test("requiresThreeDs: bag and rain (>= 10,000 naira), not note or bundle; unknown tier fails closed", () => {
  assert.equal(requiresThreeDs("note"), false);
  assert.equal(requiresThreeDs("bundle"), false);
  assert.equal(requiresThreeDs("bag"), true);
  assert.equal(requiresThreeDs("rain"), true);
  assert.equal(requiresThreeDs("other" as SprayTier), true);
});
test("sprayTargetKind: host, stage person, anybody else null", () => {
  const room = { hostId: "h", stage: ["h", "g1", "c1"] };
  assert.equal(sprayTargetKind(room, "h"), "host");
  assert.equal(sprayTargetKind(room, "g1"), "stage");
  assert.equal(sprayTargetKind(room, "x"), null);
  assert.equal(sprayTargetKind(room, ""), null);
  assert.equal(sprayTargetKind({ hostId: "h", stage: [] }, "h"), "host", "the host is a target even off stage");
});
for (const t of SPRAY_TIERS) {
  test(`spraySplit(${t}): host gets the whole host share; a stage person gets sprayBreakdown(${t}, true)`, () => {
    const h = spraySplit(t, "host");
    assert.equal(h.hostKobo, sprayBreakdown(t).host);
    assert.equal(h.guestKobo, null);
    assert.deepEqual(h.breakdown, sprayBreakdown(t));
    const s = spraySplit(t, "stage");
    const b = sprayBreakdown(t, true);
    assert.equal(s.hostKobo, b.host);
    assert.equal(s.guestKobo, b.guest);
    assert.equal(s.hostKobo + (s.guestKobo as number) + b.platform + b.vat + b.fee + b.reserve, b.price);
  });
}
test("spraySplit refuses an unknown kind or tier", () => {
  assert.throws(() => spraySplit("note", "guest" as any), RangeError);
  assert.throws(() => spraySplit("n50" as SprayTier, "host"), RangeError);
});

// ---------------------------------------------------------------- idempotency key and status
test("idempotencyKeyShape: lowercase UUID v4 only", () => {
  assert.equal(idempotencyKeyShape("3b241101-e2bb-4255-8caf-4136c566a962"), true);
  for (const k of [
    "3B241101-E2BB-4255-8CAF-4136C566A962", // upper case
    "3b241101-e2bb-1255-8caf-4136c566a962", // version 1
    "3b241101-e2bb-4255-7caf-4136c566a962", // bad variant
    "3b241101e2bb42558caf4136c566a962", "", " 3b241101-e2bb-4255-8caf-4136c566a962", "3b241101-e2bb-4255-8caf-4136c566a962\n",
    123, null, undefined, {}, ["3b241101-e2bb-4255-8caf-4136c566a962"],
  ]) assert.equal(idempotencyKeyShape(k), false, JSON.stringify(k));
});
test("statuses: the eight, terminal ones, spend statuses", () => {
  assert.deepEqual([...SPRAY_STATUSES], ["created", "pending", "paid", "delivered", "reversing", "reversed", "failed", "disputed"]);
  const terminal = SPRAY_STATUSES.filter((s) => isTerminal(s));
  assert.deepEqual(terminal, ["delivered", "reversed", "failed", "disputed"]);
  assert.deepEqual([...SPRAY_SPEND_STATUSES], ["created", "pending", "paid", "delivered", "reversing", "disputed"]);
  assert.equal(isSprayStatus("paid"), true);
  assert.equal(isSprayStatus("refunded"), false);
  assert.deepEqual([...SPRAY_REASONS], ["DECLINED", "INSUFFICIENT_FUNDS", "NOT_REUSABLE", "NETWORK", "RECIPIENT_LEFT", "ROOM_ENDED", "TIMEOUT", "DISPUTED"]);
});

// ---------------------------------------------------------------- migration text
{
  const { SPRAY_SCHEMA_SQL } = await import("../server/rooms/sprayMigration");
  const norm = (x: string) => x.split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
  const file = src("migrations/add_spray.sql");
  test("migration file is BEGIN; <the exact ensureSchema statements>; COMMIT;", () => {
    assert.equal(norm(file), `BEGIN; ${norm(SPRAY_SCHEMA_SQL)} COMMIT;`);
  });
  test("migration is additive: no DROP, no DELETE, no UPDATE, no TRUNCATE", () => {
    assert.doesNotMatch(SPRAY_SCHEMA_SQL, /\bDROP\b|\bDELETE\b|\bUPDATE\b|\bTRUNCATE\b/i);
  });
  test("every CREATE / ADD COLUMN / ADD CONSTRAINT is guarded: re-running is a no-op", () => {
    const creates = SPRAY_SCHEMA_SQL.match(/CREATE (UNIQUE )?(TABLE|INDEX)/g) ?? [];
    const guarded = SPRAY_SCHEMA_SQL.match(/CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/g) ?? [];
    assert.equal(creates.length, guarded.length);
    const adds = SPRAY_SCHEMA_SQL.match(/ADD COLUMN/g) ?? [];
    assert.equal(adds.length, (SPRAY_SCHEMA_SQL.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
    for (const c of SPRAY_SCHEMA_SQL.match(/ADD CONSTRAINT (\w+)/g) ?? []) assert.match(SPRAY_SCHEMA_SQL, new RegExp(`conname = '${c.split(" ")[2]}'`));
  });
  test("money tables never cascade: spray_payments and host_clawbacks references are RESTRICT", () => {
    const block = (t: string) => { const s = SPRAY_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`); return SPRAY_SCHEMA_SQL.slice(s, SPRAY_SCHEMA_SQL.indexOf("\n);", s)); };
    for (const t of ["spray_payments", "host_clawbacks"]) {
      const b = block(t);
      assert.doesNotMatch(b, /CASCADE|SET NULL/i, t);
      const refs = b.match(/REFERENCES \w+\(id\)( ON DELETE RESTRICT)?/g) ?? [];
      assert.ok(refs.length > 0 && refs.every((r) => r.endsWith("ON DELETE RESTRICT")), `${t}: ${refs}`);
    }
    assert.match(block("spray_payments"), /room_id varchar NOT NULL REFERENCES rooms\(id\) ON DELETE RESTRICT/);
    assert.match(block("spray_payments"), /payer_id varchar NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/);
    assert.match(block("spray_payments"), /recipient_id varchar NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/);
    assert.match(block("spray_payments"), /host_id varchar NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/);
  });
  test("idempotency key unique PER PAYER, never global; provider_ref unique", () => {
    assert.match(SPRAY_SCHEMA_SQL, /CONSTRAINT spray_payments_payer_key_key UNIQUE \(payer_id, idempotency_key\)/);
    assert.doesNotMatch(SPRAY_SCHEMA_SQL, /idempotency_key text NOT NULL UNIQUE|UNIQUE \(idempotency_key\)/);
    assert.match(SPRAY_SCHEMA_SQL, /CONSTRAINT spray_payments_provider_ref_key UNIQUE \(provider_ref\)/);
    assert.match(SPRAY_SCHEMA_SQL, /provider_ref text NOT NULL/);
  });
  test("status, tier, amounts, not-self and room_spend checks", () => {
    assert.match(SPRAY_SCHEMA_SQL, /status IN \('created', 'pending', 'paid', 'delivered', 'reversing', 'reversed', 'failed', 'disputed'\)/);
    assert.match(SPRAY_SCHEMA_SQL, /status text NOT NULL DEFAULT 'created'/);
    assert.match(SPRAY_SCHEMA_SQL, /tier IN \('note', 'bundle', 'bag', 'rain'\)/);
    assert.match(SPRAY_SCHEMA_SQL, /amount_kobo >= 50000 AND v3c = amount_kobo/);
    assert.match(SPRAY_SCHEMA_SQL, /vat_kobo \+ fee_kobo \+ reserve_kobo \+ platform_kobo \+ host_kobo \+ COALESCE\(guest_kobo, 0\) = amount_kobo/);
    assert.match(SPRAY_SCHEMA_SQL, /CHECK \(payer_id <> recipient_id\)/);
    assert.match(SPRAY_SCHEMA_SQL, /CHECK \(spent_kobo >= 0 AND spent_kobo <= limit_kobo\)/);
    assert.match(SPRAY_SCHEMA_SQL, /PRIMARY KEY \(room_id, user_id\)/);
    assert.match(SPRAY_SCHEMA_SQL, /status IN \('open', 'recovered', 'written_off'\)/);
    assert.match(SPRAY_SCHEMA_SQL, /CONSTRAINT host_clawbacks_spray_beneficiary_key UNIQUE \(spray_id, beneficiary_id\)/);
    assert.match(SPRAY_SCHEMA_SQL, /CONSTRAINT user_payment_methods_user_signature_key UNIQUE \(user_id, signature\)/);
    assert.match(SPRAY_SCHEMA_SQL, /ALTER TABLE users ADD COLUMN IF NOT EXISTS spray_daily_limit_kobo integer;/);
  });
  test("fix round: clawbacks name the admin who wrote them off, allow partial recovery, record their origin", () => {
    assert.match(SPRAY_SCHEMA_SQL, /written_off_by varchar REFERENCES admin_users\(id\) ON DELETE RESTRICT/);
    assert.doesNotMatch(SPRAY_SCHEMA_SQL, /written_off_by varchar REFERENCES users/);
    assert.match(SPRAY_SCHEMA_SQL, /recovered_kobo integer NOT NULL DEFAULT 0/);
    assert.match(SPRAY_SCHEMA_SQL, /status <> 'recovered' OR recovered_kobo = amount_kobo/);
    assert.match(SPRAY_SCHEMA_SQL, /status <> 'written_off' OR \(written_off_by IS NOT NULL AND written_off_reason IS NOT NULL\)/);
    assert.match(SPRAY_SCHEMA_SQL, /origin IN \('dispute', 'reversal'\)/);
    assert.match(SPRAY_SCHEMA_SQL, /check_attempts integer NOT NULL DEFAULT 0/);
    assert.match(SPRAY_SCHEMA_SQL, /next_check_at timestamp/);
    assert.match(SPRAY_SCHEMA_SQL, /authorization_url text,/); // client M7: a replay can hand the bank link back
    assert.match(SPRAY_SCHEMA_SQL, /spray_daily_limit_kobo <= 10000000/);
    const s = src("shared/schema.ts");
    assert.match(s, /writtenOffBy: varchar\("written_off_by"\)\.references\(\(\) => adminUsers\.id, \{ onDelete: "restrict" \}\)/);
    assert.match(s, /recoveredKobo: integer\("recovered_kobo"\)\.notNull\(\)\.default\(0\)/);
    assert.match(s, /checkAttempts: integer\("check_attempts"\)\.notNull\(\)\.default\(0\)/);
  });
  test("every spray tier and status in the SQL matches shared/spray.ts and shared/money.ts", () => {
    for (const t of SPRAY_TIERS) assert.ok(SPRAY_SCHEMA_SQL.includes(`'${t}'`), t);
    for (const s of SPRAY_STATUSES) assert.ok(SPRAY_SCHEMA_SQL.includes(`'${s}'`), s);
  });
  test("ensureSchema runs the same constant, after the paid-rooms batch", () => {
    const s = src("server/storage.ts");
    assert.match(s, /SPRAY_SCHEMA_SQL[\s\S]{0,80}pool\.query\(SPRAY_SCHEMA_SQL\)/);
    assert.ok(s.indexOf("pool.query(ROOM_TICKETS_SCHEMA_SQL)") < s.indexOf("pool.query(SPRAY_SCHEMA_SQL)"));
  });
  test("runner script reads add_spray.sql and rolls back on failure", () => {
    const r = src("scripts/run-spray-migration.mjs");
    assert.match(r, /"add_spray\.sql"/);
    assert.match(r, /ROLLBACK/);
  });
  test("shared/schema.ts declares the same constraint and index names", () => {
    const s = src("shared/schema.ts");
    for (const n of ["users_spray_daily_limit_kobo_check", "user_payment_methods_user_signature_key", "spray_payments_provider_ref_key",
      "spray_payments_payer_key_key", "spray_payments_room_status_idx", "spray_payments_payer_created_idx", "spray_payments_status_created_idx",
      "spray_payments_status_check", "spray_payments_tier_check", "spray_payments_amounts_check", "spray_payments_not_self_check",
      "room_spend_pkey", "room_spend_spent_check", "host_clawbacks_spray_beneficiary_key", "host_clawbacks_host_status_idx",
      "host_clawbacks_status_check", "host_clawbacks_amount_check",
      // fix round
      "spray_payments_status_next_check_idx", "spray_payments_recipient_created_idx", "spray_payments_host_created_idx",
      "room_spend_limit_check", "host_clawbacks_beneficiary_status_idx", "host_clawbacks_origin_check",
      "host_clawbacks_recovered_check", "host_clawbacks_written_off_check"]) {
      assert.ok(s.includes(`"${n}"`), n);
      assert.ok(SPRAY_SCHEMA_SQL.includes(n), `${n} in SQL`);
    }
  });
  test("shared/schema.ts: spray_payments and host_clawbacks references are restrict", () => {
    const s = src("shared/schema.ts");
    for (const t of ["sprayPayments = pgTable(\"spray_payments\"", "hostClawbacks = pgTable(\"host_clawbacks\""]) {
      const start = s.indexOf(`export const ${t}`);
      assert.ok(start > 0, t);
      const block = s.slice(start, s.indexOf("}));", start));
      assert.doesNotMatch(block, /cascade|set null/i, t);
      const refs = block.match(/\.references\([^)]*\)[^)]*\)/g) ?? [];
      assert.ok(refs.length > 0 && refs.every((r) => /onDelete: "restrict"/.test(r)), `${t}: ${refs}`);
    }
  });
}

// ---------------------------------------------------------------- schema exports and ledger types
{
  const schema = await import("../shared/schema");
  test("schema exports the four tables and users.sprayDailyLimitKobo", () => {
    assert.ok(schema.sprayPayments && schema.userPaymentMethods && schema.roomSpend && schema.hostClawbacks);
    assert.ok("sprayDailyLimitKobo" in schema.users);
  });
  test("the ledger knows spray, spray_refund, chargeback", () => {
    for (const t of ["spray", "spray_refund", "chargeback"]) assert.ok((schema.paymentTransactionTypes as readonly string[]).includes(t), t);
  });
  test("a host never sees the payer of spray ledger rows (ROOM_LEDGER_TYPES)", () => {
    const line = src("server/storage.ts").split("\n").find((l) => l.includes("const ROOM_LEDGER_TYPES")) ?? "";
    for (const t of ["spray", "spray_refund", "chargeback"]) assert.ok(line.includes(`"${t}"`), t);
  });
  test("deleteUser protection counts spray money records too", () => {
    const s = src("server/storage.ts");
    const start = s.indexOf("export async function assertNoRoomMoneyRecords");
    const body = s.slice(start, s.indexOf("\n}\n", start));
    assert.match(body, /spray_payments/);
    assert.match(body, /host_clawbacks/);
    assert.match(body, /counts\.sprays\)/);
  });
}

// ---------------------------------------------------------------- redaction and public user
{
  const { redactSensitiveFields } = await import("../server/security");
  const { SENSITIVE_RESPONSE_KEYS, toPublicUser } = await import("../server/auth");
  const redact = (body: unknown): any => {
    let sent: unknown;
    const res: any = { json: (b: unknown) => { sent = b; return res; } };
    redactSensitiveFields({} as any, res, () => {});
    res.json(body);
    return sent;
  };
  test("redaction keys include the saved-card secrets and the daily limit column", () => {
    for (const k of ["authEnc", "auth_enc", "signature", "authorizationCode", "authorization_code", "sprayDailyLimitKobo", "spray_daily_limit_kobo"]) {
      assert.ok(SENSITIVE_RESPONSE_KEYS.has(k), k);
    }
  });
  test("a stray saved-card row or provider body loses every secret at any depth", () => {
    const out = redact({
      method: { id: "m1", last4: "4081", brand: "visa", authEnc: "v1:abc", auth_enc: "v1:abc", signature: "SIG_x" },
      provider: { data: { authorization: { authorization_code: "AUTH_x", authorizationCode: "AUTH_x", last4: "4081" } } },
      list: [{ sprayDailyLimitKobo: 5, spray_daily_limit_kobo: 5, keep: 1 }],
    });
    assert.deepEqual(out, {
      method: { id: "m1", last4: "4081", brand: "visa" },
      provider: { data: {} }, // the whole `authorization` card object goes (fix round: the key itself is redacted)
      list: [{ keep: 1 }],
    });
  });
  test("fix round: 'authorization' is a redacted key; a verify result's card never survives a forgetful body", () => {
    assert.ok(SENSITIVE_RESPONSE_KEYS.has("authorization"));
    const out = redact({ verify: { paid: true, authorization: { authorizationCode: "AUTH_x", last4: "4081", signature: "SIG_x" } }, authorizationUrl: "https://x.test/a" });
    assert.deepEqual(out, { verify: { paid: true }, authorizationUrl: "https://x.test/a" });
  });
  test("the spray response shapes the routes use are untouched", () => {
    const me = { method: { last4: "4081", brand: "visa" }, dailyLimitKobo: 2000000, dailySpentKobo: 0, verified: true };
    assert.deepEqual(redact(JSON.parse(JSON.stringify(me))), me);
    const post = { status: "action_required", sprayId: "s1", authorizationUrl: "https://checkout.example/x" };
    assert.deepEqual(redact({ ...post }), post);
  });
  test("credential keys still stripped (list not weakened)", () => {
    for (const k of ["passwordHash", "passwordResetToken", "emailVerificationToken", "verifiedPhone", "inviteTokenHash", "ageVerifiedAt"]) assert.ok(SENSITIVE_RESPONSE_KEYS.has(k), k);
  });
  test("toPublicUser hides sprayDailyLimitKobo", () => {
    const u = { id: "u1", username: "x", sprayDailyLimitKobo: 3000000, passwordHash: "h" } as any;
    const p = toPublicUser(u) as Record<string, unknown>;
    assert.ok(!("sprayDailyLimitKobo" in p));
    assert.ok(!("passwordHash" in p));
    assert.equal(p.username, "x");
  });
}

// ---------------------------------------------------------------- sprayStorage source rules (no database here)
{
  const s = src("server/rooms/sprayStorage.ts");
  const fnBody = (name: string) => { const i = s.indexOf(`export async function ${name}(`); assert.ok(i >= 0, name); return s.slice(i, s.indexOf("\n}\n", i)); };
  test("sprayStorage exports every contract helper", () => {
    for (const n of ["insertSprayIfNew", "getSprayById", "getSprayByRef", "addSpend", "releaseSpend", "getRoomSpend", "sumPayerKoboSince",
      "countPayerSprays", "countPayerRecipientSprays", "listStaleSprays", "markSprayStatus", "insertClawbackIfNew", "openClawbacksFor",
      "markClawbacksRecovered", "getSavedMethod", "saveMethod", "deleteMethod", "setDailyLimit",
      "noteSprayChecked", "payerRecipientInFlight", "sumReceivedSince", "hasOpenClawback"]) {
      assert.match(s, new RegExp(`export async function ${n}\\(`), n);
    }
  });
  test("insertSprayIfNew is insert ON CONFLICT DO NOTHING then re-read, never read-then-insert", () => {
    const b = fnBody("insertSprayIfNew");
    assert.ok(b.indexOf("onConflictDoNothing") > 0 && b.indexOf("onConflictDoNothing") < b.indexOf(".select()"));
  });
  test("addSpend's gate is a conditional UPDATE (spent + kobo <= limit) and fails closed on bad input", () => {
    const b = fnBody("addSpend");
    assert.match(b, /\.update\(roomSpend\)/);
    assert.match(b, /spentKobo\} \+ \$\{kobo\} <= \$\{roomSpend\.limitKobo\}/);
    assert.match(b, /if \(!isPosInt\(kobo\) \|\| !isPosInt\(limitKobo\)\) return false/);
  });
  test("markSprayStatus is conditional on the current status", () => {
    assert.match(fnBody("markSprayStatus"), /inArray\(sprayPayments\.status, \[\.\.\.from\]\)/);
  });
  test("saveMethod stores only reusable cards; deleteMethod wipes auth_enc", () => {
    assert.match(fnBody("saveMethod"), /m\.reusable !== true/);
    assert.match(fnBody("deleteMethod"), /authEnc: "", deletedAt: new Date\(\)/);
  });
  test("sprayStorage never logs", () => {
    assert.doesNotMatch(s, /console\./);
  });
  test("fix round: getSprayById uses a strict 8-4-4-4-12 uuid; the sweep list is fair (least recently checked first)", () => {
    assert.match(s, /UUID_RE = \/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i/);
    assert.match(fnBody("getSprayById"), /UUID_RE\.test\(id\)/);
    assert.match(fnBody("listStaleSprays"), /lastCheckedAt\} asc nulls first/);
    assert.match(fnBody("listStaleSprays"), /nextCheckAt\} is null or/);
    assert.match(fnBody("markClawbacksRecovered"), /recoveredKobo: sql`\$\{hostClawbacks\.amountKobo\}`/);
  });
}

// ---------------------------------------------------------------- fix round: server source rules (no database here)
{
  const spray = src("server/rooms/spray.ts");
  const limits = src("server/rooms/sprayLimits.ts");
  const jobs = src("server/rooms/sprayJobs.ts");
  const claw = src("server/rooms/clawbacks.ts");
  test("C1: every reversal goes through toReversing, which writes reversal clawbacks in the same transaction", () => {
    const i = spray.indexOf("async function toReversing(");
    const body = spray.slice(i, spray.indexOf("\n}\n", i));
    assert.match(body, /db\.transaction/);
    assert.match(body, /markSprayStatus\(row\.id, from, "reversing"/);
    assert.match(body, /origin: "reversal"/g);
    // No other path moves a spray to reversing.
    assert.equal((spray.match(/"reversing", \{/g) ?? []).length, 1);
    assert.match(spray, /BLOCKING G3 QUESTION/);
  });
  test("C1/C2: the receive cap counts reversing and reversed, for host and recipient, under spray-recv locks", () => {
    assert.match(limits, /CAP_STATUSES_AT_START[^\n]*"reversing", "reversed"/);
    assert.match(limits, /CAP_STATUSES_AT_DELIVERY[^\n]*"reversing", "reversed"/);
    assert.match(limits, /recipient_id = \$1 or host_id = \$1/);
    assert.match(spray, /capLockKey\(u\.id\)/);
  });
  test("ruling 5: payer-owned limits are checked before the gate", () => {
    assert.ok(spray.indexOf("payerPrecheck(payerRow") > 0 && spray.indexOf("payerPrecheck(payerRow") < spray.indexOf("sprayGate(roomId, payerId, targetId, \"start\")"));
  });
  test("ruling 11: the reservation passes tx to every helper (one connection)", () => {
    const i = spray.indexOf("db.transaction(async (tx): Promise<Reservation>");
    const body = spray.slice(i, spray.indexOf("}));", i));
    assert.match(body, /hasSprayInFlight\(payerId, targetId, now, tx\)/);
    assert.match(body, /roomLimitFor\(roomId, payerId, tx\)/);
    assert.match(body, /overNewHostCapAtStart\(people, price, now, tx\)/);
    assert.doesNotMatch(body, /\bpool\./);
  });
  test("ruling 7: the spray receipt is not recorded in the chat ring", () => {
    const i = spray.indexOf("function announceDelivery(");
    assert.doesNotMatch(spray.slice(i, spray.indexOf("\n}\n", i)), /recordChat/);
  });
  test("ruling 10: the sweep is bounded per pass and re-checks failed rows", () => {
    assert.match(jobs, /queue\.slice\(0, t\.maxRowsPerPass\)/);
    assert.match(jobs, /listStaleSprays\(\["failed"\]/);
    assert.match(jobs, /noteSprayChecked/);
  });
  test("ruling 14: a write-off records the admin", () => {
    assert.match(claw, /written_off_by = \$3/);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
