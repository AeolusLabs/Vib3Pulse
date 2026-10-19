// Paid rooms (phase 4): pure rules, limits, input validation and the migration text (no database):
//   npx tsx scripts/test-rooms-unit-tickets.ts   (or npm run test:rooms)
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOM_LIMITS, validateRoomInput } from "../shared/rooms";
import { canSellTickets, isTicketedRoom, moneyEligibleRoom, roomCapacity, ticketEligible, type TicketSaleCode } from "../shared/roomRules";
import { ticketBreakdown } from "../shared/money";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const at = new Date("2026-01-01T00:00:00Z");

// ---------------------------------------------------------------- limits
test("ticket limits: 100,000 to 10,000,000 kobo, 20 to 150 people", () => {
  assert.equal(ROOM_LIMITS.ticketMinKobo, 100000);
  assert.equal(ROOM_LIMITS.ticketMaxKobo, 10000000);
  assert.equal(ROOM_LIMITS.ticketCapacityMin, 20);
  assert.equal(ROOM_LIMITS.ticketCapacityMax, 150);
  assert.equal(ROOM_LIMITS.capacityMax, 50, "free rooms stay at 50");
  assert.equal(ROOM_LIMITS.capacityMaxPaid, ROOM_LIMITS.ticketCapacityMax);
});
test("ticketBreakdown works at both ends of the price range (shares sum to net, host positive)", () => {
  for (const p of [ROOM_LIMITS.ticketMinKobo, ROOM_LIMITS.ticketMaxKobo]) {
    const b = ticketBreakdown(p);
    assert.equal(b.platform + b.host, b.net);
    assert.ok(b.host > 0 && b.vat >= 0 && b.fee >= 0 && b.reserve >= 0);
  }
});

// ---------------------------------------------------------------- canSellTickets (table)
const okHost = { age: 30, idVerified: true, hasPayoutAccount: true };
const on = { paidRooms: true }, off = { paidRooms: false };
const sellCases: Array<[string, Parameters<typeof canSellTickets>[0], Parameters<typeof canSellTickets>[1], { paidRooms: boolean } | undefined, TicketSaleCode | null]> = [
  ["all good, 18+", okHost, { ageLimit: "18+" }, on, null],
  ["all good, 21+", okHost, { ageLimit: "21+", minorsRoom: false }, on, null],
  ["switch off", okHost, { ageLimit: "18+" }, off, "FEATURE_OFF"],
  ["switch not passed defaults to off (fail closed)", okHost, { ageLimit: "18+" }, undefined, "FEATURE_OFF"],
  ["switch off wins over everything else", { age: 15, idVerified: false, hasPayoutAccount: false }, { ageLimit: "all" }, off, "FEATURE_OFF"],
  ["unknown age", { ...okHost, age: null }, { ageLimit: "18+" }, on, "HOST_NOT_ADULT"],
  ["host 17", { ...okHost, age: 17 }, { ageLimit: "18+" }, on, "HOST_NOT_ADULT"],
  ["host 17 and unverified: HOST_NOT_ADULT first", { age: 17, idVerified: false, hasPayoutAccount: false }, { ageLimit: "18+" }, on, "HOST_NOT_ADULT"],
  ["host exactly 18 passes the age rule", { ...okHost, age: 18 }, { ageLimit: "18+" }, on, null],
  ["not ID-verified", { ...okHost, idVerified: false }, { ageLimit: "18+" }, on, "HOST_NOT_VERIFIED"],
  ["not verified and no payout: HOST_NOT_VERIFIED first", { ...okHost, idVerified: false, hasPayoutAccount: false }, { ageLimit: "18+" }, on, "HOST_NOT_VERIFIED"],
  ["no payout account", { ...okHost, hasPayoutAccount: false }, { ageLimit: "18+" }, on, "NO_PAYOUT_ACCOUNT"],
  ["no payout and an all-ages room: NO_PAYOUT_ACCOUNT first", { ...okHost, hasPayoutAccount: false }, { ageLimit: "all" }, on, "NO_PAYOUT_ACCOUNT"],
  ["all-ages room", okHost, { ageLimit: "all" }, on, "ROOM_NOT_ADULT"],
  ["13+ room", okHost, { ageLimit: "13+" }, on, "ROOM_NOT_ADULT"],
  ["16+ room", okHost, { ageLimit: "16+" }, on, "ROOM_NOT_ADULT"],
  ["an 18+ minors' room is never money-eligible", okHost, { ageLimit: "18+", minorsRoom: true }, on, "ROOM_NOT_ADULT"],
];
for (const [name, host, room, features, code] of sellCases) {
  test(`canSellTickets: ${name} -> ${code ?? "ok"}`, () => {
    const r = features === undefined ? canSellTickets(host, room) : canSellTickets(host, room, features);
    assert.deepEqual(r, code === null ? { ok: true } : { ok: false, code });
  });
}

