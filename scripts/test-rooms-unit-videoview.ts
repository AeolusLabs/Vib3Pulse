// Rooms unit checks for the live video views (no database):   npx tsx scripts/test-rooms-unit-videoview.ts
import assert from "node:assert/strict";
import {
  IMMERSIVE_HINT_KEY, chromeHiddenFor, crossesRailLine, effectiveView, immersiveNotice, liveMeta, qualityLabel,
  railAction, railPrimary, resizeStep, shouldShowImmersiveHint, stripOrder, viewAfterResize, weakDismissedAfter, type NoticeInput,
} from "../client/src/lib/videoViewState";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

// ---------------------------------------------------------------- view after resize
test("view: phone to tablet (390 to 768) keeps a user's compact choice", () => {
  assert.equal(viewAfterResize("compact", true, 390, 768), "compact");
});
test("view: 768 to 1280 resets to compact even if the user chose immersive", () => {
  assert.equal(viewAfterResize("immersive", true, 768, 1280), "compact");
});
test("view: 1280 to 768 resets to immersive", () => {
  assert.equal(viewAfterResize("compact", true, 1280, 768), "immersive");
  assert.equal(viewAfterResize("compact", false, 1280, 768), "immersive");
});
test("view: without a user choice the default always follows the width", () => {
  assert.equal(viewAfterResize("compact", false, 390, 768), "immersive");
  assert.equal(viewAfterResize("immersive", false, 1100, 1280), "compact");
  assert.equal(viewAfterResize("compact", false, 1023, 1024), "compact");
  assert.equal(viewAfterResize("immersive", false, 1024, 1023), "immersive");
});
test("view: the 1024 line is crossed only when the two widths sit on different sides", () => {
  assert.equal(crossesRailLine(1023, 1024), true);
  assert.equal(crossesRailLine(1024, 1023), true);
  assert.equal(crossesRailLine(390, 1023), false);
  assert.equal(crossesRailLine(1024, 1920), false);
});
test("view: desktop widths never show immersive", () => {
  assert.equal(effectiveView("immersive", 1280), "compact");
  assert.equal(effectiveView("immersive", 1024), "compact");
  assert.equal(effectiveView("immersive", 1023), "immersive");
  assert.equal(effectiveView("compact", 390), "compact");
});

// ---------------------------------------------------------------- chrome hiding
test("chrome: hidden only in immersive while live", () => {
  assert.equal(chromeHiddenFor("immersive", true, true), true);
  assert.equal(chromeHiddenFor("compact", true, true), false);
  assert.equal(chromeHiddenFor("immersive", false, true), false);
  assert.equal(chromeHiddenFor("immersive", true, false), false);
});

// ---------------------------------------------------------------- first-time hint
const fakeStore = (init: Record<string, string> = {}) => {
  const data = { ...init };
  return { data, getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => { data[k] = v; } };
};
test("hint: shown the first time, remembered under rooms.immersiveHint, then never again", () => {
  assert.equal(IMMERSIVE_HINT_KEY, "rooms.immersiveHint");
  const s = fakeStore();
  assert.equal(shouldShowImmersiveHint(s), true);
  assert.equal(s.data["rooms.immersiveHint"], "1");
  assert.equal(shouldShowImmersiveHint(s), false);
});
test("hint: blocked storage does not throw; no storage still shows it", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(shouldShowImmersiveHint(broken), true);
  assert.equal(shouldShowImmersiveHint(null), true);
  const setFails = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.equal(shouldShowImmersiveHint(setFails), true);
});

// ---------------------------------------------------------------- weak network notice (immersive shows one at a time)
const n = (o: Partial<NoticeInput> = {}): NoticeInput => ({ isHolder: false, holderLeftMs: null, videoPaused: false, weakLink: false, cameraOn: false, audioOnly: false, holderAway: false, hasPicture: true, ...o });
test("notice: viewer on a weak link is offered sound only, unless sound only is already on", () => {
  assert.equal(immersiveNotice(n({ weakLink: true })), "weak-link-viewer");
  assert.equal(immersiveNotice(n({ weakLink: true, audioOnly: true })), null);
  assert.equal(immersiveNotice(n()), null);
});
test("notice: holder sees reconnecting first, then paused picture, then weak link advice", () => {
  const h = (o: Partial<NoticeInput>) => immersiveNotice(n({ isHolder: true, ...o }));
  assert.equal(h({ holderLeftMs: 90_000, videoPaused: true, weakLink: true, cameraOn: true }), "holder-reconnecting");
  assert.equal(h({ holderLeftMs: 0 }), "holder-reconnecting");
  assert.equal(h({ videoPaused: true, weakLink: true, cameraOn: true }), "video-paused");
  assert.equal(h({ weakLink: true, cameraOn: true }), "weak-link-holder");
  assert.equal(h({ weakLink: true, cameraOn: false }), null);
  assert.equal(h({ weakLink: true, audioOnly: true }), null);
  // sound only is a viewer setting: a holder whose camera is on still gets the weak link advice
  assert.equal(h({ weakLink: true, audioOnly: true, cameraOn: true }), "weak-link-holder");
});
test("notice: viewer sees the holder is away over a frozen picture, ahead of weak link advice", () => {
  assert.equal(immersiveNotice(n({ holderAway: true })), "holder-away");
  assert.equal(immersiveNotice(n({ holderAway: true, weakLink: true })), "holder-away");
  assert.equal(immersiveNotice(n({ holderAway: true, audioOnly: true })), "holder-away");
  // no picture: the be-right-back slate already says it, so no banner on top of it
  assert.equal(immersiveNotice(n({ holderAway: true, hasPicture: false })), null);
  assert.equal(immersiveNotice(n({ holderAway: true, hasPicture: false, weakLink: true })), "weak-link-viewer");
  // the holder's own drop is the reconnecting banner, not the viewer's away notice
  assert.equal(immersiveNotice(n({ isHolder: true, holderAway: true, holderLeftMs: 5000 })), "holder-reconnecting");
  assert.equal(immersiveNotice(n({ isHolder: true, holderAway: true })), null);
});
test("notice: Not now on the weak link banner lasts until the link recovers", () => {
  assert.equal(weakDismissedAfter(true, true), true);
  assert.equal(weakDismissedAfter(true, false), false);
  assert.equal(weakDismissedAfter(false, true), false);
});

