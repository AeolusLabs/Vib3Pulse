// Map unit checks (no database):   npx tsx scripts/test-map-unit.ts
import assert from "node:assert/strict";
import { baseOrder, DEFAULT_STYLES, styleUrl, tileHealth, tileVerdict } from "../client/src/lib/mapTiles";
import { filterFriends, meMarkerKind, sortFriendsForStrip, type StripFriend } from "../client/src/lib/mapFriends";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

// ---------------------------------------------------------------- tile health
const feed = (events: Array<"error" | "load">) => events.reduce((s, e) => tileHealth(s, e), { errors: 0, loads: 0 });
test("tileHealth counts errors and loads", () => {
  assert.deepEqual(feed(["error", "load", "error"]), { errors: 2, loads: 1 });
  assert.deepEqual(feed([]), { errors: 0, loads: 0 });
});
test("tileVerdict: ok while things load, struggling when errors dominate, failed when nothing ever loaded", () => {
  assert.equal(tileVerdict(feed([])), "ok");
  assert.equal(tileVerdict(feed(["error", "error", "error", "error", "error"])), "ok", "5 errors is still too early to judge");
  assert.equal(tileVerdict(feed(["error", "error", "error", "error", "error", "error"])), "failed", "6 errors and no load at all");
  assert.equal(tileVerdict(feed(["load", "load", "load", "load", "load", "load", "load", "error"])), "ok");
  assert.equal(tileVerdict(feed(["load", "error", "error", "error", "error", "error"])), "struggling", "errors at least 2:1 after 6 events, but something did load");
  assert.equal(tileVerdict(feed(["load", "load", "error", "error", "error", "error", "error", "error"])), "struggling");
  assert.equal(tileVerdict(feed(["load", "load", "load", "error", "error", "error"])), "ok", "1:1 is fine");
});
test("baseOrder: vector first when WebGL exists, raster only otherwise", () => {
  assert.deepEqual(baseOrder(true), ["vector", "raster"]);
  assert.deepEqual(baseOrder(false), ["raster"]);
});
test("styleUrl: OpenFreeMap by default, light and dark; env overrides win", () => {
  assert.equal(styleUrl(false, {}), DEFAULT_STYLES.light);
  assert.equal(styleUrl(true, {}), DEFAULT_STYLES.dark);
  assert.match(DEFAULT_STYLES.light, /^https:\/\/tiles\.openfreemap\.org\/styles\/positron$/);
  assert.match(DEFAULT_STYLES.dark, /^https:\/\/tiles\.openfreemap\.org\/styles\/dark$/);
  assert.equal(styleUrl(false, { light: "https://x/l.json", dark: "https://x/d.json" }), "https://x/l.json");
  assert.equal(styleUrl(true, { light: "https://x/l.json", dark: "https://x/d.json" }), "https://x/d.json");
  assert.equal(styleUrl(true, { light: "https://x/l.json" }), DEFAULT_STYLES.dark, "only the light one overridden");
});

// ---------------------------------------------------------------- friends strip and search
const F = (id: string, name: string | null, user: string, lat: number, lng: number, updatedAt = "2026-10-16T10:00:00Z"): StripFriend =>
  ({ id, username: user, displayName: name, avatarUrl: null, avatar: null, latitude: lat, longitude: lng, updatedAt });
test("sortFriendsForStrip: nearest first when my position is known; ties keep a stable order", () => {
  const list = [F("far", "Far", "far", 6.52, 3.38), F("near", "Near", "near", 51.51, -0.12), F("mid", "Mid", "mid", 48.85, 2.35)];
  assert.deepEqual(sortFriendsForStrip(list, [51.5072, -0.1276]).map((f) => f.id), ["near", "mid", "far"]);
  const tie = [F("b", "B", "b", 10, 10), F("a", "A", "a", 10, 10)];
  assert.deepEqual(sortFriendsForStrip(tie, [0, 0]).map((f) => f.id), ["b", "a"], "equal distance: input order");
});
test("sortFriendsForStrip: without my position, most recently updated first; input is not mutated", () => {
  const list = [F("old", "Old", "o", 1, 1, "2026-10-16T09:00:00Z"), F("new", "New", "n", 2, 2, "2026-10-16T11:00:00Z")];
  const copy = [...list];
  assert.deepEqual(sortFriendsForStrip(list, null).map((f) => f.id), ["new", "old"]);
  assert.deepEqual(list, copy);
  assert.deepEqual(sortFriendsForStrip([], null), []);
});
test("filterFriends: case-insensitive over display name and username, trims, empty returns everyone", () => {
  const list = [F("1", "Ada Obi", "ada_o", 1, 1), F("2", null, "Chidi", 2, 2), F("3", "Émile", "emile", 3, 3)];
  assert.deepEqual(filterFriends(list, "ADA").map((f) => f.id), ["1"]);
  assert.deepEqual(filterFriends(list, "  chi ").map((f) => f.id), ["2"], "username when there is no display name, whitespace trimmed");
  assert.deepEqual(filterFriends(list, "émi").map((f) => f.id), ["3"]);
  assert.deepEqual(filterFriends(list, "").map((f) => f.id), ["1", "2", "3"]);
  assert.deepEqual(filterFriends(list, "   ").map((f) => f.id), ["1", "2", "3"]);
  assert.deepEqual(filterFriends(list, "zzz"), []);
});

// ---------------------------------------------------------------- own marker
const goodAvatar = { v: 1, type: "male", skin: 2, hair: "mohawk", hairColor: 1, facial: "none", outfit: "bomber", outfitColor: 2, eyewear: "none", headwear: "none", expression: "grin", hoops: false };
test("meMarkerKind: avatar when valid, else photo, else dot; a non-object avatar falls through", () => {
  assert.equal(meMarkerKind({ avatar: goodAvatar, avatarUrl: "https://x/p.jpg" }), "avatar");
  assert.equal(meMarkerKind({ avatar: null, avatarUrl: "https://x/p.jpg" }), "photo");
  assert.equal(meMarkerKind({ avatar: "junk", avatarUrl: "https://x/p.jpg" }), "photo", "a non-object avatar is ignored");
  assert.equal(meMarkerKind({ avatar: [1], avatarUrl: null }), "dot");
  assert.equal(meMarkerKind({ avatar: null, avatarUrl: null }), "dot");
  assert.equal(meMarkerKind({}), "dot");
  assert.equal(meMarkerKind(undefined), "dot");
  assert.equal(meMarkerKind({ avatarUrl: "  " }), "dot", "blank photo url");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