// ---------------------------------------------------------------- moneyEligibleRoom / ticketEligible
test("moneyEligibleRoom: only 18+ and 21+, never a minors' room", () => {
  for (const l of ["all", "13+", "16+"]) assert.equal(moneyEligibleRoom({ ageLimit: l }), false, l);
  assert.equal(moneyEligibleRoom({ ageLimit: "18+" }), true);
  assert.equal(moneyEligibleRoom({ ageLimit: "21+", minorsRoom: false }), true);
  assert.equal(moneyEligibleRoom({ ageLimit: "21+", minorsRoom: true }), false);
});
const adult = { ageVerifiedAt: at, dateOfBirth: yearsAgo(30) };
const eligCases: Array<[string, { ageVerifiedAt: Date | null; dateOfBirth: string | null }, { ageLimit: string; minorsRoom?: boolean }, boolean]> = [
  ["verified adult, 18+ room", adult, { ageLimit: "18+" }, true],
  ["verified adult, 21+ room", adult, { ageLimit: "21+" }, true],
  ["verified 19, 21+ room (below the room's own limit)", { ageVerifiedAt: at, dateOfBirth: yearsAgo(19) }, { ageLimit: "21+" }, false],
  ["verified 19, 18+ room", { ageVerifiedAt: at, dateOfBirth: yearsAgo(19) }, { ageLimit: "18+" }, true],
  ["unverified adult", { ageVerifiedAt: null, dateOfBirth: yearsAgo(30) }, { ageLimit: "18+" }, false],
  ["verified teen (16)", { ageVerifiedAt: at, dateOfBirth: yearsAgo(16) }, { ageLimit: "18+" }, false],
  ["verified, no birthdate", { ageVerifiedAt: at, dateOfBirth: null }, { ageLimit: "18+" }, false],
  ["verified adult, minors' room", adult, { ageLimit: "18+", minorsRoom: true }, false],
  ["verified adult, all-ages room", adult, { ageLimit: "all" }, false],
  ["verified adult, 16+ room", adult, { ageLimit: "16+" }, false],
];
for (const [name, viewer, room, want] of eligCases) test(`ticketEligible: ${name} -> ${want}`, () => assert.equal(ticketEligible(viewer, room), want));

test("isTicketedRoom / roomCapacity", () => {
  assert.equal(isTicketedRoom({ ticketPriceKobo: null }), false);
  assert.equal(isTicketedRoom({}), false);
  assert.equal(isTicketedRoom({ ticketPriceKobo: 500000 }), true);
  assert.equal(roomCapacity({ capacity: 50, ticketPriceKobo: null, ticketCapacity: null }), 50);
  assert.equal(roomCapacity({ capacity: 50, ticketPriceKobo: 500000, ticketCapacity: 120 }), 120);
  assert.equal(roomCapacity({ capacity: 30, ticketPriceKobo: 500000, ticketCapacity: 20 }), 20);
});