// ---------------------------------------------------------------- rail
test("rail: holders get Live controls, viewers get the quality name", () => {
  assert.deepEqual(railPrimary(true, "Auto"), { label: "Live controls", caption: "Controls" });
  assert.deepEqual(railPrimary(false, "Data saver"), { label: "Video quality: Data saver", caption: "Data saver" });
});
test("rail: one-tap Stop live for a live holder; ask or cancel for a viewer who may ask", () => {
  const a = (o: Partial<Parameters<typeof railAction>[0]>) => railAction({ isHolder: false, cameraOn: false, videoPaused: false, canAsk: false, asked: false, askLabel: "Ask to go live", ...o });
  assert.deepEqual(a({ isHolder: true, cameraOn: true }), { kind: "stop", label: "Stop live" });
  assert.deepEqual(a({ isHolder: true, videoPaused: true }), { kind: "stop", label: "Stop live" });
  assert.equal(a({ isHolder: true }), null); // not live yet: Go live needs the device picker
  assert.deepEqual(a({ canAsk: true }), { kind: "ask", label: "Ask to go live" });
  assert.deepEqual(a({ canAsk: true, asked: true }), { kind: "withdraw", label: "Cancel request" });
  assert.equal(a({}), null);
});

// ---------------------------------------------------------------- resize step (useVideoView)
test("resize step: crossing the line resets the view and forgets the user's choice", () => {
  assert.deepEqual(resizeStep({ view: "immersive", userChose: true }, 768, 1280), { view: "compact", userChose: false });
  assert.deepEqual(resizeStep({ view: "compact", userChose: true }, 390, 768), { view: "compact", userChose: true });
  assert.deepEqual(resizeStep({ view: "compact", userChose: false }, 390, 768), { view: "immersive", userChose: false });
  // after a reset the default follows the width again
  const s1 = resizeStep({ view: "compact", userChose: true }, 1280, 800);
  assert.deepEqual(resizeStep(s1, 800, 600), { view: "immersive", userChose: false });
});

// ---------------------------------------------------------------- labels
test("labels: quality names match the quality picker; sound only wins", () => {
  assert.equal(qualityLabel("auto", false), "Auto");
  assert.equal(qualityLabel("saver", false), "Data saver");
  assert.equal(qualityLabel("balanced", false), "Balanced");
  assert.equal(qualityLabel("standard", false), "High");
  assert.equal(qualityLabel("standard", true), "Sound only");
});
test("labels: the top bar says when the holder is away", () => {
  assert.equal(liveMeta("Dayo", 19, true), "Dayo is reconnecting, 19 watching");
  assert.equal(liveMeta(null, 3, true), "Reconnecting, 3 watching");
  assert.equal(liveMeta("Dayo", 19, false), "Dayo is live, 19 watching");
});
test("labels: the immersive top bar line, with no em dash", () => {
  assert.equal(liveMeta("Dayo", 19), "Dayo is live, 19 watching");
  assert.equal(liveMeta("Dayo", 1), "Dayo is live, 1 watching");
  assert.equal(liveMeta(null, 4), "Live, 4 watching");
  assert.ok(!liveMeta("A", 2).includes(String.fromCharCode(0x2014)));
});

// ---------------------------------------------------------------- speaker strip order
test("strip: host, then co-hosts, then stage guests in stage order; the floor is left out", () => {
  const m = (userId: string, role: "host" | "cohost" | "guest") => ({ userId, role });
  const members = [m("g1", "guest"), m("c1", "cohost"), m("g2", "guest"), m("h", "host"), m("g3", "guest"), m("c2", "cohost")];
  assert.deepEqual(stripOrder(members, ["g3", "g1", "c1", "gone"]).map((x) => x.userId), ["h", "c1", "c2", "g3", "g1"]);
  assert.deepEqual(stripOrder([m("g1", "guest")], []).map((x) => x.userId), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
