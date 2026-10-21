// Rooms gaming rules (pure, no database):   npx tsx scripts/test-rooms-unit-game.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import {
  applyGame, canPlayGame, dropFromGame, emptyGame, newGame, splitShares, DROP_TIMEOUTS_MS,
  type GameContext, type GameState,
} from "../shared/gameScreen";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const HOST = "host", G1 = "g1", G2 = "g2", G3 = "g3";
const ctx = (over: Partial<GameContext>): GameContext => ({
  actorId: HOST, actorRole: "host", targetId: G1, targetPresent: true, targetEligible: true, gameOn: true, ...over,
});
const ok = (r: ReturnType<typeof applyGame>): GameState => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as any).state; };
const code = (r: ReturnType<typeof applyGame>) => (r.ok ? "OK" : r.code);

// ---------------------------------------------------------------- applyGame
test("ask with the game off -> GAME_OFF", () => {
  assert.equal(code(applyGame(emptyGame, "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G1, gameOn: false, side: "A" }))), "GAME_OFF");
});
test("ask while not eligible -> TEEN_RULE", () => {
  assert.equal(code(applyGame(emptyGame, "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G1, targetEligible: false, side: "A" }))), "TEEN_RULE");
});
test("ask for someone else -> NOT_ALLOWED; ask without a side -> BAD_VALUE", () => {
  assert.equal(code(applyGame(emptyGame, "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G2, side: "A" }))), "NOT_ALLOWED");
  assert.equal(code(applyGame(emptyGame, "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G1 }))), "BAD_VALUE");
});
test("ask records the side; asking again for the same side -> NO_CHANGE; withdraw clears it", () => {
  const s = ok(applyGame(emptyGame, "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G1, side: "B" })));
  assert.deepEqual(s.asks, [{ userId: G1, side: "B" }]);
  assert.equal(code(applyGame(s, "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G1, side: "B" }))), "NO_CHANGE");
  const w = ok(applyGame(s, "withdraw", ctx({ actorId: G1, actorRole: "guest", targetId: G1 })));
  assert.deepEqual(w.asks, []);
  assert.deepEqual(emptyGame.asks, [], "never mutates its input");
});
test("accept by a guest -> NOT_ALLOWED", () => {
  assert.equal(code(applyGame(emptyGame, "accept", ctx({ actorId: G2, actorRole: "guest", targetId: G1, side: "A" }))), "NOT_ALLOWED");
});
test("accept into a full team -> TEAM_FULL", () => {
  let s = newGame(1);
  s = ok(applyGame(s, "accept", ctx({ targetId: G1, side: "A" })));
  assert.equal(code(applyGame(s, "accept", ctx({ targetId: G2, side: "A" }))), "TEAM_FULL");
  let f = newGame(4);
  for (const id of ["a1", "a2", "a3", "a4"]) f = ok(applyGame(f, "accept", ctx({ targetId: id, side: "A" })));
  assert.equal(code(applyGame(f, "accept", ctx({ targetId: "a5", side: "A" }))), "TEAM_FULL");
});
test("accept puts the player in the team and removes their ask; the first player of a side is featured", () => {
  let s = ok(applyGame(newGame(2), "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G1, side: "B" })));
  s = ok(applyGame(s, "accept", ctx({ targetId: G1 }))); // side comes from the ask
  assert.deepEqual(s.teams, { A: [], B: [G1] });
  assert.deepEqual(s.asks, []);
  assert.equal(s.featured.B, G1);
  s = ok(applyGame(s, "accept", ctx({ targetId: G2, side: "B" })));
  assert.equal(s.featured.B, G1, "the second player does not take the featured spot");
});
test("accept of someone absent -> NOT_PRESENT; ineligible -> TEEN_RULE; no ask and no side -> BAD_VALUE", () => {
  assert.equal(code(applyGame(newGame(2), "accept", ctx({ targetPresent: false, side: "A" }))), "NOT_PRESENT");
  assert.equal(code(applyGame(newGame(2), "accept", ctx({ targetEligible: false, side: "A" }))), "TEEN_RULE");
  assert.equal(code(applyGame(newGame(2), "accept", ctx({}))), "BAD_VALUE");
});
test("accept to the other side moves the player (never two slots)", () => {
  let s = ok(applyGame(newGame(2), "accept", ctx({ targetId: G1, side: "A" })));
  s = ok(applyGame(s, "accept", ctx({ targetId: G1, side: "B" })));
  assert.deepEqual(s.teams, { A: [], B: [G1] });
  assert.deepEqual(s.featured, { A: null, B: G1 });
  assert.equal(code(applyGame(s, "accept", ctx({ targetId: G1, side: "B" }))), "NO_CHANGE");
});
test("feature of a non-member -> NOT_PRESENT; feature of a member moves the pick", () => {
  let s = ok(applyGame(newGame(2), "accept", ctx({ targetId: G1, side: "A" })));
  s = ok(applyGame(s, "accept", ctx({ targetId: G2, side: "A" })));
  assert.equal(code(applyGame(s, "feature", ctx({ targetId: G3 }))), "NOT_PRESENT");
  s = ok(applyGame(s, "feature", ctx({ targetId: G2 })));
  assert.equal(s.featured.A, G2);
});
test("remove of the featured player moves featured to the next member, or null", () => {
  let s = ok(applyGame(newGame(2), "accept", ctx({ targetId: G1, side: "A" })));
  s = ok(applyGame(s, "accept", ctx({ targetId: G2, side: "A" })));
  s = ok(applyGame(s, "remove", ctx({ targetId: G1 })));
  assert.deepEqual(s.teams.A, [G2]);
  assert.equal(s.featured.A, G2);
  s = ok(applyGame(s, "remove", ctx({ targetId: G2 })));
  assert.equal(s.featured.A, null);
});
test("remove: a guest cannot remove someone else, but may remove themselves (also with the game off)", () => {
  const s = ok(applyGame(newGame(2), "accept", ctx({ targetId: G1, side: "A" })));
  assert.equal(code(applyGame(s, "remove", ctx({ actorId: G2, actorRole: "guest", targetId: G1 }))), "NOT_ALLOWED");
  const self = ok(applyGame(s, "remove", ctx({ actorId: G1, actorRole: "guest", targetId: G1, gameOn: false })));
  assert.deepEqual(self.teams.A, []);
  assert.equal(code(applyGame(self, "remove", ctx({ actorId: G1, actorRole: "guest", targetId: G1 }))), "NO_CHANGE");
});
test("score below 0 or not a whole number -> BAD_VALUE; a valid score sets that side", () => {
  for (const value of [-1, 1.5, NaN, 1000]) assert.equal(code(applyGame(newGame(1), "score", ctx({ side: "A", value }))), "BAD_VALUE", String(value));
  assert.equal(code(applyGame(newGame(1), "score", ctx({ value: 1 }))), "BAD_VALUE", "no side");
  const s = ok(applyGame(newGame(1), "score", ctx({ side: "B", value: 3 })));
  assert.deepEqual(s.score, [0, 3]);
  assert.equal(code(applyGame(s, "score", ctx({ side: "B", value: 3 }))), "NO_CHANGE");
  assert.equal(code(applyGame(s, "score", ctx({ actorId: G1, actorRole: "guest", side: "B", value: 4 }))), "NOT_ALLOWED");
});
test("format smaller than a team's current size -> TEAM_FULL; out of range -> BAD_VALUE", () => {
  let s = newGame(3);
  for (const id of [G1, G2, G3]) s = ok(applyGame(s, "accept", ctx({ targetId: id, side: "A" })));
  assert.equal(code(applyGame(s, "format", ctx({ value: 2 }))), "TEAM_FULL");
  assert.equal(code(applyGame(s, "format", ctx({ value: 5 }))), "BAD_VALUE");
  assert.equal(code(applyGame(s, "format", ctx({ value: 0 }))), "BAD_VALUE");
  assert.equal(ok(applyGame(s, "format", ctx({ value: 4 }))).format, 4);
});
test("host actions with the game off -> GAME_OFF (accept, feature, score, format)", () => {
  for (const a of ["accept", "feature", "score", "format"] as const) {
    assert.equal(code(applyGame(newGame(2), a, ctx({ gameOn: false, side: "A", value: 1 }))), "GAME_OFF", a);
  }
});
test("decline clears an ask; a guest cannot decline", () => {
  const s = ok(applyGame(newGame(2), "ask", ctx({ actorId: G1, actorRole: "guest", targetId: G1, side: "A" })));
  assert.equal(code(applyGame(s, "decline", ctx({ actorId: G2, actorRole: "guest", targetId: G1 }))), "NOT_ALLOWED");
  assert.deepEqual(ok(applyGame(s, "decline", ctx({ targetId: G1 }))).asks, []);
});
test("an unknown action -> BAD_VALUE", () => {
  assert.equal(code(applyGame(newGame(2), "nonsense" as any, ctx({}))), "BAD_VALUE");
});

// ---------------------------------------------------------------- dropFromGame
test("dropFromGame clears membership, ask and featured", () => {
  let s = ok(applyGame(newGame(2), "accept", ctx({ targetId: G1, side: "A" })));
  s = ok(applyGame(s, "ask", ctx({ actorId: G2, actorRole: "guest", targetId: G2, side: "B" })));
  const d = dropFromGame(dropFromGame(s, G1), G2);
  assert.deepEqual(d.teams, { A: [], B: [] });
  assert.deepEqual(d.asks, []);
  assert.deepEqual(d.featured, { A: null, B: null });
  assert.deepEqual(s.teams.A, [G1], "input untouched");
});

// ---------------------------------------------------------------- splitShares
test("splitShares(1000, [a,b,c], b) -> {a:333,b:334,c:333}, sums to the amount", () => {
  const out = splitShares(1000, ["a", "b", "c"], "b");
  assert.deepEqual(out, { a: 333, b: 334, c: 333 });
  assert.equal(Object.values(out).reduce((x, y) => x + y, 0), 1000);
});
test("splitShares: remainder to the first id when featured is null or not a member; empty list -> {}", () => {
  assert.deepEqual(splitShares(1001, ["a", "b"], null), { a: 501, b: 500 });
  assert.deepEqual(splitShares(1001, ["a", "b"], "z"), { a: 501, b: 500 });
  assert.deepEqual(splitShares(1000, [], "a"), {});
});
test("splitShares: always sums to the amount to the kobo", () => {
  for (const amt of [0, 1, 7, 99_999, 150_000, 1_234_567]) for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const out = splitShares(amt, ids, ids[n - 1]);
    assert.equal(Object.values(out).reduce((x, y) => x + y, 0), amt, `${amt}/${n}`);
  }
});
test("splitShares: not whole kobo throws", () => {
  assert.throws(() => splitShares(10.5, ["a"], null));
  assert.throws(() => splitShares(-1, ["a"], null));
});

// ---------------------------------------------------------------- canPlayGame
const teen = { age: 15 }, adult = { age: 30 }, unknown = { age: null };
const ACKED = { invited: true, acknowledged: true };
test("canPlayGame: unknown age never plays", () => {
  assert.equal(canPlayGame(unknown, { bands: [] }, { minorsRoom: false }).ok, false);
  assert.equal(canPlayGame(unknown, { bands: [] }, { minorsRoom: true }, ACKED).ok, false);
});
test("canPlayGame: normal room: adults always; a teen only among teens", () => {
  assert.equal(canPlayGame(adult, { bands: ["teen", "adult"] }, { minorsRoom: false }).ok, true);
  assert.equal(canPlayGame(teen, { bands: ["teen", "teen"] }, { minorsRoom: false }).ok, true);
  assert.deepEqual(canPlayGame(teen, { bands: ["teen", "adult"] }, { minorsRoom: false }), { ok: false, code: "ADULT_PRESENT" });
});
test("canPlayGame: teen lane / minors' room: teens always (adults present or not); adults only with an acknowledged invite", () => {
  assert.equal(canPlayGame(teen, { bands: ["teen", "adult"] }, { minorsRoom: true, ageLane: "teen" }).ok, true);
  assert.equal(canPlayGame(adult, { bands: ["teen", "adult"] }, { minorsRoom: true, ageLane: "teen" }, ACKED).ok, true);
  assert.deepEqual(canPlayGame(adult, { bands: ["teen"] }, { minorsRoom: true }, { invited: true, acknowledged: false }), { ok: false, code: "NOT_INVITED" });
  assert.deepEqual(canPlayGame(adult, { bands: ["teen"] }, { minorsRoom: true }), { ok: false, code: "NOT_INVITED" });
  assert.deepEqual(canPlayGame(adult, { bands: ["teen"] }, { minorsRoom: false, ageLane: "teen" }), { ok: false, code: "NOT_INVITED" }, "a teen lane is treated as a minors' room even if the flag were missing");
});
test("canPlayGame: adult lane: adults only", () => {
  assert.equal(canPlayGame(adult, { bands: ["adult"] }, { minorsRoom: false, ageLane: "adult" }).ok, true);
  assert.deepEqual(canPlayGame(teen, { bands: ["teen"] }, { minorsRoom: false, ageLane: "adult" }), { ok: false, code: "WRONG_LANE" });
});

test("DROP_TIMEOUTS_MS is exactly 30 s, 120 s and hold (0)", () => {
  assert.deepEqual([...DROP_TIMEOUTS_MS], [30_000, 120_000, 0]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
