// Pure rules and copy for the minors' room screens (no database, no browser): npx tsx scripts/test-rooms-unit-minorsui.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MINORS_ROOM_WARNING } from "../shared/rooms";
import {
  ADULT_LISTEN_LINE, MINORS_UI_COPY, TEEN_HOST_NOTE, acknowledgeErrorMessage, ackAlreadyDone, inviteErrorMessage, inviteStatus,
  isMinorsCode, isMinorsDenied, listenOnlyHere, minorsCodeFor, parseRoomDenial, showAdultInvite, showTeenHostNote, warningScreenFor,
} from "../client/src/lib/minorsRoomUi";
import { AGE_LIMIT_EVICTED_COPY, DENIED_MESSAGE, HOST_REVIEW_COPY, NOTICE_MESSAGE } from "../client/src/lib/roomsApi";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

// ---------------------------------------------------------------- code to screen
test("MINORS_ROOM is the refuse screen and MINORS_ROOM_ACK is the enter screen", () => {
  assert.equal(warningScreenFor("MINORS_ROOM"), "refuse");
  assert.equal(warningScreenFor("MINORS_ROOM_ACK"), "ack");
});
test("no other code, and nothing at all, ever gets the warning screen (so a teen cannot reach it)", () => {
  for (const c of ["AGE_LIMIT", "AGE_UNKNOWN", "NOT_FOUND", "BANNED", "BLOCKED", "KICKED", "ROOM_FULL", "HOST_NOT_MINOR", "", null, undefined, 0, {}, "minors_room"]) {
    assert.equal(warningScreenFor(c), null, String(c));
    assert.equal(isMinorsCode(c), false, String(c));
  }
});
test("a 403 keeps only the code of a minors' room refusal, nothing else from the body", () => {
  const body = { code: "MINORS_ROOM", message: MINORS_ROOM_WARNING, warning: MINORS_ROOM_WARNING, title: "Secret", host: { id: "h" }, canJoin: { ok: false, code: "MINORS_ROOM" } };
  const kept = parseRoomDenial(403, body);
  assert.deepEqual(kept, { minorsDenied: "MINORS_ROOM" });
  assert.deepEqual(Object.keys(kept!), ["minorsDenied"]);
  assert.equal(JSON.stringify(kept).includes("Secret"), false);
  assert.deepEqual(parseRoomDenial(403, { code: "MINORS_ROOM_ACK" }), { minorsDenied: "MINORS_ROOM_ACK" });
});
test("other answers are not minors denials", () => {
  assert.equal(parseRoomDenial(403, { code: "AGE_UNKNOWN" }), null);
  assert.equal(parseRoomDenial(404, { code: "MINORS_ROOM" }), null);
  assert.equal(parseRoomDenial(200, { code: "MINORS_ROOM" }), null);
  assert.equal(parseRoomDenial(403, null), null);
  assert.equal(parseRoomDenial(403, "MINORS_ROOM"), null);
  assert.equal(isMinorsDenied({ minorsDenied: "NOPE" }), false);
  assert.equal(isMinorsDenied(null), false);
  assert.equal(isMinorsDenied({ room: {} }), false);
});
test("the HTTP answer and the socket refusal give the same screen", () => {
  const idle = { phase: "idle", error: null };
  assert.equal(minorsCodeFor({ minorsDenied: "MINORS_ROOM_ACK" }, idle), "MINORS_ROOM_ACK");
  assert.equal(minorsCodeFor(null, { phase: "denied", error: "MINORS_ROOM" }), "MINORS_ROOM");
  assert.equal(minorsCodeFor(null, { phase: "denied", error: "MINORS_ROOM_ACK" }), "MINORS_ROOM_ACK");
  assert.equal(minorsCodeFor({ minorsDenied: "MINORS_ROOM" }, { phase: "denied", error: "MINORS_ROOM_ACK" }), "MINORS_ROOM");
});
test("a socket refusal for any other reason, or not in the denied phase, shows no warning", () => {
  assert.equal(minorsCodeFor(null, { phase: "denied", error: "AGE_LIMIT" }), null);
  assert.equal(minorsCodeFor(null, { phase: "denied", error: null }), null);
  assert.equal(minorsCodeFor(null, { phase: "live", error: "MINORS_ROOM" }), null);
  assert.equal(minorsCodeFor(null, { phase: "idle", error: null }), null);
});
test("a refused acknowledgement that is already done carries on to joining", () => {
  assert.equal(ackAlreadyDone(409, "NOT_NEEDED"), true);
  assert.equal(ackAlreadyDone(409, "ROOM_ENDED"), false);
  assert.equal(ackAlreadyDone(403, "MINORS_ROOM"), false);
});