// ---------------------------------------------------------------- validateRoomInput vectors
const base = { title: "Paid night", kind: "party", visibility: "public", ageLimit: "18+" };
const v = (x: object) => validateRoomInput({ ...base, ...x });
const field = (x: object) => { const r = v(x); return r.ok ? null : r.field; };
test("valid ticketed input keeps price, capacity and refundBeforeStart", () => {
  const r = v({ ticketPriceKobo: 500000, ticketCapacity: 120, refundBeforeStart: false });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.value.ticketPriceKobo, 500000); assert.equal(r.value.ticketCapacity, 120); assert.equal(r.value.refundBeforeStart, false); assert.equal(r.value.capacity, 50); }
});
test("the range ends are accepted (100,000 / 10,000,000 kobo, 20 / 150 people), 21+ too", () => {
  assert.ok(v({ ticketPriceKobo: 100000, ticketCapacity: 20 }).ok);
  assert.ok(v({ ticketPriceKobo: 10000000, ticketCapacity: 150, ageLimit: "21+" }).ok);
});
test("free input: no ticket keys at all when not sent; null/null is a free room", () => {
  const r = v({});
  assert.ok(r.ok);
  if (r.ok) { assert.ok(!("ticketPriceKobo" in r.value) && !("ticketCapacity" in r.value) && !("refundBeforeStart" in r.value)); }
  const n = v({ ticketPriceKobo: null, ticketCapacity: null });
  assert.ok(n.ok);
  if (n.ok) { assert.equal(n.value.ticketPriceKobo, null); assert.equal(n.value.ticketCapacity, null); }
  assert.ok(validateRoomInput({ ...base, ageLimit: "all", ticketPriceKobo: null, ticketCapacity: null }).ok, "free all-ages room with explicit nulls");
});
const priceBad: unknown[] = [99999, 10000001, 0, -100000, 150000.5, "500000", true, [500000], {}, NaN, Infinity];
for (const p of priceBad) test(`ticketPriceKobo ${JSON.stringify(p)} refused`, () => assert.equal(field({ ticketPriceKobo: p, ticketCapacity: 50 }), "ticketPriceKobo"));
const capBad: unknown[] = [19, 151, 0, -20, 20.5, "50", false, 1];
for (const c of capBad) test(`ticketCapacity ${JSON.stringify(c)} refused`, () => assert.equal(field({ ticketPriceKobo: 500000, ticketCapacity: c }), "ticketCapacity"));
test("price without capacity -> field ticketCapacity; capacity without price -> field ticketPriceKobo", () => {
  assert.equal(field({ ticketPriceKobo: 500000 }), "ticketCapacity");
  assert.equal(field({ ticketPriceKobo: 500000, ticketCapacity: null }), "ticketCapacity");
  assert.equal(field({ ticketCapacity: 50 }), "ticketPriceKobo");
  assert.equal(field({ ticketPriceKobo: null, ticketCapacity: 50 }), "ticketPriceKobo");
});
for (const l of ["all", "13+", "16+"]) {
  test(`a ticketed room cannot be ${l} (field ageLimit)`, () => assert.equal(field({ ageLimit: l, ticketPriceKobo: 500000, ticketCapacity: 50 }), "ageLimit"));
}
test("ageLimit left out defaults to all, so a ticketed room without an age limit is refused", () => {
  assert.equal(validateRoomInput({ title: "x", kind: "party", visibility: "public", ticketPriceKobo: 500000, ticketCapacity: 50 }).ok, false);
});
for (const r of ["yes", 1, null, "true"]) test(`refundBeforeStart ${JSON.stringify(r)} refused`, () => assert.equal(field({ refundBeforeStart: r }), "refundBeforeStart"));
test("free room capacity is unchanged by ticketing (still 2..50, 51 refused)", () => {
  assert.equal(field({ capacity: 51 }), "capacity");
  assert.equal(field({ capacity: 120, ticketPriceKobo: 500000, ticketCapacity: 120 }), "capacity", "ticket capacity goes in ticketCapacity, never capacity");
});

// ---------------------------------------------------------------- migration text
{
  const { ROOM_TICKETS_SCHEMA_SQL } = await import("../server/rooms/roomTicketsMigration");
  const norm = (x: string) => x.split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
  const file = readFileSync(new URL("../migrations/add_room_tickets.sql", import.meta.url), "utf8");
  test("migration file is BEGIN; <the exact ensureSchema statements>; COMMIT;", () => {
    assert.equal(norm(file), `BEGIN; ${norm(ROOM_TICKETS_SCHEMA_SQL)} COMMIT;`);
  });
  test("migration is additive: no DROP, no DELETE, no UPDATE of existing rows", () => {
    assert.doesNotMatch(ROOM_TICKETS_SCHEMA_SQL, /\bDROP\b|\bDELETE\b|\bUPDATE\b|\bTRUNCATE\b/i);
  });
  test("migration: partial unique paid ticket, unique provider_ref, status checks, 20..150 capacity", () => {
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS room_tickets_paid_uniq ON room_tickets \(room_id, user_id\) WHERE status = 'paid'/);
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /CONSTRAINT room_tickets_provider_ref_key UNIQUE \(provider_ref\)/);
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /status IN \('paid', 'refunded'\)/);
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /status IN \('held', 'queued', 'paid', 'failed'\)/);
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /ticket_capacity >= 20 AND ticket_capacity <= 150/);
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /CONSTRAINT room_payouts_room_id_key UNIQUE \(room_id\)/);
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /room_id varchar NOT NULL REFERENCES rooms\(id\) ON DELETE CASCADE/);
    assert.match(ROOM_TICKETS_SCHEMA_SQL, /refund_before_start boolean NOT NULL DEFAULT true/);
  });
  test("every IF NOT EXISTS: re-running is a no-op", () => {
    const creates = ROOM_TICKETS_SCHEMA_SQL.match(/CREATE (UNIQUE )?(TABLE|INDEX)/g) ?? [];
    const guarded = ROOM_TICKETS_SCHEMA_SQL.match(/CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/g) ?? [];
    assert.equal(creates.length, guarded.length);
    const adds = ROOM_TICKETS_SCHEMA_SQL.match(/ADD COLUMN/g) ?? [];
    const addsGuarded = ROOM_TICKETS_SCHEMA_SQL.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    assert.equal(adds.length, addsGuarded.length);
    const constraints = ROOM_TICKETS_SCHEMA_SQL.match(/ADD CONSTRAINT (\w+)/g) ?? [];
    for (const c of constraints) assert.match(ROOM_TICKETS_SCHEMA_SQL, new RegExp(`conname = '${c.split(" ")[2]}'`));
  });
  test("ensureSchema runs the same constant", () => {
    const src = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
    assert.match(src, /ROOM_TICKETS_SCHEMA_SQL[\s\S]{0,80}pool\.query\(ROOM_TICKETS_SCHEMA_SQL\)/);
  });
  test("shared/schema.ts declares the same constraint and index names (drizzle-kit push keeps them)", () => {
    const src = readFileSync(new URL("../shared/schema.ts", import.meta.url), "utf8");
    for (const n of ["rooms_ticket_price_kobo_check", "rooms_ticket_capacity_check", "rooms_ticket_both_check", "room_tickets_provider_ref_key", "room_tickets_paid_uniq",
      "room_tickets_user_idx", "room_tickets_status_check", "room_tickets_amounts_check", "room_payouts_room_id_key", "room_payouts_transfer_ref_key",
      "room_payouts_status_check", "room_payouts_amount_check", "room_payouts_status_release_idx"]) {
      assert.ok(src.includes(`"${n}"`), n);
      assert.ok(ROOM_TICKETS_SCHEMA_SQL.includes(n), `${n} in SQL`);
    }
  });
}

