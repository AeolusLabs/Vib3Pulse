// Rooms feature-flag parsing (no database):   npx tsx scripts/test-rooms-unit-flags.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { parseFlag, loadRoomFeatures, DEFAULT_ROOM_FEATURES } from "../server/rooms/features";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

test('parseFlag: "1" and "true" are on', () => {
  assert.equal(parseFlag("1", false), true);
  assert.equal(parseFlag("true", false), true);
});
test("parseFlag: anything else non-empty is off, even when the default is on", () => {
  for (const v of ["yes", " 1 ", "false", "0", "TRUE", "True", "on", "2", " true"]) {
    assert.equal(parseFlag(v, false), false, v);
    assert.equal(parseFlag(v, true), false, v);
  }
});
test("parseFlag: undefined and empty fall back to the default", () => {
  assert.equal(parseFlag(undefined, true), true);
  assert.equal(parseFlag(undefined, false), false);
  assert.equal(parseFlag("", true), true);
  assert.equal(parseFlag("", false), false);
});
test("loadRoomFeatures: defaults are all off with an empty env", () => {
  const f = loadRoomFeatures({});
  assert.deepEqual(f, { linkScreens: false, paidRooms: false, spray: false, gaming: false });
  assert.equal((DEFAULT_ROOM_FEATURES as any).anonymousJoin, undefined);
  assert.equal(DEFAULT_ROOM_FEATURES.paidRooms, false);
  assert.equal(DEFAULT_ROOM_FEATURES.spray, false);
});
test("loadRoomFeatures: reads ROOMS_PAID, ROOMS_SPRAY (and ignores the removed ROOMS_ANONYMOUS_JOIN)", () => {
  const f = loadRoomFeatures({ ROOMS_ANONYMOUS_JOIN: "1", ROOMS_PAID: "true", ROOMS_SPRAY: "1" });
  assert.equal((f as any).anonymousJoin, undefined);
  assert.equal(f.paidRooms, true);
  assert.equal(f.spray, true);
  assert.equal(f.linkScreens, false);
});
test("loadRoomFeatures: garbage values are off", () => {
  const f = loadRoomFeatures({ ROOMS_PAID: " 1 ", ROOMS_SPRAY: "false" });
  assert.deepEqual(f, { linkScreens: false, paidRooms: false, spray: false, gaming: false });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
