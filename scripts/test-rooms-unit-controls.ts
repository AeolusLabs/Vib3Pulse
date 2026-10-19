// Pure rules and copy for the host Controls sheet (task 3.4). No database, no browser: npx tsx scripts/test-rooms-unit-controls.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTROLS_COPY, CONTROLS_TABS, DEFAULT_SETTINGS, PINNED_MAX, SLOW_MODE_OPTIONS, TAB_LABEL, canModerate, controlsFor, endRoomCopy, isEmptyPatch,
  mergeOptimistic, moneyPlaceholderVisible, normalizePinned, pendingSettled, personActions, readSettings, requestQueue, roleChange,
  settingsErrorMessage, settingsPatch, slowModeLabel,
} from "../client/src/lib/hostControls";
import { initialRoomState, roomReducer } from "../client/src/lib/roomReducer";
import { fixtureControlsState, parseControlsFixture, parseFixtureQuery } from "../client/src/lib/roomFixtures";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

// ---------------------------------------------------------------- who sees what
test("host and co-host both get Requests, Stage, People, Settings in that order", () => {
  assert.deepEqual([...controlsFor("host").tabs], ["requests", "stage", "people", "settings"]);
  assert.deepEqual([...controlsFor("cohost").tabs], ["requests", "stage", "people", "settings"]);
  assert.deepEqual(CONTROLS_TABS.map((t) => TAB_LABEL[t]), ["Requests", "Stage", "People", "Settings"]);
});
test("host can do everything in the sheet", () => {
  const h = controlsFor("host");
  for (const k of ["switchVoice", "switchLive", "makeCohost", "editPinned", "editSlowMode", "lockRoom", "endRoom", "hostExtras"] as const) assert.equal(h[k], true, k);
});
test("co-host: pinned message only in Settings; no switches, no roles, no end, no host block", () => {
  const c = controlsFor("cohost");
  assert.equal(c.editPinned, true);
  for (const k of ["switchVoice", "switchLive", "makeCohost", "editSlowMode", "lockRoom", "endRoom", "hostExtras"] as const) assert.equal(c[k], false, k);
});
test("moderation mirrors the server: host on anyone but the host, co-host on guests only, never yourself", () => {
  const g = { userId: "g", role: "guest" as const }, c = { userId: "c", role: "cohost" as const }, h = { userId: "h", role: "host" as const };
  assert.equal(canModerate("host", g, "h"), true);
  assert.equal(canModerate("host", c, "h"), true);
  assert.equal(canModerate("host", h, "x"), false);
  assert.equal(canModerate("cohost", g, "c"), true);
  assert.equal(canModerate("cohost", { userId: "c2", role: "cohost" }, "c"), false);
  assert.equal(canModerate("cohost", h, "c"), false);
  assert.equal(canModerate("host", { userId: "me", role: "guest" }, "me"), false);
});
test("People row actions: mute or unmute, remove, ban, report; report only for someone you can't moderate; nothing for yourself", () => {
  assert.deepEqual(personActions("host", { userId: "g", role: "guest", muted: false }, "h"), ["mute", "kick", "ban", "report"]);
  assert.deepEqual(personActions("host", { userId: "g", role: "guest", muted: true }, "h"), ["unmute", "kick", "ban", "report"]);
  assert.deepEqual(personActions("cohost", { userId: "c2", role: "cohost", muted: false }, "c"), ["report"]);
  assert.deepEqual(personActions("cohost", { userId: "h", role: "host", muted: false }, "c"), ["report"]);
  assert.deepEqual(personActions("host", { userId: "h", role: "host", muted: false }, "h"), []);
});
test("Make co-host is host only, never on the host or yourself; a co-host can be made a guest again", () => {
  assert.equal(roleChange("host", { userId: "g", role: "guest" }, "h"), "make-cohost");
  assert.equal(roleChange("host", { userId: "c", role: "cohost" }, "h"), "remove-cohost");
  assert.equal(roleChange("host", { userId: "h", role: "host" }, "h"), null);
  assert.equal(roleChange("cohost", { userId: "g", role: "guest" }, "c"), null);
});

// ---------------------------------------------------------------- requests
test("request queue: hands first in order, then go-live asks only while live video is on, no repeats", () => {
  assert.deepEqual(requestQueue(["a", "b", "a"], ["c"], true), [{ userId: "a", kind: "hand" }, { userId: "b", kind: "hand" }, { userId: "c", kind: "live" }]);
  assert.deepEqual(requestQueue(["a"], ["c"], false), [{ userId: "a", kind: "hand" }]);
  assert.deepEqual(requestQueue([], [], true), []);
  // the same person can have a hand up and a go-live ask: two rows
  assert.equal(requestQueue(["a"], ["a"], true).length, 2);
});
test("request queue hides rows already acted on until the server's next list", () => {
  assert.deepEqual(requestQueue(["a", "b"], ["c"], true, new Set(["hand:a", "live:c"])), [{ userId: "b", kind: "hand" }]);
});

