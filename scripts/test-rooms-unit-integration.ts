// Room page integration rules (no database, no browser):   npx tsx scripts/test-rooms-unit-integration.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ROOM_SHEET_CLOSE, authorPick, showsShell, chromeClasses, memberById, replyFromItem, returnFocusTestId, shellImmersive, statusLine, stripNotice, topBarSubtitle, videoIsLive,
} from "../client/src/lib/roomIntegration";
import { defaultVideoView, layoutFor } from "../client/src/lib/roomLayout";
import { effectiveView, railAction, resizeStep } from "../client/src/lib/videoViewState";
import { CHAT_CAP, initialRoomState, roomReducer, type RoomState } from "../client/src/lib/roomReducer";
import { canQuote, quoteView } from "../client/src/lib/chatReply";
import { REACT_GATE, reactGate } from "../client/src/lib/hype";
import { NOTICE_MESSAGE } from "../client/src/lib/roomsApi";
import { FIXTURE_IDS, fixtureLiveState, fixtureStartView, parseFixtureQuery } from "../client/src/lib/roomFixtures";
import { cn } from "../client/src/lib/utils";
import { frameSlots } from "../client/src/lib/roomShell";
import { trayOutsideTap } from "../client/src/components/rooms/chat/ReactionTray";
import { CHAT_QUOTE_WINDOW, ROOM_LIMITS, resolveChatReply } from "../shared/rooms";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

// ---------------------------------------------------------------- which view the page shows
const viewAt = (w: number, live: boolean) => {
  const { layout } = layoutFor(w, live ? "live" : "voice");
  return shellImmersive({ layout, live, view: effectiveView(defaultVideoView(w), w) });
};
test("views: phone 375 and tablet portrait 768 open live video immersive", () => {
  assert.equal(viewAt(375, true), true);
  assert.equal(viewAt(768, true), true);
  assert.equal(viewAt(1023, true), true);
});
test("views: tablet landscape 1024 and desktop 1280 use compact with the chat rail, never immersive", () => {
  for (const w of [1024, 1280, 1920]) {
    assert.equal(layoutFor(w, "live").layout, "rail", String(w));
    assert.equal(viewAt(w, true), false, String(w));
    // even a stored immersive choice is ignored on desktop
    assert.equal(shellImmersive({ layout: "rail", live: true, view: "immersive" }), false);
  }
});
test("views: a voice room, or live video with nobody on the screen yet, is never immersive", () => {
  assert.equal(viewAt(375, false), false);
  assert.equal(videoIsLive({ liveVideo: true, holder: null }), false);
  assert.equal(videoIsLive({ liveVideo: false, holder: "u1" }), false);
  assert.equal(videoIsLive({ liveVideo: true, holder: "u1" }), true);
  assert.equal(videoIsLive({ liveVideo: true, holder: "u1", linkScreens: true }), false);
});
test("views: rotating a tablet across 1024 resets the choice to that width's default", () => {
  const chose = { view: "compact" as const, userChose: true };
  assert.deepEqual(resizeStep(chose, 768, 820), chose); // same side: the choice stays
  assert.deepEqual(resizeStep(chose, 768, 1180), { view: "compact", userChose: false });
  assert.deepEqual(resizeStep({ view: "compact", userChose: false }, 1180, 768), { view: "immersive", userChose: false });
});

test("views: compact live video on a phone gives the zone room for picture, controls and speakers; voice keeps 38dvh", () => {
  assert.match(frameSlots("stack", false, { live: true }).zone, /max-h-\[52dvh\]/);
  assert.match(frameSlots("stack", false).zone, /max-h-\[38dvh\]/);
  assert.deepEqual(frameSlots("rail", false, { live: true }), frameSlots("rail", false));
});

test("page: a failed details refetch keeps the live room on screen; no details or a closed room never shows it", () => {
  const base = { isLoading: false, hasDetail: true, roomStatus: "live", canJoin: true, phase: "live" };
  assert.equal(showsShell(base), true);
  assert.equal(showsShell({ ...base, phase: "reconnecting" }), true);
  assert.equal(showsShell({ ...base, hasDetail: false }), false);
  assert.equal(showsShell({ ...base, isLoading: true }), false);
  for (const roomStatus of ["ended", "scheduled"]) assert.equal(showsShell({ ...base, roomStatus }), false, roomStatus);
  for (const phase of ["idle", "connecting", "ended", "denied"]) assert.equal(showsShell({ ...base, phase }), false, phase);
  assert.equal(showsShell({ ...base, canJoin: false }), false);
});