// ---------------------------------------------------------------- who sees what
test("Invite an adult shows to the host of a minors' room only", () => {
  assert.equal(showAdultInvite({ isHost: true, minorsRoom: true }), true);
  assert.equal(showAdultInvite({ isHost: false, minorsRoom: true }), false);
  assert.equal(showAdultInvite({ isHost: true, minorsRoom: false }), false);
  assert.equal(showAdultInvite({ isHost: true, minorsRoom: undefined }), false);
});
test("the teen host note shows for a known age of 17 or under only", () => {
  assert.equal(showTeenHostNote(13), true);
  assert.equal(showTeenHostNote(17), true);
  assert.equal(showTeenHostNote(18), false);
  assert.equal(showTeenHostNote(40), false);
  assert.equal(showTeenHostNote(null), false);
  assert.equal(showTeenHostNote(undefined), false);
});
test("adults only listen in a minors' room; teens and normal rooms are untouched", () => {
  assert.equal(listenOnlyHere({ minorsRoom: true, age: 18 }), true);
  assert.equal(listenOnlyHere({ minorsRoom: true, age: 35 }), true);
  assert.equal(listenOnlyHere({ minorsRoom: true, age: 16 }), false);
  assert.equal(listenOnlyHere({ minorsRoom: true, age: 13 }), false);
  assert.equal(listenOnlyHere({ minorsRoom: false, age: 35 }), false);
  assert.equal(listenOnlyHere({ minorsRoom: undefined, age: 35 }), false);
});
test("while the viewer's age is not known yet, the offers stay hidden in a minors' room only", () => {
  assert.equal(listenOnlyHere({ minorsRoom: true, age: null }), true);
  assert.equal(listenOnlyHere({ minorsRoom: true, age: undefined }), true);
  assert.equal(listenOnlyHere({ minorsRoom: false, age: null }), false);
});
test("invite status: invited, acknowledged, revoked", () => {
  assert.equal(inviteStatus({ acknowledged: false }), "invited");
  assert.equal(inviteStatus({ acknowledged: true }), "acknowledged");
  assert.equal(inviteStatus({ acknowledged: true }, true), "revoked");
  assert.equal(inviteStatus({ acknowledged: false }, true), "revoked");
});

