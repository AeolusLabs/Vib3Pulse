// Rooms unit checks for the gamers-live client state (no database):   npx tsx scripts/test-rooms-unit-game-client.ts
import assert from "node:assert/strict";
import { initialRoomState, roomReducer, type RoomState } from "../client/src/lib/roomReducer";
import { countdownMs, featuredFor, formatCountdown, gameNoticeText, gameRefusalText, membersOf, playerIdOf, statusOf, statusText } from "../client/src/lib/gameScreen";
import type { GameView } from "../shared/gameScreen";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const view = (over: Partial<GameView> = {}): GameView => ({
  format: 2, teams: { A: ["a1", "a2"], B: ["b1"] }, featured: { A: "a1", B: "b1" }, asks: [], score: [0, 0], away: {}, ...over,
});
const stateMsg = (game?: GameView) => ({
  type: "room:state" as const, room: { id: "r1" }, members: [], memberCount: 0, screen: null, you: { role: "host" as const, muted: false },
  ...(game ? { game } : {}),
});
const live = (game?: GameView): RoomState => roomReducer(initialRoomState("u"), stateMsg(game));

// ---------------------------------------------------------------- reducer
test("reducer: no game key in room:state means game is null", () => {
  assert.equal(live().game, null);
});
test("reducer: a game that appears mid-session is kept (the host turned it on)", () => {
  const s = roomReducer(live(), { type: "room:game", game: view() });
  assert.deepEqual(s.game?.teams.A, ["a1", "a2"]);
});
test("reducer: room:game with null clears the game (the room stopped being a game room)", () => {
  assert.equal(roomReducer(live(view()), { type: "room:game", game: null }).game, null);
});
test("reducer: room:game null with no game changes nothing", () => {
  const s = live();
  assert.equal(roomReducer(s, { type: "room:game", game: null }), s);
});
test("reducer: room:state with a game keeps it; room:game replaces it", () => {
  const s = live(view());
  assert.deepEqual(s.game?.teams.A, ["a1", "a2"]);
  const next = roomReducer(s, { type: "room:game", game: view({ score: [2, 1] }) });
  assert.deepEqual(next.game?.score, [2, 1]);
});
test("reducer: a malformed room:game is dropped", () => {
  const s = live(view());
  assert.equal(roomReducer(s, { type: "room:game", game: { format: 2 } as any }), s);
});
test("reducer: a malformed game in room:state is not kept", () => {
  assert.equal(live({ format: 2 } as any).game, null);
});
test("reducer: the game_drop system line keeps its kind and has no reply", () => {
  const s = roomReducer(live(view()), { type: "room:chat", userId: "a2", text: "Sam has dropped out", at: 1, system: "game_drop" });
  assert.equal(s.chat[0].system, "game_drop");
  assert.equal(s.chat[0].replyTo, undefined);
});
test("reducer: a fresh connect clears the game", () => {
  assert.equal(roomReducer(live(view()), { type: "client:connecting" }).game, null);
});

// ---------------------------------------------------------------- featuredFor
test("featuredFor: the host pick when nobody follows", () => {
  assert.equal(featuredFor(view(), "A", {}), "a1");
});
test("featuredFor: the viewer's follow beats the host pick", () => {
  assert.equal(featuredFor(view(), "A", { A: "a2" }), "a2");
});
test("featuredFor: falls back to the first member when the followed player left", () => {
  const g = view({ teams: { A: ["a1"], B: ["b1"] }, featured: { A: null, B: "b1" } });
  assert.equal(featuredFor(g, "A", { A: "a2" }), "a1");
});
test("featuredFor: the host pick returns when the follow is gone", () => {
  const g = view({ teams: { A: ["a1", "a3"], B: [] }, featured: { A: "a3", B: null } });
  assert.equal(featuredFor(g, "A", { A: "a2" }), "a3");
  assert.equal(featuredFor(g, "B", {}), null);
});
test("membersOf reads the team", () => assert.deepEqual(membersOf(view(), "B"), ["b1"]));

// ---------------------------------------------------------------- status and countdown
test("statusOf: live, reconnecting (key present), out (not on a team)", () => {
  const g = view({ away: { a2: 30_000 } });
  assert.equal(statusOf(g, "a1", 0), "live");
  assert.equal(statusOf(g, "a2", 0), "reconnecting");
  assert.equal(statusOf(g, "zz", 0), "out");
});
test("countdownMs: ms left, never negative, null when present", () => {
  const g = view({ away: { a2: 30_000 } });
  assert.equal(countdownMs(g, "a2", 6_000), 24_000);
  assert.equal(countdownMs(g, "a2", 99_000), 0);
  assert.equal(countdownMs(g, "a1", 0), null);
});
test("countdownMs: null for a hold-slot room (value null)", () => {
  assert.equal(countdownMs(view({ away: { a2: null } }), "a2", 5), null);
});
test("statusText: the three wordings", () => {
  const g = view({ away: { a2: 30_000, b1: null } });
  assert.equal(statusText(g, "a2", 6_000), "Reconnecting… 0:24");
  assert.equal(statusText(g, "b1", 6_000), "Reconnecting…");
  assert.equal(statusText(g, "zz", 0), "Dropped out");
  assert.equal(statusText(g, "a1", 0), null);
});
test("formatCountdown: m:ss, rounds up", () => {
  assert.equal(formatCountdown(120_000), "2:00");
  assert.equal(formatCountdown(24_001), "0:25");
  assert.equal(formatCountdown(0), "0:00");
});
test("gameNoticeText: every wire code has a message, unknown has none", () => {
  for (const c of ["GAME_OFF", "FEATURE_OFF", "NOT_ALLOWED", "TEEN_RULE", "NOT_PRESENT", "TEAM_FULL", "NO_CHANGE", "BAD_VALUE", "BAD_REQUEST", "NOT_IN_ROOM", "RATE_LIMITED"]) assert.ok(gameNoticeText(c), c);
  assert.equal(gameNoticeText("SERVER_ERROR"), null);
});

// ---------------------------------------------------------------- OBS identity and refusal wording
test("playerIdOf: strips the #obs ingest suffix and leaves other ids alone", () => {
  assert.equal(playerIdOf("u1#obs"), "u1");
  assert.equal(playerIdOf("u1"), "u1");
  assert.equal(playerIdOf("u#obs#obs"), "u#obs");
});
test("refusals: every server reason and code has a short plain line", () => {
  for (const reason of ["needs_live_video", "needs_game", "lanes", "teen_host_required", "minors_parent"]) assert.ok(gameRefusalText({ reason }), reason);
  for (const code of ["LANE_EXISTS", "TEAM_FULL", "GAME_IN_PROGRESS", "LANE_ROOM"]) assert.ok(gameRefusalText({ code }), code);
  assert.ok(gameRefusalText({ reason: "invalid", field: "gameFormat" }));
});
test("refusals: a bare 'invalid' on another field is not ours, and no line mentions age", () => {
  assert.equal(gameRefusalText({ reason: "invalid", field: "title" }), null);
  for (const r of ["teen_host_required", "minors_parent", "lanes"]) assert.ok(!/(age|adult|teen|minor|old|young|1[3-8])/i.test(gameRefusalText({ reason: r }) ?? ""), r);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
