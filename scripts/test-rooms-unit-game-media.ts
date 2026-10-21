// Rooms unit checks for the gamers-live media rules (no database, no browser):   npx tsx scripts/test-rooms-unit-game-media.ts
import assert from "node:assert/strict";
import { gameProfileSettings, pickGameProfile, viewerLayer } from "../client/src/lib/bandwidth";
import { MAX_VIDEO_SUBS, playerIdOf, soundFeed, videoFeeds } from "../client/src/lib/gameScreen";
import type { GameView } from "../shared/gameScreen";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const eight: GameView = {
  format: 4, teams: { A: ["a1", "a2", "a3", "a4"], B: ["b1", "b2", "b3", "b4"] }, featured: { A: "a1", B: "b1" },
  asks: [], score: [0, 0], away: {},
};

test("viewerLayer: 559 is 360, 560 is 720, 250 is 360, 249 is 180", () => {
  assert.equal(viewerLayer(559), 360);
  assert.equal(viewerLayer(560), 720);
  assert.equal(viewerLayer(250), 360);
  assert.equal(viewerLayer(249), 180);
});
test("gameProfileSettings: the three profiles", () => {
  assert.deepEqual(
    (["light", "smooth", "sharp"] as const).map((p) => { const s = gameProfileSettings(p); return [s.width, s.height, s.frameRate]; }),
    [[960, 540, 30], [1280, 720, 60], [1920, 1080, 30]],
  );
  assert.equal(gameProfileSettings("smooth").frameRate, 60);
});
test("pickGameProfile: unknown or slow connections start on Light", () => {
  assert.equal(pickGameProfile(undefined), "light");
  assert.equal(pickGameProfile({ saveData: true }), "light");
  assert.equal(pickGameProfile({ effectiveType: "4g", downlink: 10 }), "smooth");
});

// Review Focus 4: a viewer on a weak or data-saver connection must not subscribe to eight feeds.
test("subscriptions: audio-only or data saver receives no video at all", () => {
  for (const layout of ["versus", "team", "grid", "spot"] as const) assert.deepEqual(videoFeeds(eight, layout, {}, true), []);
});
test("subscriptions: sound-only mode still has the one game sound", () => {
  assert.equal(soundFeed(eight, {}, null), "a1");
});
test("subscriptions: default is the featured feed per team, two feeds for eight players", () => {
  assert.deepEqual(videoFeeds(eight, "team", {}, false), ["a1", "b1"]);
  assert.deepEqual(videoFeeds(eight, "versus", {}, false), ["a1", "b1"]);
});
test("subscriptions: never more than four video feeds, never eight", () => {
  for (const layout of ["versus", "team", "grid", "spot"] as const) assert.ok(videoFeeds(eight, layout, {}, false).length <= MAX_VIDEO_SUBS);
  assert.equal(videoFeeds(eight, "grid", {}, false).length, 4);
});
test("subscriptions: following a player swaps that team's feed and never adds one", () => {
  assert.deepEqual(videoFeeds(eight, "team", { A: "a3" }, false), ["a3", "b1"]);
});
test("subscriptions: spotlight is a single feed", () => {
  assert.deepEqual(videoFeeds(eight, "spot", { B: "b2" }, false), ["b2"]);
  assert.deepEqual(videoFeeds(eight, "spot", {}, false), ["a1"]);
});
test("subscriptions: a player who is reconnecting has no video feed", () => {
  const g = { ...eight, away: { a1: 5_000 } };
  assert.deepEqual(videoFeeds(g, "team", {}, false), ["b1"]);
});
test("sound: one feed only; a pick that left falls back to a featured feed", () => {
  assert.equal(soundFeed(eight, {}, "b2"), "b2");
  assert.equal(soundFeed(eight, {}, "zz"), "a1");
  const g = { ...eight, away: { a1: null } };
  assert.equal(soundFeed(g, {}, null), "b1");
});

test("obs: a track from 'a1#obs' maps to player a1 and so is a wanted feed", () => {
  assert.ok(videoFeeds(eight, "team", {}, false).includes(playerIdOf("a1#obs")));
  assert.equal(soundFeed(eight, {}, playerIdOf("b2#obs")), "b2");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
