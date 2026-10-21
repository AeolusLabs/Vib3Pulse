// Rooms unit checks for the game stage's pure helpers (no database, no browser):   npx tsx scripts/test-rooms-unit-game-ui.ts
import assert from "node:assert/strict";
import {
  columnsFor, gameCaps, hostPick, isFollowing, layoutFor, spotlightFor, statusText, teamShares, teamSprayMinKobo, teamSprayTiers, thumbsOf, videoFeeds,
} from "../client/src/lib/gameScreen";
import type { GameView } from "../shared/gameScreen";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const g = (over: Partial<GameView> = {}): GameView => ({
  format: 3, teams: { A: ["a1", "a2", "a3"], B: ["b1", "b2"] }, featured: { A: "a2", B: "b1" }, asks: [], score: [0, 0], away: {}, ...over,
});

// ---------------------------------------------------------------- layout choice
test("layout: 1v1 defaults to versus, bigger formats to team lanes", () => {
  assert.equal(layoutFor(g({ format: 1, teams: { A: ["a"], B: ["b"] } }), null), "versus");
  assert.equal(layoutFor(g(), null), "team");
});
test("layout: a viewer's own choice always wins", () => {
  assert.equal(layoutFor(g(), "grid"), "grid");
  assert.equal(layoutFor(g({ format: 1 }), "spot"), "spot");
});
test("layout: columns follow the container width, not the viewport", () => {
  assert.equal(columnsFor("team", 375), 1);
  assert.equal(columnsFor("team", 559), 1);
  assert.equal(columnsFor("team", 560), 2);
  assert.equal(columnsFor("versus", 900), 2);
  assert.equal(columnsFor("grid", 320), 2);
  assert.equal(columnsFor("spot", 1200), 1);
});

// ---------------------------------------------------------------- which tiles are feeds and which are thumbnails
test("tiles: thumbnails are everyone but the featured feed", () => {
  assert.deepEqual(thumbsOf(g(), "A", {}), ["a1", "a3"]);
  assert.deepEqual(thumbsOf(g(), "A", { A: "a3" }), ["a1", "a2"]);
  assert.deepEqual(thumbsOf(g(), "B", {}), ["b2"]);
});
test("tiles: following a player shows the host-pick chip, the host pick itself does not", () => {
  assert.equal(hostPick(g(), "A"), "a2");
  assert.equal(isFollowing(g(), "A", {}), false);
  assert.equal(isFollowing(g(), "A", { A: "a3" }), true);
  assert.equal(isFollowing(g(), "A", { A: "a2" }), false);
});
test("tiles: spotlight is the viewer's latest follow, else team A's feed", () => {
  assert.equal(spotlightFor(g(), {}), "a2");
  assert.equal(spotlightFor(g(), { B: "b2" }), "b2");
  assert.equal(spotlightFor(g({ teams: { A: [], B: ["b1"] }, featured: { A: null, B: "b1" } }), {}), "b1");
});
test("tiles: four-way shows both featured feeds first, at most four", () => {
  const feeds = videoFeeds(g(), "grid", {}, false);
  assert.deepEqual(feeds.slice(0, 2), ["a2", "b1"]);
  assert.equal(feeds.length, 4);
});

// ---------------------------------------------------------------- status text on a tile
test("status: countdown, hold-slot and dropped-out wordings", () => {
  const away = g({ away: { a1: 30_000, a3: null } });
  assert.equal(statusText(away, "a1", 6_000), "Reconnecting… 0:24");
  assert.equal(statusText(away, "a3", 6_000), "Reconnecting…");
  assert.equal(statusText(away, "gone", 6_000), "Dropped out");
  assert.equal(statusText(away, "a2", 6_000), null);
});
test("status: at the deadline the clock sits at 0:00 until the server lets the slot go", () => {
  assert.equal(statusText(g({ away: { a1: 1_000 } }), "a1", 5_000), "Reconnecting… 0:00");
});

// ---------------------------------------------------------------- config capabilities
test("caps: no gaming key means everything is off, even if a game object is present", () => {
  assert.deepEqual(gameCaps({ features: {} , game: { ingest: true } }), { on: false, ingest: false, teamSpray: false, lanes: false });
  assert.equal(gameCaps(undefined).on, false);
});
test("caps: gaming on with no game object is all false except on", () => {
  assert.deepEqual(gameCaps({ features: { gaming: true } }), { on: true, ingest: false, teamSpray: false, lanes: false });
});
test("caps: each capability is read on its own and only when exactly true", () => {
  assert.deepEqual(gameCaps({ features: { gaming: true }, game: { ingest: true, teamSpray: false, lanes: true } }), { on: true, ingest: true, teamSpray: false, lanes: true });
  assert.equal(gameCaps({ features: { gaming: true }, game: { ingest: "yes" as any } }).ingest, false);
});

// ---------------------------------------------------------------- team spray tray
test("team spray: minimum is 500 NGN x players, in kobo", () => {
  assert.equal(teamSprayMinKobo(2), 100_000);
  assert.equal(teamSprayMinKobo(3), 150_000);
  assert.equal(teamSprayMinKobo(0), 0);
});
test("team spray: only tiers at or above the minimum are offered", () => {
  assert.deepEqual(teamSprayTiers(1), ["note", "bundle", "bag", "rain"]);
  assert.deepEqual(teamSprayTiers(2), ["bundle", "bag", "rain"]);
  assert.deepEqual(teamSprayTiers(3), ["bag", "rain"]); // the 1,000 tier is under 1,500
  assert.deepEqual(teamSprayTiers(0), []);
});
test("team spray: shares sum to the tier, each is at least the player minimum", () => {
  const shares = teamShares(g(), "A", "bag", "a2"); // 3 players, 10,000 NGN
  assert.equal(Object.values(shares).reduce((a, b) => a + b, 0), 1_000_000);
  assert.ok(Object.values(shares).every((k) => k >= 50_000));
  assert.ok(shares.a2 >= shares.a1); // the remainder goes to the featured player
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
