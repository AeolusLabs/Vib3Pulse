// Room mini-bar: pure helpers + Media Session + source wiring (no database, no browser): npx tsx scripts/test-rooms-unit-minibar.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bottomVars, leaveFromBar, matchLine, miniBarVisible, showMute, switchCopy } from "../client/src/lib/miniBar";
import { setMediaSession } from "../client/src/lib/mediaSession";
import { HOST_LEAVE_CONFIRM } from "../client/src/lib/roomSessionRules";
import { newGame } from "../shared/gameScreen";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test('matchLine returns null with no game and the "2v2 · Team A 3 - 1 Team B" shape with one', () => {
  assert.equal(matchLine(null), null);
  const g = { ...newGame(2), score: [3, 1] as [number, number], away: {} };
  assert.equal(matchLine(g), "2v2 · Team A 3 - 1 Team B");
});

test("bar hidden on the room route and shown elsewhere", () => {
  const a = { roomId: "r1" };
  assert.equal(miniBarVisible(null, false, "/feed"), false, "no room, no bar");
  assert.equal(miniBarVisible(a, false, "/feed"), true);
  assert.equal(miniBarVisible(a, false, "/rooms"), true);
  assert.equal(miniBarVisible(a, false, "/rooms/r2"), true, "another room's page keeps it");
  assert.equal(miniBarVisible(a, false, "/rooms/r1"), false, "its own route");
  assert.equal(miniBarVisible(a, false, "/rooms/r1/"), false);
  assert.equal(miniBarVisible(a, false, "/rooms/r1?token=x"), false);
  assert.equal(miniBarVisible(a, true, "/feed"), false, "expanded flag hides it");
  assert.equal(miniBarVisible(a, false, "/rooms/r1/recap"), true);
});

test("mute shown only when the user can publish", () => {
  assert.equal(showMute(true), true);
  assert.equal(showMute(false), false);
});

test("Leave on own live room asks the host warning", () => {
  assert.equal(leaveFromBar(true, true), "confirm");
  assert.equal(leaveFromBar(true, false), "leave");
  assert.equal(leaveFromBar(false, true), "leave");
  assert.match(src("../client/src/components/rooms/shell/RoomMiniBar.tsx"), /HOST_LEAVE_CONFIRM/);
  assert.match(HOST_LEAVE_CONFIRM, /hosting this live room/);
});

test("Media Session handlers set on mount and cleared on unmount", () => {
  const handlers: Record<string, (() => void) | null> = {};
  const nav = { mediaSession: { metadata: null as unknown, playbackState: "none", setActionHandler: (a: string, h: (() => void) | null) => { handlers[a] = h; } } };
  let toggles = 0, leaves = 0;
  const clear = setMediaSession({ title: "T", host: "H", muted: false, onToggleMute: () => toggles++, onLeave: () => leaves++ }, nav);
  handlers.play!(); handlers.pause!(); handlers.hangup!();
  assert.deepEqual([toggles, leaves], [2, 1]);
  assert.equal(nav.mediaSession.playbackState, "playing");
  clear();
  assert.deepEqual([handlers.play, handlers.pause, handlers.hangup], [null, null, null]);
  assert.equal(nav.mediaSession.metadata, null);
  assert.doesNotThrow(() => setMediaSession({ title: "T", host: "H", muted: true, onToggleMute() {}, onLeave() {} }, {} as never)(), "no mediaSession: inert");
});

test("switch dialog names the first room with a plain fallback", () => {
  assert.equal(switchCopy("Friday Chill", null).title, "Leave Friday Chill and join this one?");
  assert.equal(switchCopy(null, "Late Set").title, "Leave your current room and join this one?");
  assert.match(switchCopy(null, "Late Set").description ?? "", /Late Set/);
});

test("mini-bar and switch dialog are mounted once in App; the provider no longer owns a dialog", () => {
  const app = src("../client/src/App.tsx");
  assert.equal(app.match(/<RoomMiniBar \/>/g)?.length, 1);
  assert.equal(app.match(/<SwitchRoomDialog \/>/g)?.length, 1);
  assert.doesNotMatch(src("../client/src/lib/roomSession.tsx"), /AlertDialog/);
});

test("bar offset follows the bottom nav and never double-counts the safe area", () => {
  assert.deepEqual(bottomVars(true), { navH: "4rem", safe: "0px" });
  assert.deepEqual(bottomVars(false), { navH: "0px", safe: "env(safe-area-inset-bottom, 0px)" });
  const nav = src("../client/src/components/BottomNavigation.tsx");
  assert.match(nav, /bottomVars\(true\)/);
  assert.match(nav, /removeProperty\("--bottom-nav-h"\)/, "cleared on unmount");
  assert.ok(src("../client/src/index.css").includes(".room-minibar { bottom: calc(var(--bottom-nav-h) + var(--bottom-safe)); }"));
});

test("reserved space is phone-only; the skip is an explicit marker, never a class-name substring", () => {
  const css = src("../client/src/index.css");
  assert.match(css, /@media \(max-width: 767\.98px\) \{[^}]*\}\s*body \{ padding-bottom: var\(--minibar-h\)|@media \(max-width: 767\.98px\) \{\s*:root\[data-room-minibar="on"\] \{[^}]*\}\s*body \{ padding-bottom: var\(--minibar-h\)/);
  assert.ok(css.includes("body:has([data-fullheight]) { padding-bottom: 0; }"));
  assert.doesNotMatch(css, /^body \{ padding-bottom/m, "no global body padding");
  const skips = css.split(/\r?\n/).filter((l) => /:has\(/.test(l) && /padding-bottom/.test(l));
  assert.ok(skips.length >= 1);
  for (const l of skips) assert.doesNotMatch(l, /\[class\*=/, "no class substring skip");
});

test("fixed-height pages carry data-fullheight and inset by --minibar-h", () => {
  for (const f of ["../client/src/pages/MessagesPage.tsx", "../client/src/components/PostDetailView.tsx"]) {
    const t = src(f);
    assert.match(t, /data-fullheight/, f);
    assert.ok(t.includes("pb-[var(--minibar-h,0px)]"), f);
  }
  assert.doesNotMatch(src("../client/src/pages/MapPage.tsx"), /data-fullheight/, "panels and overlays never carry it");
  assert.doesNotMatch(src("../client/src/components/EventDetailsModal.tsx"), /data-fullheight/);
  assert.doesNotMatch(src("../client/src/components/rooms/create/CreateRoomWizard.tsx"), /data-fullheight/);
});

test("phone layout: three action buttons in the title row, host and match on their own row, info in the second row", () => {
  const bar = src("../client/src/components/rooms/shell/RoomMiniBar.tsx");
  const row1 = bar.slice(bar.indexOf("room-minibar-open"), bar.indexOf("room-minibar-sub"));
  assert.match(row1, /room-minibar-mute/); assert.match(row1, /room-minibar-expand/); assert.match(row1, /room-minibar-leave/);
  assert.doesNotMatch(row1, /room-minibar-info/);
  assert.ok(bar.indexOf("room-minibar-info") > bar.indexOf("room-minibar-sub"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
