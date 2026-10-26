// Map unit checks (no database):   npx tsx scripts/test-map-unit.ts
import assert from "node:assert/strict";
import { baseOrder, DEFAULT_STYLES, styleUrl, tileFatal, tileHealth, tileVerdict, tileWatchdog } from "../client/src/lib/mapTiles";
import { filterFriends, firstName, meMarkerKind, sortFriendsForStrip, type StripFriend } from "../client/src/lib/mapFriends";
import { dragHeight, settleSnap, sheetHeights, stepSnap, tapSnap } from "../client/src/lib/sheetSnap";

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
test("tileFatal: a failure of the whole source (its style file) counts as a failed source at once, but never undoes tiles that did load", () => {
  assert.equal(tileVerdict(tileFatal({ errors: 0, loads: 0 })), "failed");
  assert.equal(tileVerdict(tileFatal({ errors: 2, loads: 0 })), "failed");
  assert.deepEqual(tileFatal({ errors: 9, loads: 4 }), { errors: 9, loads: 4 }, "already past the threshold: unchanged");
});
test("tileWatchdog: a source that sends nothing at all is called slow at 15 s and failed at 45 s; one that delivered anything never trips it", () => {
  assert.equal(tileWatchdog({ errors: 0, loads: 0 }, 14_999), null);
  assert.equal(tileWatchdog({ errors: 0, loads: 0 }, 15_000), "struggling");
  assert.equal(tileWatchdog({ errors: 0, loads: 0 }, 44_999), "struggling");
  assert.equal(tileWatchdog({ errors: 0, loads: 0 }, 45_000), "failed");
  assert.equal(tileWatchdog({ errors: 3, loads: 0 }, 60_000), "failed", "errors but no tile at all");
  assert.equal(tileWatchdog({ errors: 0, loads: 1 }, 120_000), null, "something loaded");
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

test("firstName: first word of the label, trimmed; never empty", () => {
  assert.equal(firstName("Ada Obi"), "Ada");
  assert.equal(firstName("  Ada   Obi "), "Ada", "leading and repeated spaces");
  assert.equal(firstName("Chidi"), "Chidi");
  assert.equal(firstName(""), "?");
  assert.equal(firstName("   "), "?");
  assert.equal(firstName("‏أحمد علي"), "‏أحمد", "right-to-left names keep their first word");
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

// ---------------------------------------------------------------- bottom sheet (collapse / expand)
test("sheetHeights: collapsed < half < expanded for every map height, expanded leaves the search bar visible", () => {
  for (const h of [320, 400, 568, 700, 900]) {
    const [peek, half, full] = sheetHeights(h, 110);
    assert.ok(peek < half && half < full, `${h}: ${peek} ${half} ${full}`);
    assert.ok(full <= Math.max(h - 130, peek + 120), `${h}: expanded ${full} must leave room for the search bar`);
    assert.ok(peek >= 100, "collapsed always shows the handle and the strip");
  }
  assert.ok(sheetHeights(700, 150)[0] > sheetHeights(700, 90)[0], "collapsed follows the height of the strip");
});
test("dragHeight: follows the finger (up grows the sheet), clamped to collapsed and expanded", () => {
  const h = [140, 330, 600];
  assert.equal(dragHeight(h, 330, 100), 230, "dragging down 100 px shrinks it");
  assert.equal(dragHeight(h, 330, -100), 430, "dragging up 100 px grows it");
  assert.equal(dragHeight(h, 330, 900), 140);
  assert.equal(dragHeight(h, 330, -900), 600);
});
test("settleSnap: a slow drag goes to the nearest position; a quick flick carries on in its direction", () => {
  const h = [140, 330, 600];
  assert.equal(settleSnap(h, 200, 0), 0, "nearer to collapsed");
  assert.equal(settleSnap(h, 300, 0), 1);
  assert.equal(settleSnap(h, 520, 0), 2);
  assert.equal(settleSnap(h, 330, 0), 1, "released where it is");
  assert.equal(settleSnap(h, 330, 1.2), 2, "flicked up from half: expanded");
  assert.equal(settleSnap(h, 330, -1.2), 0, "flicked down from half: collapsed");
  assert.equal(settleSnap(h, 160, 1.5), 1, "a flick up from nearly collapsed lands at half");
  assert.equal(settleSnap(h, 590, -0.9), 1, "a flick down from expanded: half");
  assert.equal(settleSnap(h, 330, 0.05), 1, "a tiny speed does not change the answer");
});
test("tapSnap: tapping the handle collapses an open sheet and opens a collapsed one", () => {
  assert.equal(tapSnap(0), 1);
  assert.equal(tapSnap(1), 0);
  assert.equal(tapSnap(2), 0);
});
test("stepSnap (keyboard): arrows move one position, never out of range", () => {
  assert.equal(stepSnap(0, 1, 2), 1);
  assert.equal(stepSnap(1, 1, 2), 2);
  assert.equal(stepSnap(2, 1, 2), 2);
  assert.equal(stepSnap(1, -1, 2), 0);
  assert.equal(stepSnap(0, -1, 2), 0);
});

// ---------------------------------------------------------------- safety buddies on the map (source guards, no database)
import { readFileSync } from "node:fs";
const mapRoutes = readFileSync("server/routes/map-routes.ts", "utf8");
test("buddies are opt-in: off by default in the schema and the migration", () => {
  assert.match(readFileSync("shared/schema.ts", "utf8"), /share_with_buddies"\)\.notNull\(\)\.default\(false\)/);
  assert.match(readFileSync("migrations/add_map_buddy_sharing.sql", "utf8"), /share_with_buddies boolean NOT NULL DEFAULT false/);
});
test("a buddy is only served when confirmed, an app user, unblocked, fresh and opted in", () => {
  assert.match(mapRoutes, /confirmationStatus, "confirmed"/);
  assert.match(mapRoutes, /isNotNull\(safetyBuddies\.buddyUserId\)/);
  assert.match(mapRoutes, /blockedWith\(meId\)/);
  assert.match(mapRoutes, /eq\(mapSharingPrefs\.shareWithBuddies, true\)/);
  assert.match(mapRoutes, /buddiesSharingWithMe[\s\S]*?fresh\(\)/);
});
test("map tray splits safety buddies from mutual followers, each row labelled and tappable", () => {
  const page = readFileSync("client/src/pages/MapPage.tsx", "utf8");
  assert.ok(page.includes("Safety buddies") && page.includes("Mutual followers"));
  assert.ok(page.includes('data-testid="map-buddies-row"') && page.includes('data-testid="map-mutuals-row"'));
  assert.match(page, /onPick=\{\(f\) => focus\(/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
