// Chat reply checks (no database):   npx tsx scripts/test-rooms-unit-chatreply.ts   (also run by npm run test:rooms)
import assert from "node:assert/strict";
import { ROOM_LIMITS, validateChatReply, resolveChatReply } from "../shared/rooms";
import { replyProgress, quoteLabel, quoteView, swipeDecision, REPLY_COMMIT_PX } from "../client/src/lib/chatReply";
import { roomReducer, initialRoomState } from "../client/src/lib/roomReducer";
import { RoomHub } from "../server/rooms/RoomHub";

let passed = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message}`); }
};

t("limit is 120", () => assert.equal(ROOM_LIMITS.replyText, 120));
t("validateChatReply trims", () => assert.deepEqual(validateChatReply({ userId: "u1", text: "  hi  " }), { userId: "u1", text: "hi" }));
t("validateChatReply cuts long text to 120", () => assert.equal(validateChatReply({ userId: "u1", text: "x".repeat(300) })!.text.length, 120));
t("validateChatReply rejects non-string userId", () => assert.equal(validateChatReply({ userId: 5, text: "x" }), null));
t("validateChatReply rejects non-string text", () => assert.equal(validateChatReply({ userId: "u", text: 5 }), null));
t("validateChatReply rejects extra keys", () => assert.equal(validateChatReply({ userId: "u", text: "x", evil: 1 }), null));
t("validateChatReply rejects missing keys, empty text, long id, non-objects", () => {
  assert.equal(validateChatReply({ userId: "u" }), null);
  assert.equal(validateChatReply({ userId: "u", text: "   " }), null);
  assert.equal(validateChatReply({ userId: "u".repeat(65), text: "x" }), null);
  assert.equal(validateChatReply({ userId: "", text: "x" }), null);
  for (const bad of [null, undefined, 5, "x", [], ["u", "x"], true]) assert.equal(validateChatReply(bad), null);
});
t("validateChatReply output has only the two keys", () => assert.deepEqual(Object.keys(validateChatReply({ userId: "u", text: "x" })!), ["userId", "text"]));

t("resolveChatReply takes the text from the server record", () => {
  const recent = [{ userId: "b", text: "earlier" }, { userId: "c", text: "other" }];
  assert.deepEqual(resolveChatReply(recent, { userId: "b", text: "earlier" }), { userId: "b", text: "earlier" });
});
t("resolveChatReply refuses a forged quote, a wrong author and an unknown line", () => {
  const recent = [{ userId: "b", text: "earlier" }];
  assert.equal(resolveChatReply(recent, { userId: "b", text: "I love you" }), null);
  assert.equal(resolveChatReply(recent, { userId: "c", text: "earlier" }), null);
  assert.equal(resolveChatReply([], { userId: "b", text: "earlier" }), null);
  assert.equal(resolveChatReply(recent, null), null);
});
t("resolveChatReply matches a long line by its clamped text and returns the clamped form", () => {
  const long = "y".repeat(300);
  const q = validateChatReply({ userId: "b", text: long })!;
  assert.equal(resolveChatReply([{ userId: "b", text: long }], q)!.text.length, 120);
});

t("replyProgress: never negative", () => { const p = replyProgress(-20); assert.equal(p.offset, 0); assert.equal(p.commit, false); assert.equal(p.reveal, 0); });
t("replyProgress: 30 does not commit", () => { const p = replyProgress(30); assert.equal(p.commit, false); assert.equal(p.offset, 30); });
t("replyProgress: 60 commits, offset damped below 80", () => { const p = replyProgress(60); assert.equal(p.commit, true); assert.ok(p.offset < 80 && p.offset >= REPLY_COMMIT_PX); });
t("replyProgress: huge drag stays bounded and reveal is 0..1", () => { const p = replyProgress(5000); assert.ok(p.offset < 80); assert.ok(p.reveal >= 0 && p.reveal <= 1); });
t("replyProgress: commit exactly at 56", () => { assert.equal(replyProgress(55.9).commit, false); assert.equal(replyProgress(56).commit, true); });

t("quoteLabel: known name, then Someone for a missing or blank name", () => {
  assert.equal(quoteLabel("b", (id) => (id === "b" ? "Bea" : "")), "Bea");
  assert.equal(quoteLabel("gone", () => ""), "Someone");
});

t("swipeDecision: waits, starts on a clear rightward move, drags once active", () => {
  assert.equal(swipeDecision({ active: false, dx: 5, dy: 0, pointerType: "touch", buttons: 1 }), "wait");
  assert.equal(swipeDecision({ active: false, dx: 20, dy: 0, pointerType: "touch", buttons: 1 }), "start");
  assert.equal(swipeDecision({ active: false, dx: 20, dy: 30, pointerType: "touch", buttons: 1 }), "wait"); // mostly vertical: a scroll
  assert.equal(swipeDecision({ active: false, dx: -30, dy: 0, pointerType: "touch", buttons: 1 }), "wait");
  assert.equal(swipeDecision({ active: true, dx: 70, dy: 40, pointerType: "mouse", buttons: 1 }), "drag");
});
t("swipeDecision: a stale mouse drag (button no longer held) is cancelled, never started or continued", () => {
  assert.equal(swipeDecision({ active: false, dx: 40, dy: 0, pointerType: "mouse", buttons: 0 }), "cancel");
  assert.equal(swipeDecision({ active: true, dx: 40, dy: 0, pointerType: "mouse", buttons: 0 }), "cancel");
});
t("quoteView: hidden author collapses to Someone with no text", () => {
  const nameOf = (id: string) => (id === "b" ? "Bea" : "");
  assert.deepEqual(quoteView({ userId: "b", text: "secret" }, new Set(["b"]), nameOf), { name: "Someone", text: "" });
  assert.deepEqual(quoteView({ userId: "b", text: "hello" }, new Set(["x"]), nameOf), { name: "Bea", text: "hello" });
  assert.deepEqual(quoteView({ userId: "b", text: "hello" }, undefined, nameOf), { name: "Bea", text: "hello" });
});
t("resolveChatReply refuses a banned author", () => {
  const recent = [{ userId: "b", text: "earlier" }];
  assert.equal(resolveChatReply(recent, { userId: "b", text: "earlier" }, (id) => id === "b"), null);
  assert.ok(resolveChatReply(recent, { userId: "b", text: "earlier" }, () => false));
});
t("hub purgeChat removes only that user's lines; ban flag is per room", () => {
  const hub = new RoomHub();
  hub.recordChat("r", { userId: "a", text: "1", at: 1 }); hub.recordChat("r", { userId: "b", text: "2", at: 2 });
  hub.purgeChat("r", "a");
  assert.deepEqual(hub.recentChat("r").map((l) => l.userId), ["b"]);
  hub.setChatBanned("r", "a", true);
  assert.equal(hub.isChatBanned("r", "a"), true); assert.equal(hub.isChatBanned("r2", "a"), false);
  hub.setChatBanned("r", "a", false); assert.equal(hub.isChatBanned("r", "a"), false);
});

t("reducer stores replyTo on the ChatItem", () => {
  const s = roomReducer(initialRoomState("me"), { type: "room:chat", userId: "a", text: "hi", at: 1, replyTo: { userId: "b", text: "earlier" } } as any);
  assert.deepEqual(s.chat[0].replyTo, { userId: "b", text: "earlier" });
});
t("reducer leaves replyTo undefined without one, and ignores a malformed one", () => {
  const a = roomReducer(initialRoomState("me"), { type: "room:chat", userId: "a", text: "hi", at: 1 });
  assert.equal(a.chat[0].replyTo, undefined);
  const b = roomReducer(initialRoomState("me"), { type: "room:chat", userId: "a", text: "hi", at: 1, replyTo: { userId: 5, text: "x" } } as any);
  assert.equal(b.chat[0].replyTo, undefined);
});

t("hub ring buffer keeps replyTo", () => {
  const hub = new RoomHub();
  hub.recordChat("r", { userId: "a", text: "hi", at: 1, replyTo: { userId: "b", text: "earlier" } });
  assert.deepEqual(hub.recentChat("r")[0].replyTo, { userId: "b", text: "earlier" });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