// ---------------------------------------------------------------- chat: reply quotes
test("reply: the quote is cut exactly like the server cuts it, so the server accepts it", () => {
  const long = `  ${"word ".repeat(80)}  `;
  const r = replyFromItem({ userId: "u1", text: long });
  assert.ok(r);
  assert.ok(Array.from(r!.text).length <= ROOM_LIMITS.replyText);
  assert.equal(r!.text, r!.text.trim());
  const ring = [{ userId: "u1", text: long.trim().slice(0, ROOM_LIMITS.chat) }];
  assert.deepEqual(resolveChatReply(ring, r), r);
});
test("reply: always addressed by userId; a whitespace-only line has nothing to quote", () => {
  assert.deepEqual(Object.keys(replyFromItem({ userId: "u9", text: "hi" })!).sort(), ["text", "userId"]);
  assert.equal(replyFromItem({ userId: "u9", text: "   " }), null);
});
test("reply: a reply to someone who left still renders, attributed to Someone", () => {
  let s: RoomState = initialRoomState("me");
  s = roomReducer(s, { type: "room:chat", userId: "me", text: "back at you", at: 1, replyTo: { userId: "gone", text: "see you" } }, () => 1);
  assert.deepEqual(s.chat[0].replyTo, { userId: "gone", text: "see you" });
  const nameOf = (id: string) => (id === "me" ? "Me" : ""); // the page has no name for them any more
  assert.deepEqual(quoteView(s.chat[0].replyTo!, new Set(), nameOf), { name: "Someone", text: "see you" });
  assert.equal(memberById([{ userId: "me" }], "gone"), null);
  assert.deepEqual(memberById([{ userId: "me" }], "me"), { userId: "me" });
});

test("author pick: open someone in the list; say they left only if we saw them; otherwise never claim it", () => {
  const members = [{ userId: "here" }];
  assert.deepEqual(authorPick(members, () => true, "here"), { kind: "open", member: { userId: "here" } });
  assert.deepEqual(authorPick(members, (id) => id === "gone", "gone"), { kind: "left" });
  assert.deepEqual(authorPick(members, () => false, "stranger"), { kind: "unknown" });
});

test("reply: only the newest CHAT_QUOTE_WINDOW lines can be quoted (the server keeps no more), so older lines offer no Reply", () => {
  assert.equal(CHAT_QUOTE_WINDOW, 50);
  assert.equal(canQuote(199, 200), true);   // newest
  assert.equal(canQuote(150, 200), true);   // 50th newest
  assert.equal(canQuote(149, 200), false);  // 51st newest
  assert.equal(canQuote(0, 10), true);
  assert.equal(canQuote(-1, 10), false);
});

// ---------------------------------------------------------------- chat: a busy room
test("busy room: 300 lines in 10 s keep only the newest CHAT_CAP lines, in order, ids unique", () => {
  let s: RoomState = initialRoomState("me");
  for (let i = 1; i <= 300; i++) s = roomReducer(s, { type: "room:chat", userId: `u${i % 7}`, text: `line ${i}`, at: i * 33 }, () => i * 33);
  assert.equal(s.chat.length, CHAT_CAP);
  assert.equal(s.chat[0].text, `line ${300 - CHAT_CAP + 1}`);
  assert.equal(s.chat[s.chat.length - 1].text, "line 300");
  assert.equal(new Set(s.chat.map((c) => c.id)).size, CHAT_CAP);
});

