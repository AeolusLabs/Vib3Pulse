// Minors' room rule (no database):   npx tsx scripts/test-rooms-unit-minorsroom.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { canAdultEnterMinorsRoom, isMinorsRoomHost, canJoinRoom } from "../shared/roomRules";
import { MINORS_ROOM_CODES, MINORS_ROOM_WARNING } from "../shared/rooms";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const minors = { minorsRoom: true }, normal = { minorsRoom: false };
const inv = (invited: boolean, acknowledged: boolean) => ({ invited, acknowledged });

// The full table: teen/adult x minors/normal room x invited/acknowledged.
const table: Array<[number, boolean, boolean, boolean, string]> = [
  // age, minorsRoom, invited, acknowledged, expected
  [15, true, false, false, "ok"], [15, true, true, false, "ok"], [15, true, true, true, "ok"], [15, true, false, true, "ok"],
  [17, true, false, false, "ok"],
  [13, true, false, false, "ok"],
  [15, false, false, false, "ok"], [15, false, true, true, "ok"],
  [18, true, false, false, "MINORS_ROOM"], [18, true, false, true, "MINORS_ROOM"], [18, true, true, false, "MINORS_ROOM_ACK"], [18, true, true, true, "ok"],
  [40, true, false, false, "MINORS_ROOM"], [40, true, true, false, "MINORS_ROOM_ACK"], [40, true, true, true, "ok"],
  [18, false, false, false, "ok"], [40, false, false, false, "ok"], [40, false, true, false, "ok"],
];
for (const [age, mr, i, a, want] of table) {
  test(`age ${age}, ${mr ? "minors'" : "normal"} room, invited=${i}, acknowledged=${a} -> ${want}`, () => {
    const r = canAdultEnterMinorsRoom({ age }, mr ? minors : normal, inv(i, a));
    assert.equal(r.ok ? "ok" : r.code, want);
  });
}

test("acknowledged without an invite is not an invite (a stale ack never lets anyone in)", () => {
  const r = canAdultEnterMinorsRoom({ age: 30 }, minors, inv(false, true));
  assert.deepEqual(r, { ok: false, code: "MINORS_ROOM" });
});
test("unknown age in a minors' room is refused like an adult (the server answers AGE_UNKNOWN before this runs)", () => {
  const r = canAdultEnterMinorsRoom({ age: null }, minors, inv(true, true));
  assert.equal(r.ok, false);
  assert.equal(canJoinRoom({ age: null }, { ageLimit: "all" }).ok, false);
});
test("unknown age in a normal room is not this rule's business", () => {
  assert.equal(canAdultEnterMinorsRoom({ age: null }, normal, inv(false, false)).ok, true);
});

test("isMinorsRoomHost: 17 and under are, 18 and over are not, unknown is not", () => {
  assert.equal(isMinorsRoomHost(13), true);
  assert.equal(isMinorsRoomHost(17), true);
  assert.equal(isMinorsRoomHost(18), false);
  assert.equal(isMinorsRoomHost(45), false);
  assert.equal(isMinorsRoomHost(null), false);
});

test("the warning is the exact agreed text", () => {
  assert.equal(MINORS_ROOM_WARNING, "This room is for under 18s. Adults can only come in if the host has invited them. Any inappropriate behaviour or indecent act will lead to your account being suspended, an investigation being opened, and possible legal action.");
});
test("the warning has no em or en dashes and never says cash", () => {
  assert.equal(/[\u2014\u2013]/.test(MINORS_ROOM_WARNING), false);
  assert.equal(/cash/i.test(MINORS_ROOM_WARNING), false);
});
test("denial codes are exactly MINORS_ROOM and MINORS_ROOM_ACK", () => {
  assert.deepEqual([...MINORS_ROOM_CODES], ["MINORS_ROOM", "MINORS_ROOM_ACK"]);
});

// Stage rule in a minors' room: teens always speak, adults never; normal rooms keep the band rule.
{
  const { canBeOnStage } = await import("../shared/stage");
  const M = { minorsRoom: true };
  test("minors' room: a teen may speak with adults present", () => assert.deepEqual(canBeOnStage({ age: 16 }, { bands: ["teen", "adult", "adult"] }, M), { ok: true }));
  test("minors' room: a teen may speak alongside unknown-age people", () => assert.deepEqual(canBeOnStage({ age: 13 }, { bands: ["teen", null] }, M), { ok: true }));
  test("minors' room: an adult never speaks, even with only adults present", () => {
    assert.deepEqual(canBeOnStage({ age: 30 }, { bands: ["teen", "adult"] }, M), { ok: false, code: "MINORS_ROOM_ADULT" });
    assert.deepEqual(canBeOnStage({ age: 18 }, { bands: ["adult"] }, M), { ok: false, code: "MINORS_ROOM_ADULT" });
  });
  test("minors' room: unknown age never speaks", () => assert.deepEqual(canBeOnStage({ age: null }, { bands: ["teen"] }, M), { ok: false, code: "AGE_UNKNOWN" }));
  test("normal room unchanged: teen blocked by an adult, adult allowed, default is the normal rule", () => {
    assert.deepEqual(canBeOnStage({ age: 16 }, { bands: ["teen", "adult"] }, { minorsRoom: false }), { ok: false, code: "ADULT_PRESENT" });
    assert.deepEqual(canBeOnStage({ age: 16 }, { bands: ["teen", "adult"] }), { ok: false, code: "ADULT_PRESENT" });
    assert.deepEqual(canBeOnStage({ age: 30 }, { bands: ["teen", "adult"] }, { minorsRoom: false }), { ok: true });
  });
}

// The migration file and the constant ensureSchema runs must be the same statements (backfill included).
{
  const { readFileSync } = await import("node:fs");
  const { MINORS_ROOMS_SCHEMA_SQL, MINORS_ROOMS_BACKFILL } = await import("../server/rooms/minorsRoomsMigration");
  const norm = (x: string) => x.split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
  const file = readFileSync(new URL("../migrations/add_minors_rooms.sql", import.meta.url), "utf8");
  const body = norm(file);
  test("migration file is BEGIN; <the exact ensureSchema statements>; COMMIT;", () => {
    assert.equal(body, `BEGIN; ${norm(MINORS_ROOMS_SCHEMA_SQL)} COMMIT;`);
  });
  test("the backfill only ever sets the flag (never clears) and skips ended rooms", () => {
    assert.match(MINORS_ROOMS_BACKFILL, /SET minors_room = true/);
    assert.doesNotMatch(MINORS_ROOMS_BACKFILL, /minors_room = false\s*(,|WHERE|FROM)/i);
    assert.match(MINORS_ROOMS_BACKFILL, /status <> 'ended'/);
  });
  test("the audit columns: invited_by is ON DELETE SET NULL, first_acknowledged_at exists", () => {
    assert.match(MINORS_ROOMS_SCHEMA_SQL, /invited_by varchar REFERENCES users\(id\) ON DELETE SET NULL/);
    assert.match(MINORS_ROOMS_SCHEMA_SQL, /first_acknowledged_at timestamp/);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