// ---------------------------------------------------------------- copy
test("the warning on every denial path is the shared constant, word for word", () => {
  assert.equal(DENIED_MESSAGE.MINORS_ROOM, MINORS_ROOM_WARNING);
  assert.equal(DENIED_MESSAGE.MINORS_ROOM_ACK, MINORS_ROOM_WARNING);
  const component = readFileSync(new URL("../client/src/components/rooms/MinorsRoomWarning.tsx", import.meta.url), "utf8");
  assert.ok(component.includes("{MINORS_ROOM_WARNING}"), "the screen renders the shared constant");
  assert.ok(!component.includes("under 18s. Adults can only"), "the screen does not carry its own copy of the text");
});
test("the warning screen never reads a room title or host", () => {
  const component = readFileSync(new URL("../client/src/components/rooms/MinorsRoomWarning.tsx", import.meta.url), "utf8");
  assert.ok(!/\.title|\.host\b|hostName|memberCount|\.description|HostAvatar/.test(component), "no title/host/count access");
  assert.ok(component.includes("border-destructive") && !/amber/i.test(component), "destructive token, not amber");
});
test("the page keeps the code only and hides the header above the warning", () => {
  const page = readFileSync(new URL("../client/src/pages/RoomPage.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("parseRoomDenial("), "the 403 goes through the code-only parser");
  assert.ok(page.includes("!minorsCode"), "the header is hidden for the warning");
});
test("host refusal and review closure copy exist and read plainly", () => {
  assert.equal(DENIED_MESSAGE.HOST_NOT_MINOR, "Only hosts under 18 can do this in a room for under 18s.");
  assert.equal(NOTICE_MESSAGE.HOST_NOT_MINOR, DENIED_MESSAGE.HOST_NOT_MINOR);
  assert.equal(NOTICE_MESSAGE.HOST_REVIEW, "This room has closed because the host's account is being reviewed.");
  assert.equal(HOST_REVIEW_COPY, NOTICE_MESSAGE.HOST_REVIEW);
  assert.equal(NOTICE_MESSAGE.AGE_LIMIT, "You no longer meet this room's age limit.");
  assert.equal(AGE_LIMIT_EVICTED_COPY, NOTICE_MESSAGE.AGE_LIMIT);
});
test("fixed lines are exactly the agreed wording", () => {
  assert.equal(TEEN_HOST_NOTE, "Only people under 18 can join. You can invite an adult yourself.");
  assert.equal(ADULT_LISTEN_LINE, "In this room adults can listen and chat.");
});
test("invite errors are plain and tell the host nothing about why", () => {
  assert.equal(inviteErrorMessage(403, "NOT_ALLOWED"), "You can't invite this person.");
  assert.equal(inviteErrorMessage(403, "HOST_NOT_MINOR"), DENIED_MESSAGE.HOST_NOT_MINOR);
  assert.equal(inviteErrorMessage(429, "RATE_LIMITED"), "Slow down a little, then try again.");
  assert.equal(inviteErrorMessage(429), inviteErrorMessage(200, "RATE_LIMITED"));
  assert.equal(inviteErrorMessage(500), "That didn't work. Try again.");
  assert.ok(!/age|block|ban|adult|under/i.test(inviteErrorMessage(403, "NOT_ALLOWED")), "no reason is given");
});
test("acknowledge errors cover revoked, banned, ended and unknown cases", () => {
  assert.match(acknowledgeErrorMessage(403, "MINORS_ROOM"), /took back your invite/);
  assert.match(acknowledgeErrorMessage(409, "ROOM_ENDED"), /ended/);
  assert.match(acknowledgeErrorMessage(404), /isn't available/);
  assert.match(acknowledgeErrorMessage(0), /didn't work/);
});
test("no em dash, en dash or the word cash in any new copy", () => {
  const all = [...MINORS_UI_COPY, HOST_REVIEW_COPY, AGE_LIMIT_EVICTED_COPY, DENIED_MESSAGE.MINORS_ROOM, DENIED_MESSAGE.HOST_NOT_MINOR, DENIED_MESSAGE.NOT_ALLOWED];
  assert.ok(all.length > 20);
  for (const t of all) {
    assert.ok(!/[—–]/.test(t), `dash in: ${t}`);
    assert.ok(!/cash/i.test(t), `cash in: ${t}`);
    assert.ok(t.trim().length > 0);
  }
});
test("no em dash or the word cash in the new component source either", () => {
  for (const f of ["components/rooms/MinorsRoomWarning.tsx", "components/rooms/AdultInviteSheet.tsx", "lib/minorsRoomUi.ts", "lib/minorsRoomApi.ts"]) {
    const src = readFileSync(new URL(`../client/src/${f}`, import.meta.url), "utf8");
    assert.ok(!/[—–]/.test(src), `dash in ${f}`);
    assert.ok(!/cash/i.test(src), `cash in ${f}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