// ---------------------------------------------------------------- reactions
test("reaction spam: 20 taps in 2 s are metered and the blocked ones show the existing slow-down line", () => {
  let st = { tokens: REACT_GATE.burst, at: 0 };
  let sent = 0, blocked = 0;
  for (let i = 0; i < 20; i++) { const g = reactGate(st, i * 100); st = g.state; if (g.ok) sent++; else blocked++; }
  assert.ok(sent <= REACT_GATE.burst + Math.ceil(2 * REACT_GATE.ratePerSec), String(sent));
  assert.ok(blocked > 0);
  assert.equal(NOTICE_MESSAGE.RATE_LIMITED, "Slow down a little.");
});
test("status lines: one at a time; the fullscreen strip shows the slow-down line too", () => {
  assert.equal(statusLine("Ada waved at you", "x", "y"), "Ada waved at you");
  assert.equal(statusLine(null, "notice", "gate"), "notice");
  assert.equal(statusLine(null, null, "gate"), "gate");
  assert.equal(statusLine(null, null, null), null);
  assert.equal(stripNotice(null, NOTICE_MESSAGE.RATE_LIMITED), "Slow down a little.");
  assert.equal(stripNotice("Muted", "gate"), "Muted");
});

test("tray: a tap inside the tray or on the heart never closes it from outside; anywhere else does (even if <body> was active)", () => {
  const node = (name: string) => ({ name }) as unknown as Node;
  const box = (...inside: Node[]) => ({ contains: (n: Node | null) => !!n && inside.includes(n) });
  const item = node("item"), heartIcon = node("heart-svg"), composer = node("composer"), page = node("page");
  const tray = box(item), heart = box(heartIcon);
  assert.equal(trayOutsideTap(item, tray, heart), "ignore");
  assert.equal(trayOutsideTap(heartIcon, tray, heart), "ignore");
  assert.equal(trayOutsideTap(composer, tray, heart), "close");
  assert.equal(trayOutsideTap(page, tray, heart), "close");
  assert.equal(trayOutsideTap(page, tray, null), "close"); // heart gone (typing): still closes
  assert.equal(trayOutsideTap(null, tray, heart), "ignore");
});