// ---------------------------------------------------------------- what a room object carries
{
  const { publicRoom, viewerRoom, hostRoom } = await import("../server/rooms/roomAccess");
  const row: any = {
    id: "r1", hostId: "h1", title: "t", inviteTokenHash: "x", pinnedMessage: "hi", reminderNotifiedAt: null,
    ticketPriceKobo: 500000, ticketCapacity: 120, refundBeforeStart: true, capacity: 50, ageLimit: "18+",
  };
  test("publicRoom and viewerRoom never carry the price, ticket capacity or refund setting", () => {
    for (const o of [publicRoom(row), viewerRoom(row)]) {
      assert.ok(!("ticketPriceKobo" in o) && !("ticketCapacity" in o) && !("refundBeforeStart" in o), JSON.stringify(o));
      assert.ok(!JSON.stringify(o).includes("500000"));
    }
  });
  test("hostRoom carries all three", () => {
    const o = hostRoom(row);
    assert.equal(o.ticketPriceKobo, 500000); assert.equal(o.ticketCapacity, 120); assert.equal(o.refundBeforeStart, true);
    assert.equal(o.pinnedMessage, "hi");
    assert.ok(!("inviteTokenHash" in o));
  });
  test("hostRoom of a free room: nulls and refundBeforeStart true", () => {
    const o = hostRoom({ ...row, ticketPriceKobo: null, ticketCapacity: null });
    assert.equal(o.ticketPriceKobo, null); assert.equal(o.ticketCapacity, null); assert.equal(o.refundBeforeStart, true);
  });
}

// ---------------------------------------------------------------- the join path order (source check, the server is the gate)
test("joinOnce: the fresh ticket check sits after the minors' gate and the lock, before the hub insert, with no await between", () => {
  const src = readFileSync(new URL("../server/rooms/roomSocket.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("async function joinOnce");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const mg = body.indexOf("const mg = minorsGate(");
  const lock = body.indexOf('return refuse(ws, "ROOM_LOCKED");\n  }\n');
  const ticket = body.indexOf("!freshTicket) return refuse(ws, \"TICKET_REQUIRED\")");
  const insert = body.indexOf("roomHub.join(roomId, me)");
  assert.ok(mg > 0 && lock > mg && ticket > lock && insert > ticket, `${mg} ${lock} ${ticket} ${insert}`);
  assert.doesNotMatch(body.slice(mg, insert), /\bawait\b/, "no await between the minors' gate and the hub insert");
  // the pre-check comes after the age gate and the lock pre-check, before leaving the current room
  const pre = body.indexOf("!(await hasPaidTicket(roomId, userId))");
  const age = body.indexOf("JOIN_AGE_CODES[gate.code]");
  const leave = body.indexOf("await leaveRoom(userId, current)");
  assert.ok(age > 0 && pre > age && leave > pre, `${age} ${pre} ${leave}`);
  assert.match(body, /hasPaidTicket\(roomId, userId\),?\s*\]\)/, "the ticket is re-read in the fresh Promise.all");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
