// Rooms gaming: team spray money rules (pure, no database):   npx tsx scripts/test-rooms-unit-game-teamspray.ts
// Owner decision 2026-10-22: team minimum = 500 NGN x players on the team; equal split; only tiers at or above the minimum.
// The charge / batch part of team spray is blocked on a schema change (see backend-B-report.md); these are its rules.
import assert from "node:assert/strict";
import { MIN_CHARGE_KOBO, SPRAY_CATALOGUE, SPRAY_TIERS, teamSprayMinimumKobo, teamSprayTiers } from "../shared/money";
import { splitShares } from "../shared/gameScreen";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

test("minimum: 500 naira per player (team of 2 is 1,000 naira)", () => {
  assert.equal(teamSprayMinimumKobo(1), 50_000);
  assert.equal(teamSprayMinimumKobo(2), 100_000);
  assert.equal(teamSprayMinimumKobo(4), 200_000);
});
test("minimum: not a whole number of players from 1 -> RangeError", () => {
  for (const n of [0, -1, 1.5, NaN]) assert.throws(() => teamSprayMinimumKobo(n), RangeError, String(n));
});
test("tiers: team of 3 (1,500 naira) is not offered the 1,000 naira tier", () => {
  assert.deepEqual(teamSprayTiers(3), ["bag", "rain"]);
});
test("tiers: team of 2 gets the 1,000 naira tier and up; team of 1 gets every tier", () => {
  assert.deepEqual(teamSprayTiers(2), ["bundle", "bag", "rain"]);
  assert.deepEqual(teamSprayTiers(1), [...SPRAY_TIERS]);
});
test("tiers: an empty team gets none", () => {
  assert.deepEqual(teamSprayTiers(0), []);
});
test("every offered tier splits into shares of at least the 500 naira minimum, summing to the tier to the kobo", () => {
  for (let n = 1; n <= 4; n++) for (const t of teamSprayTiers(n)) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const shares = splitShares(SPRAY_CATALOGUE[t].kobo, ids, ids[0]);
    assert.ok(Object.values(shares).every((k) => k >= MIN_CHARGE_KOBO), `${t}/${n}`);
    assert.equal(Object.values(shares).reduce((a, b) => a + b, 0), SPRAY_CATALOGUE[t].kobo, `${t}/${n}`);
  }
});
test("a player who dropped out is excluded: the split is over the players still in the match, remainder to the featured", () => {
  const shares = splitShares(SPRAY_CATALOGUE.bag.kobo, ["a", "c"], "c"); // b dropped out mid-throw
  assert.deepEqual(Object.keys(shares).sort(), ["a", "c"]);
  assert.equal(shares.a + shares.c, SPRAY_CATALOGUE.bag.kobo);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
