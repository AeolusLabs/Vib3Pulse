// Rooms gaming flag parsing (no database):   npx tsx scripts/test-rooms-unit-game-flags.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { loadRoomFeatures, DEFAULT_ROOM_FEATURES } from "../server/rooms/features";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

test("gaming: off by default (empty env)", () => {
  assert.equal(loadRoomFeatures({}).gaming, false);
  assert.equal(DEFAULT_ROOM_FEATURES.gaming, false);
});
test('gaming: ROOMS_GAMING "1" and "true" turn it on', () => {
  assert.equal(loadRoomFeatures({ ROOMS_GAMING: "1" }).gaming, true);
  assert.equal(loadRoomFeatures({ ROOMS_GAMING: "true" }).gaming, true);
});
test('gaming: "yes" and "" are off', () => {
  assert.equal(loadRoomFeatures({ ROOMS_GAMING: "yes" }).gaming, false);
  assert.equal(loadRoomFeatures({ ROOMS_GAMING: "" }).gaming, false);
});
test("gaming: other flags never turn it on, and it never turns them on", () => {
  assert.equal(loadRoomFeatures({ ROOMS_PAID: "1", ROOMS_SPRAY: "1" }).gaming, false);
  const f = loadRoomFeatures({ ROOMS_GAMING: "1" });
  assert.equal(f.paidRooms, false);
  assert.equal(f.spray, false);
  assert.equal(f.linkScreens, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
