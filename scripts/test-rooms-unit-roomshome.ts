// Pure helpers for the Rooms home (no database, no browser): npx tsx scripts/test-rooms-unit-roomshome.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Paths are relative to the repo root, resolved from this file so the test runs from any folder.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
import {
  NO_FILTERS, TAB_COPY, TAB_ORDER, activeFilterCount, ageTagLabel, applyFilters, cardLabel, coverColour, fixtureHome, friendsInside, hashId, nextTab, peopleLabel, showPriceChip,
  type HomeRoom,
} from "../client/src/lib/roomsHome";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

const person = (id: string) => ({ userId: id, role: "guest" as const, username: id, displayName: id, avatarUrl: null, avatar: null });
const room = (id: string, over: Partial<HomeRoom> = {}): HomeRoom => ({
  id, hostId: "h", title: id, description: null, kind: "party", visibility: "public", ageLimit: "all", capacity: 50, status: "live",
  scheduledFor: null, startedAt: null, endedAt: null, screen: null, eventId: null, venueId: null, noDirectInteractions: false, host: null, ...over,
});
const ctx = { friendIds: new Set(["f1"]), selfId: "me", paidRoomsOn: false };

test("hashId is stable and spreads", () => {
  assert.equal(hashId("abc"), hashId("abc"));
  assert.notEqual(hashId("abc"), hashId("abd"));
  assert.equal(typeof hashId(""), "number");
});
test("coverColour is deterministic and violet-family only", () => {
  assert.deepEqual(coverColour("room-1"), coverColour("room-1"));
  for (const id of ["a", "b", "room-1", "x".repeat(40), ""]) {
    const c = coverColour(id);
    for (const s of [c.from, c.to]) {
      const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(s);
      assert.ok(m, s);
      assert.ok(+m![1] >= 240 && +m![1] <= 325, `hue ${m![1]}`);
      assert.ok(+m![3] >= 12 && +m![3] <= 45, `lightness ${m![3]}`);
    }
  }
  const distinct = new Set(Array.from({ length: 60 }, (_, i) => coverColour(`r${i}`).from));
  assert.ok(distinct.size > 3);
});
test("no filters returns everything", () => {
  const rs = [room("a"), room("b", { kind: "talk" })];
  assert.equal(applyFilters(rs, NO_FILTERS, ctx).length, 2);
});
test("kind filter is multi-select", () => {
  const rs = [room("a"), room("b", { kind: "talk" }), room("c", { kind: "event" })];
  assert.deepEqual(applyFilters(rs, { ...NO_FILTERS, kinds: ["party", "talk"] }, ctx).map((r) => r.id), ["a", "b"]);
});
test("friends inside uses peek, ignores the viewer and strangers", () => {
  const rs = [room("a", { peek: [person("f1")] }), room("b", { peek: [person("x")] }), room("c", { peek: [person("me")] }), room("d")];
  assert.deepEqual(applyFilters(rs, { ...NO_FILTERS, friendsInside: true }, { ...ctx, friendIds: new Set(["f1", "me"]) }).map((r) => r.id), ["a"]);
  assert.deepEqual(friendsInside(undefined, ctx.friendIds, "me"), []);
});
test("price filter does nothing while paidRooms is off, works when on", () => {
  const rs = [room("free"), room("paid", { priceMinor: 500000, ageLimit: "18+" })];
  assert.equal(applyFilters(rs, { ...NO_FILTERS, price: "paid" }, ctx).length, 2);
  assert.deepEqual(applyFilters(rs, { ...NO_FILTERS, price: "paid" }, { ...ctx, paidRoomsOn: true }).map((r) => r.id), ["paid"]);
  assert.deepEqual(applyFilters(rs, { ...NO_FILTERS, price: "free" }, { ...ctx, paidRoomsOn: true }).map((r) => r.id), ["free"]);
});
test("activeFilterCount ignores price while the flag is off", () => {
  assert.equal(activeFilterCount({ kinds: ["party"], friendsInside: true, price: "paid" }, false), 2);
  assert.equal(activeFilterCount({ kinds: ["party"], friendsInside: true, price: "paid" }, true), 3);
  assert.equal(activeFilterCount(NO_FILTERS, true), 0);
});
test("age tag label", () => {
  assert.equal(ageTagLabel("all"), "All ages");
  for (const l of ["13+", "16+", "18+", "21+"]) assert.equal(ageTagLabel(l), l);
});
test("price chip only with the flag on and an 18+/21+ non-minors room", () => {
  assert.equal(showPriceChip({ ageLimit: "18+" }, false), false);
  assert.equal(showPriceChip({ ageLimit: "21+" }, true), true);
  assert.equal(showPriceChip({ ageLimit: "all" }, true), false);
  assert.equal(showPriceChip({ ageLimit: "13+" }, true), false);
  assert.equal(showPriceChip({ ageLimit: "18+", minorsRoom: true }, true), false);
});
test("card label names the whole card", () => {
  const l = cardLabel(room("a", { title: "Sunset", memberCount: 1, ageLimit: "18+" }), "Ada", "Listening", ["Tolu"]);
  assert.equal(l, "Sunset, hosted by Ada, Listening, 18+, live, 1 person inside, Tolu inside");
  assert.equal(peopleLabel(2), "2 people");
  assert.match(cardLabel(room("b", { status: "scheduled" }), "Ada", "Party", []), /not started yet/);
});
test("tabs map to the three existing scopes, Friends is the mutual-followers scope", () => {
  assert.deepEqual([...TAB_ORDER], ["live", "upcoming", "friends"]);
  assert.equal(TAB_COPY.friends.label, "Friends");
  assert.ok(!/follow back|people you follow/i.test(TAB_COPY.friends.empty + TAB_COPY.friends.emptyFiltered), "the tab copy must not claim the one-way meaning");
  assert.equal(TAB_COPY.live.empty, "Quiet right now");
});
test("card label carries the start time for a room that has not started", () => {
  const l = cardLabel(room("b", { status: "scheduled", title: "Late set", ageLimit: "all" }), "Ada", "Party", [], "Fri 23 Oct, 19:00");
  assert.equal(l, "Late set, hosted by Ada, Party, All ages, not started yet, starts Fri 23 Oct, 19:00");
  assert.ok(!cardLabel(room("c"), "Ada", "Party", [], "ignored").includes("ignored"), "a live room never says a start time");
  assert.ok(read("client/src/components/rooms/home/RoomCard.tsx").includes("formatWhen(room.scheduledFor)"));
});
test("tab keys: arrows wrap, Home and End jump, other keys do nothing", () => {
  assert.equal(nextTab("live", "ArrowRight"), "upcoming");
  assert.equal(nextTab("friends", "ArrowRight"), "live");
  assert.equal(nextTab("live", "ArrowLeft"), "friends");
  assert.equal(nextTab("upcoming", "Home"), "live");
  assert.equal(nextTab("upcoming", "End"), "friends");
  assert.equal(nextTab("live", "Tab"), null);
});
test("tablist is wired for assistive tech, the follow query waits for a signed-in viewer, filter says what it counts", () => {
  const page = read("client/src/pages/RoomsPage.tsx");
  assert.ok(page.includes('aria-controls="rooms-panel"') && page.includes('id="rooms-panel"') && page.includes("aria-labelledby"));
  assert.ok(page.includes("enabled: !FIXTURE && !!me"));
  assert.ok(page.includes("overflow-x-auto"), "the tab row scrolls rather than clipping at 320 px");
  const sheet = read("client/src/components/rooms/home/FiltersSheet.tsx");
  assert.ok(sheet.includes("People you follow inside") && !sheet.includes(">Friends inside<"));
  assert.ok(/first (few|5)/i.test(read("client/src/lib/roomsHome.ts")) && /peek/i.test(read("client/src/lib/roomsHome.ts")));
});
test("fixture scenes", () => {
  assert.equal(fixtureHome(null), null);
  assert.equal(fixtureHome("nope"), null);
  assert.equal(fixtureHome("empty")!.live.length, 0);
  assert.ok(fixtureHome("live")!.live.length > 0);
});
test("copy has no em dashes and never the word cash", () => {
  const text = JSON.stringify(TAB_COPY) + read("client/src/lib/roomsHome.ts") + ["RoomCard", "FiltersSheet", "StartRoomButton"].map((f) => read(`client/src/components/rooms/home/${f}.tsx`)).join("") + read("client/src/pages/RoomsPage.tsx");
  assert.ok(!text.includes("—"));
  assert.ok(!/cash/i.test(text));
});
test("the page never reads a minors' flag or builds its own visibility rule (the server filters the lists)", () => {
  const page = read("client/src/pages/RoomsPage.tsx") + read("client/src/lib/roomsHome.ts").replace(/showPriceChip[\s\S]*?\n}\n/, "");
  assert.ok(!/visibility\s*[!=]==/.test(page));
});
test("filters sheet gates price on the flag and uses the room sheet", () => {
  const src = read("client/src/components/rooms/home/FiltersSheet.tsx");
  assert.match(src, /paidRoomsOn && \(/);
  assert.match(src, /RoomSheetContent/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
