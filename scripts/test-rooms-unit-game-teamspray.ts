// Rooms gaming: team spray money rules (pure, no database):   npx tsx scripts/test-rooms-unit-game-teamspray.ts
// Owner decision 2026-10-22: team minimum = 500 NGN x players on the team; equal split; only tiers at or above the minimum.
// Money order (owner, 2026-10-22): the deductions come off the WHOLE charge first, the pool is split equally into the N subaccounts.
import assert from "node:assert/strict";
import { DEFAULT_RATES, MIN_CHARGE_KOBO, SPRAY_CATALOGUE, SPRAY_TIERS, allocateKobo, teamSprayBreakdown, teamSprayMinimumKobo, teamSprayTiers } from "../shared/money";
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

// ---------------------------------------------------------------- teamSprayBreakdown (corrected owner formula)
const plain = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `p${i}`, isHost: false }));
const sumOf = (b: ReturnType<typeof teamSprayBreakdown>) =>
  b.whole.platform + b.whole.host + b.whole.vat + b.whole.paystackFee + b.whole.reserve + b.shares.reduce((a, s) => a + s.recipient, 0);

test("worked check: team of 2, 1,000 naira bundle, host not a player", () => {
  const b = teamSprayBreakdown("bundle", plain(2), "p0");
  assert.equal(b.whole.gross, 100_000);
  assert.equal(b.whole.vat, 6_977);
  assert.equal(b.whole.paystackFee, 1_500);
  assert.equal(b.whole.reserve, 2_500);
  assert.equal(b.whole.platform, 22_256);
  assert.equal(b.whole.host, 13_353);
  assert.equal(b.whole.pool, 53_414);
  assert.deepEqual(b.shares.map((s) => s.recipient), [26_707, 26_707]);
  assert.equal(b.hostTotal, 13_353);
  assert.equal(sumOf(b), 100_000);
});
test("worked check: team of 4, same spray: pool 53,414 / 4 = 13,353 r 2, featured first then team order", () => {
  const b = teamSprayBreakdown("bundle", plain(4), "p0");
  assert.deepEqual(b.shares.map((s) => s.recipient), [13_354, 13_354, 13_353, 13_353]);
  assert.equal(sumOf(b), 100_000);
});
test("the remainder starts at the featured player, not at the first in the list", () => {
  const b = teamSprayBreakdown("bundle", plain(4), "p2");
  assert.deepEqual(b.shares.map((s) => s.recipient), [13_354, 13_353, 13_354, 13_353]); // p2 (featured) first, then p0 in team order
  const none = teamSprayBreakdown("bundle", plain(4), null);
  assert.deepEqual(none.shares.map((s) => s.recipient), [13_354, 13_354, 13_353, 13_353]);
});
test("each row's gross is the equal split of the charge, remainder kobo to the featured player (as splitShares)", () => {
  for (const n of [1, 2, 3, 4]) for (const t of teamSprayTiers(n)) {
    const ids = plain(n);
    const b = teamSprayBreakdown(t, ids, ids[n - 1].userId);
    const want = splitShares(SPRAY_CATALOGUE[t].kobo, ids.map((p) => p.userId), ids[n - 1].userId);
    for (const s of b.shares) assert.equal(s.gross, want[s.userId], `${t}/${n}/${s.userId}`);
  }
});
test("invariants over every tier, team size 1..4 and host on/off the team: parts sum, all whole non-negative, every cut > 0, rows add up", () => {
  for (let n = 1; n <= 4; n++) for (const t of teamSprayTiers(n)) for (const hostAt of [-1, 0, n - 1]) {
    const players = plain(n).map((p, i) => ({ ...p, isHost: i === hostAt }));
    const b = teamSprayBreakdown(t, players, players[0].userId);
    const X = SPRAY_CATALOGUE[t].kobo, tag = `${t}/${n}/host${hostAt}`;
    assert.equal(sumOf(b), X, tag);
    assert.equal(b.shares.reduce((a, s) => a + s.gross, 0), X, tag);
    for (const s of b.shares) {
      for (const v of [s.gross, s.vat, s.paystackFee, s.reserve, s.platform, s.host, s.recipient]) assert.ok(Number.isSafeInteger(v) && v >= 0, `${tag} ${v}`);
      assert.ok(s.recipient > 0, tag);
      assert.equal(s.vat + s.paystackFee + s.reserve + s.platform + s.host + s.recipient, s.gross, `${tag} row`);
      assert.ok(s.gross >= MIN_CHARGE_KOBO, tag);
    }
    assert.equal(b.shares.reduce((a, s) => a + s.vat, 0), b.whole.vat, tag);
    assert.equal(b.shares.reduce((a, s) => a + s.platform, 0), b.whole.platform, tag);
    assert.equal(b.shares.reduce((a, s) => a + s.host, 0), b.whole.host, tag);
    // equal split: no two cuts differ by more than one kobo
    const cuts = b.shares.map((s) => s.recipient);
    assert.ok(Math.max(...cuts) - Math.min(...cuts) <= 1, tag);
  }
});
test("the card fee's flat part is taken once on the whole charge (10,000 naira: 15,000 + 10,000 flat, not once per player)", () => {
  assert.equal(teamSprayBreakdown("bag", plain(3), null).whole.paystackFee, 25_000);
  assert.equal(teamSprayBreakdown("bag", plain(1), null).whole.paystackFee, 25_000);
});
test("the host % applies only to the non-host players' part: host plays in a team of 2 -> half", () => {
  const off = teamSprayBreakdown("bundle", plain(2), null);
  const on = teamSprayBreakdown("bundle", [{ userId: "h", isHost: true }, { userId: "g", isHost: false }], null);
  assert.equal(off.whole.host, 13_353);
  assert.equal(on.whole.host, Math.round((89_023 * DEFAULT_RATES.stage_guest_host * 1) / (100 * 2)));
  assert.equal(on.hostTotal, on.whole.host + on.shares[0].recipient); // one merged entry for the host's subaccount
  assert.equal(sumOf(on), 100_000);
});
test("the host alone on the team gets no host % (their cut is the whole pool)", () => {
  const b = teamSprayBreakdown("bundle", [{ userId: "h", isHost: true }], null);
  assert.equal(b.whole.host, 0);
  assert.equal(b.shares[0].recipient, b.whole.pool);
  assert.equal(sumOf(b), 100_000);
});
test("rates: a changed platform / host / reserve rate is honoured and the invariants still hold", () => {
  const rates = { ...DEFAULT_RATES, spray_platform_bundle: 50, stage_guest_host: 30, spray_reserve: 10 };
  const b = teamSprayBreakdown("bundle", plain(2), null, rates);
  assert.equal(sumOf(b), 100_000);
  assert.ok(b.shares.every((s) => s.recipient > 0));
});
test("bad input: unknown tier, no players, duplicates -> RangeError", () => {
  assert.throws(() => teamSprayBreakdown("gold" as any, plain(2), null), RangeError);
  assert.throws(() => teamSprayBreakdown("bundle", [], null), RangeError);
  assert.throws(() => teamSprayBreakdown("bundle", [{ userId: "a", isHost: false }, { userId: "a", isHost: false }], null), RangeError);
});
test("allocateKobo: sums exactly, ties in list order, never above a weight when the total fits", () => {
  assert.deepEqual(allocateKobo(6_977, [1, 1]), [3_489, 3_488]);
  assert.equal(allocateKobo(10, [3, 3, 3]).reduce((a, b) => a + b, 0), 10);
  assert.deepEqual(allocateKobo(0, [5, 5]), [0, 0]);
  assert.throws(() => allocateKobo(1, [0, 0]), RangeError);
});


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
