// Rooms shell unit checks (no database, no DOM):   npx tsx scripts/test-rooms-unit-shell.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { RAIL_MIN_WIDTH, defaultVideoView, layoutFor } from "../client/src/lib/roomLayout";
import { DOCK_REACTIONS, camLockReason, orderPeople, roomSafetyRules, shareRoomUrl } from "../client/src/lib/roomShell";
import { ROOM_REACTIONS } from "../shared/rooms";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

// ---------------------------------------------------------------- width rule (task 1.5 imports these)
test("layout: the rail starts at 1024", () => assert.equal(RAIL_MIN_WIDTH, 1024));
test("layout: under 1024 the default video view is immersive", () => {
  for (const w of [390, 768, 1023]) assert.equal(defaultVideoView(w), "immersive", String(w));
});
test("layout: 1024 and wider default to compact", () => {
  for (const w of [1024, 1280]) assert.equal(defaultVideoView(w), "compact", String(w));
});
test("layout: phone and tablet stack; live is immersive by default there", () => {
  assert.deepEqual(layoutFor(390, "live"), { layout: "stack", immersiveDefault: true });
  assert.deepEqual(layoutFor(1023, "live"), { layout: "stack", immersiveDefault: true });
});
test("layout: desktop uses the rail and never starts immersive", () => {
  assert.deepEqual(layoutFor(1024, "live"), { layout: "rail", immersiveDefault: false });
  assert.deepEqual(layoutFor(1280, "voice"), { layout: "rail", immersiveDefault: false });
});
test("layout: a voice room is never immersive by default, at any width", () => {
  for (const w of [320, 390, 768, 1023, 1024, 1920]) assert.equal(layoutFor(w, "voice").immersiveDefault, false, String(w));
  assert.equal(layoutFor(390, "voice").layout, "stack");
});

// ---------------------------------------------------------------- dock
test("dock: six reactions, every one accepted by the server", () => {
  assert.equal(DOCK_REACTIONS.length, 6);
  for (const e of DOCK_REACTIONS) assert.ok(ROOM_REACTIONS.includes(e), e);
});
test("dock: the camera button explains why it is locked", () => {
  const base = { liveVideo: true, phaseLive: true, onStage: true, isHolder: false, cameraOn: false };
  assert.equal(camLockReason(base), undefined);
  assert.match(camLockReason({ ...base, onStage: false })!, /mic/);
  assert.match(camLockReason({ ...base, phaseLive: false })!, /reconnect/i);
  assert.match(camLockReason({ ...base, isHolder: true })!, /camera/i); // holder picks devices on the screen first
  assert.equal(camLockReason({ ...base, isHolder: true, cameraOn: true }), undefined); // tapping stops the stream
  assert.equal(camLockReason({ ...base, liveVideo: false }), "Live video is off in this room.");
});

// ---------------------------------------------------------------- people
test("people: host, then co-hosts, then the mic, then everyone else; order kept inside each group", () => {
  const m = (userId: string, role: "host" | "cohost" | "guest") => ({ userId, role });
  const out = orderPeople([m("g1", "guest"), m("c1", "cohost"), m("g2", "guest"), m("h", "host"), m("g3", "guest")], ["g3"]);
  assert.deepEqual(out.map((x) => x.userId), ["h", "c1", "g3", "g1", "g2"]);
});

// ---------------------------------------------------------------- safety
const texts = (r: ReturnType<typeof roomSafetyRules>) => r.map((x) => x.text).join(" | ");
test("safety: an 18+ room says under 18s are blocked", () => {
  const r = roomSafetyRules("18+");
  assert.equal(r[0].tone, "ok");
  assert.match(r[0].text, /Only adults/);
  assert.match(r[0].text, /Under 18s are blocked/);
});
test("safety: a 21+ room names 21", () => assert.match(roomSafetyRules("21+")[0].text, /21/));
test("safety: rooms open to under 18s name their minimum age", () => {
  assert.match(roomSafetyRules("all")[0].text, /13 and over/);
  assert.match(roomSafetyRules("13+")[0].text, /13 and over/);
  assert.match(roomSafetyRules("16+")[0].text, /16 and over/);
});
test("safety: a teens only room blocks adults", () => assert.match(roomSafetyRules("teen")[0].text, /under 18.*Adults are blocked/));
test("safety: anonymous lines only when the room allows anonymous guests", () => {
  assert.doesNotMatch(texts(roomSafetyRules("13+")), /nonymous/);
  const anon = roomSafetyRules("13+", { anonymousAllowed: true });
  assert.match(texts(anon), /Anonymous guests can read, chat and react/);
  assert.ok(anon.some((x) => x.tone === "no"));
  assert.ok(anon.some((x) => x.tone === "eye"));
  assert.match(anon[0].text, /Adults are not allowed to join anonymously/);
  assert.doesNotMatch(roomSafetyRules("18+", { anonymousAllowed: true })[0].text, /join anonymously/);
});
test("safety: always says how to report; copy has no em dashes and never says cash", () => {
  for (const l of ["all", "13+", "16+", "18+", "21+", "teen"] as const) {
    for (const anon of [false, true]) {
      const t = texts(roomSafetyRules(l, { anonymousAllowed: anon }));
      assert.match(t, /Report/);
      assert.doesNotMatch(t, /—/);
      assert.doesNotMatch(t, /cash/i);
    }
  }
});

// ---------------------------------------------------------------- share
test("share: public and friends rooms share a plain link; invite rooms cannot be shared", () => {
  assert.equal(shareRoomUrl("https://x.test", { id: "r1", visibility: "public" }), "https://x.test/rooms/r1");
  assert.equal(shareRoomUrl("https://x.test", { id: "r1", visibility: "friends" }), "https://x.test/rooms/r1");
  assert.equal(shareRoomUrl("https://x.test", { id: "r1", visibility: "invite" }), null);
  assert.equal(shareRoomUrl("https://x.test", { id: "a b", visibility: "public" }), "https://x.test/rooms/a%20b");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