// ---------------------------------------------------------------- settings
test("slow mode options are exactly 0, 5, 15, 30 with plain labels", () => {
  assert.deepEqual([...SLOW_MODE_OPTIONS], [0, 5, 15, 30]);
  assert.deepEqual(SLOW_MODE_OPTIONS.map(slowModeLabel), ["Off", "5s", "15s", "30s"]);
});
test("readSettings: socket room first, then the room details, odd values fall back", () => {
  assert.deepEqual(readSettings(null, undefined), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({ id: "r", pinnedMessage: "hi", slowModeSec: 15, locked: true }, { pinnedMessage: "old", slowModeSec: 5, locked: false }), { pinnedMessage: "hi", slowModeSec: 15, locked: true });
  assert.deepEqual(readSettings({ id: "r" }, { pinnedMessage: "old", slowModeSec: 5, locked: true }), { pinnedMessage: "old", slowModeSec: 5, locked: true });
  assert.deepEqual(readSettings({ slowModeSec: 7, locked: "yes", pinnedMessage: 3 }), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({ pinnedMessage: null }, { pinnedMessage: "old" }), { ...DEFAULT_SETTINGS, pinnedMessage: null });
});
test("normalizePinned trims, collapses spaces, cuts at 200, empty is null", () => {
  assert.equal(normalizePinned("  hello   there \n"), "hello there");
  assert.equal(normalizePinned("   "), null);
  assert.equal(normalizePinned(null), null);
  assert.equal(normalizePinned("x".repeat(250))!.length, PINNED_MAX);
});
test("settingsPatch includes only changed fields", () => {
  const cur = { pinnedMessage: "a", slowModeSec: 5, locked: false };
  assert.deepEqual(settingsPatch(cur, { pinnedMessage: "a", slowModeSec: 5, locked: false }, "host"), {});
  assert.deepEqual(settingsPatch(cur, { slowModeSec: 15 }, "host"), { slowModeSec: 15 });
  assert.deepEqual(settingsPatch(cur, { locked: true, pinnedMessage: " a " }, "host"), { locked: true });
  assert.deepEqual(settingsPatch(cur, { pinnedMessage: "" }, "host"), { pinnedMessage: null });
  assert.deepEqual(settingsPatch(cur, { pinnedMessage: "b", slowModeSec: 30, locked: true }, "host"), { pinnedMessage: "b", slowModeSec: 30, locked: true });
  assert.equal(isEmptyPatch(settingsPatch(cur, {}, "host")), true);
});
test("settingsPatch drops an illegal slow mode and anything a co-host may not change", () => {
  const cur = { pinnedMessage: null, slowModeSec: 0, locked: false };
  assert.deepEqual(settingsPatch(cur, { slowModeSec: 7 }, "host"), {});
  assert.deepEqual(settingsPatch(cur, { slowModeSec: 15, locked: true, pinnedMessage: "rules" }, "cohost"), { pinnedMessage: "rules" });
});
test("optimistic view settles when the server agrees", () => {
  const server = { pinnedMessage: null, slowModeSec: 0, locked: false };
  assert.deepEqual(mergeOptimistic(server, { locked: true }), { ...server, locked: true });
  assert.deepEqual(mergeOptimistic(server, null), server);
  assert.equal(pendingSettled(server, { locked: true }), false);
  assert.equal(pendingSettled({ ...server, locked: true }, { locked: true }), true);
  assert.equal(pendingSettled(server, null), true);
});
test("failed save: a short plain server line is kept, anything else gets the fallback", () => {
  assert.equal(settingsErrorMessage("Only the host can change that."), "Only the host can change that.");
  assert.equal(settingsErrorMessage("<html>500</html>"), "Couldn't save that. Try again.");
  assert.equal(settingsErrorMessage("500: Internal"), "Couldn't save that. Try again.");
  assert.equal(settingsErrorMessage(""), "Couldn't save that. Try again.");
  assert.equal(settingsErrorMessage(undefined, "Couldn't end the room. Try again."), "Couldn't end the room. Try again.");
});