// ---------------------------------------------------------------- immersive chrome, rail, top bar
test("chrome: hidden top bar and dock fade by opacity only and come back while focus is inside", () => {
  assert.equal(chromeClasses(false, true), "");
  const hid = chromeClasses(true, true);
  assert.match(hid, /\bopacity-0\b/);
  assert.match(hid, /\bpointer-events-none\b/);
  assert.match(hid, /focus-within:opacity-100/);
  assert.match(hid, /focus-within:pointer-events-auto/);
  assert.match(hid, /motion-reduce:transition-none/);
  assert.match(hid, /\btransition-opacity\b/);
  assert.doesNotMatch(hid, /transition-all|transition-\[/);
  assert.doesNotMatch(chromeClasses(true, false), /opacity-0/);
});
test("top bar: immersive says who is live and how many watch, or that they are reconnecting", () => {
  assert.equal(topBarSubtitle({ immersive: false, holderName: "Dayo", count: 19, away: false }), undefined);
  assert.equal(topBarSubtitle({ immersive: true, holderName: "Dayo", count: 19, away: false }), "Dayo is live, 19 watching");
  assert.equal(topBarSubtitle({ immersive: true, holderName: "Dayo", count: 19, away: true }), "Dayo is reconnecting, 19 watching");
  assert.equal(topBarSubtitle({ immersive: true, holderName: "Dayo", count: 19, away: false, self: true }), "You're live, 19 watching");
  assert.equal(topBarSubtitle({ immersive: true, holderName: "Dayo", count: 19, away: true, self: true }), "You're reconnecting, 19 watching");
});
test("rail: a live holder gets Stop live; a viewer who may ask gets Ask, then Cancel request", () => {
  assert.equal(railAction({ isHolder: true, cameraOn: true, videoPaused: false, canAsk: false, asked: false, askLabel: "Go live" })?.kind, "stop");
  assert.equal(railAction({ isHolder: false, cameraOn: false, videoPaused: false, canAsk: true, asked: false, askLabel: "Ask to go live" })?.label, "Ask to go live");
  assert.equal(railAction({ isHolder: false, cameraOn: false, videoPaused: false, canAsk: true, asked: true, askLabel: "Ask to go live" })?.kind, "withdraw");
  assert.equal(railAction({ isHolder: false, cameraOn: false, videoPaused: false, canAsk: false, asked: false, askLabel: "x" }), null);
});

// ---------------------------------------------------------------- sheets
test("sheets: the room close button is a 44 px target and always visible", () => {
  assert.match(ROOM_SHEET_CLOSE, /\bh-11\b/);
  assert.match(ROOM_SHEET_CLOSE, /\bw-11\b/);
  assert.match(ROOM_SHEET_CLOSE, /\bopacity-100\b/);
});
test("sheets: other pages' close buttons are unchanged when no closeClassName is given", () => {
  const src = readFileSync(new URL("../client/src/components/ui/sheet.tsx", import.meta.url), "utf8");
  const base = /<SheetPrimitive\.Close className=\{cn\("([^"]+)", closeClassName\)\}/.exec(src)?.[1];
  assert.ok(base, "close button base classes found");
  assert.equal(cn(base!, undefined), base); // byte for byte what it was before the prop existed
  const merged = cn(base!, ROOM_SHEET_CLOSE);
  assert.match(merged, /\bright-2\b/); assert.doesNotMatch(merged, /\bright-4\b/);
  assert.match(merged, /\brounded-full\b/); assert.doesNotMatch(merged, /\brounded-sm\b/);
  assert.match(merged, /\bopacity-100\b/); assert.doesNotMatch(merged, /\bopacity-70\b/);
  assert.match(merged, /focus:ring-2/); // the focus ring stays
});
test("sheets: a sheet opened from another sheet hands focus back to the top bar button that started it", () => {
  assert.equal(returnFocusTestId("more"), "room-more");
  assert.equal(returnFocusTestId("people"), "room-people");
  assert.equal(returnFocusTestId(null), null);
});

// ---------------------------------------------------------------- dev fixture options
test("fixture query: defaults, clamps and unknown values", () => {
  assert.deepEqual(parseFixtureQuery(""), { scene: "voice", theme: "dark", as: "guest", sound: false, tap: false, invite: false, flood: 0 });
  const o = parseFixtureQuery("?scene=weak&theme=light&as=holder&sound=1&tap=1&invite=1&flood=300");
  assert.deepEqual(o, { scene: "weak", theme: "light", as: "holder", sound: true, tap: true, invite: true, flood: 300 });
  assert.equal(parseFixtureQuery("?scene=nope&as=admin&flood=-4").scene, "voice");
  assert.equal(parseFixtureQuery("?as=admin").as, "guest");
  assert.equal(parseFixtureQuery("?flood=99999").flood, 1000);
  assert.equal(parseFixtureQuery("?flood=abc").flood, 0);
});
test("fixture state: dropped holds the spot for about 100 s from now; holder and host views", () => {
  const now = 5_000_000;
  const d = fixtureLiveState("dropped", { as: "guest", now });
  assert.equal(d.holderAwayUntil, now + 100_000);
  assert.equal(d.serverOffsetMs, 0);
  assert.equal(fixtureLiveState("live", { as: "guest", now }).holderAwayUntil, null);
  assert.equal(fixtureLiveState("live", { as: "holder", now }).selfId, FIXTURE_IDS.stage);
  const h = fixtureLiveState("voice", { as: "host", now });
  assert.equal(h.selfId, FIXTURE_IDS.host);
  assert.equal(h.you?.role, "host");
  assert.equal(fixtureLiveState("immersive", { as: "guest", now, invite: true }).invitedYou, true);
  assert.equal(fixtureLiveState("immersive", { as: "guest", now }).invitedYou, false);
  assert.equal(fixtureStartView("live"), "compact");
  assert.equal(fixtureStartView("immersive"), undefined);
});

// ---------------------------------------------------------------- house rules on the new files
test("copy and imports: no em dashes, no banned word, icons only from the icon set", () => {
  const files = [
    "../client/src/components/rooms/shell/RoomShell.tsx", "../client/src/components/rooms/shell/RoomSheetContent.tsx",
    "../client/src/lib/roomIntegration.ts", "../client/src/pages/dev/RoomFixture.tsx", "../client/src/pages/RoomPage.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!src.includes("—"), `${f}: em dash`);
    assert.ok(!/\bcash\b/i.test(src), `${f}: banned word`);
    assert.ok(!/from "lucide-react"/.test(src), `${f}: icons must come from @/components/ui/icons`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