// ---------------------------------------------------------------- money placeholder
test("money placeholder: nothing while both flags are off, whatever the room", () => {
  for (const ageLimit of ["all", "13+", "16+", "18+", "21+"]) {
    assert.equal(moneyPlaceholderVisible({ role: "host", flags: { paidRooms: false, spray: false }, ageLimit, minorsRoom: false }), false, ageLimit);
    assert.equal(moneyPlaceholderVisible({ role: "host", flags: undefined, ageLimit, minorsRoom: false }), false, ageLimit);
  }
});
test("money placeholder: only for the host of an 18+/21+ room with an adult host while a flag is on", () => {
  const on = { paidRooms: true, spray: false };
  assert.equal(moneyPlaceholderVisible({ role: "host", flags: on, ageLimit: "18+", minorsRoom: false }), true);
  assert.equal(moneyPlaceholderVisible({ role: "host", flags: { paidRooms: false, spray: true }, ageLimit: "21+", minorsRoom: undefined }), true);
  assert.equal(moneyPlaceholderVisible({ role: "host", flags: on, ageLimit: "16+", minorsRoom: false }), false);
  assert.equal(moneyPlaceholderVisible({ role: "host", flags: on, ageLimit: "18+", minorsRoom: true }), false);
  assert.equal(moneyPlaceholderVisible({ role: "cohost", flags: on, ageLimit: "18+", minorsRoom: false }), false);
});

// ---------------------------------------------------------------- end the room
test("End asks 'End for everyone?' with the count of people other than the host", () => {
  assert.equal(endRoomCopy(23).title, "End for everyone?");
  assert.equal(endRoomCopy(23).body, "22 people will be sent out and the room closes.");
  assert.equal(endRoomCopy(2).body, "1 person will be sent out and the room closes.");
  assert.equal(endRoomCopy(1).body, "No one else is here. The room closes.");
  assert.equal(endRoomCopy(0).body, "No one else is here. The room closes.");
});

// ---------------------------------------------------------------- reducer and fixture
test("room:settings updates the room record and is ignored before the room arrives", () => {
  const before = initialRoomState("me");
  assert.equal(roomReducer(before, { type: "room:settings", pinnedMessage: "x", slowModeSec: 5, locked: true }), before);
  const s = fixtureControlsState("host");
  const next = roomReducer(s, { type: "room:settings", pinnedMessage: null, slowModeSec: 30, locked: true });
  assert.deepEqual(readSettings(next.room), { pinnedMessage: null, slowModeSec: 30, locked: true });
  assert.equal(next.room!.id, s.room!.id);
});
test("controls fixture: parses host/cohost only, and seeds requests and settings", () => {
  assert.equal(parseControlsFixture("?controls=host"), "host");
  assert.equal(parseControlsFixture("?controls=cohost"), "cohost");
  assert.equal(parseControlsFixture("?controls=admin"), null);
  assert.equal(parseControlsFixture(""), null);
  assert.equal("controls" in parseFixtureQuery("?controls=host"), false); // the existing query shape is unchanged
  const h = fixtureControlsState("host");
  assert.equal(h.you?.role, "host");
  assert.equal(requestQueue(h.hands, h.asks, h.liveVideo).length, 3);
  assert.deepEqual(readSettings(h.room), { pinnedMessage: "House rules: be kind, no spam.", slowModeSec: 5, locked: false });
  assert.equal(fixtureControlsState("cohost").you?.role, "cohost");
});

// ---------------------------------------------------------------- copy and house rules
test("copy: no em dashes, never the banned word, no anonymous guests setting", () => {
  const all = [...Object.values(CONTROLS_COPY), endRoomCopy(5).body, endRoomCopy(5).title].join("\n");
  assert.ok(!all.includes("—"));
  assert.ok(!/\bcash\b/i.test(all));
  assert.ok(!/anonymous/i.test(all));
  assert.equal(CONTROLS_COPY.kick, "Remove for 10 minutes");
});
test("files: icons only from the icon set, no em dashes, no anonymous setting, money controls not built", () => {
  const files = [
    "../client/src/lib/hostControls.ts",
    "../client/src/components/rooms/host/ControlsSheet.tsx", "../client/src/components/rooms/host/RequestsPanel.tsx",
    "../client/src/components/rooms/host/SettingsPanel.tsx", "../client/src/components/rooms/host/EndRoomDialog.tsx",
    "../client/src/components/rooms/host/PeoplePanel.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!src.includes("—"), `${f}: em dash`);
    assert.ok(!/\bcash\b/i.test(src), `${f}: banned word`);
    assert.ok(!/from "lucide-react"/.test(src), `${f}: icons must come from @/components/ui/icons`);
    assert.ok(!/anonymousAllowed|anonymous guests/i.test(src), `${f}: no anonymous setting`);
    assert.ok(!/\bprice\b|ticketChip|sprayEnabled/i.test(src), `${f}: money controls are not built in this phase`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
