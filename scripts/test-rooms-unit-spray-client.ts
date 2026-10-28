// Spraying on the client (tasks 5.7 and 5.9), pure helpers and source checks (no database, no browser):
//   npx tsx scripts/test-rooms-unit-spray-client.ts
// Written, not run (owner's no-testing rule for phase 5). Runs under npm run test:rooms with the other unit suites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPRAY_TIERS } from "../shared/money";
import { idempotencyKeyShape, sprayPrice } from "../shared/spray";
import { SPRAY_CAP, initialRoomState, roomReducer, type RoomState } from "../client/src/lib/roomReducer";
import {
  IDLE, MOCK_CHECKOUT_HOST, RAIN_FX, SAME_KEY_REASONS, SPRAY_COPY, SPRAY_FAIL_COPY, SPRAY_SCREEN_FX, SPRAY_TRACK_KEY, allSprayCopy, animateSprays,
  cardLabel, chargeLine, counterAt, decodeSprayTrack, defaultTarget, encodeSprayTrack, holdsSprayBlock, inFlight, isDevBuild,
  needsSlide, newIdempotencyKey, newSprays, outcomeOfPost, outcomeOfStatus, parseRetryAfter,
  parseSprayBlock, parseSprayMe, rainBannerText, reasonOfRefusal, safeAuthorizationUrl, searchWithoutSpray, sprayFlow, sprayReturnId,
  sprayTargets, sprayTeamReturnId, systemChatText, thankYouText, tileAction, waitDeadlineMs, type SprayBlock, type SprayFlow, type SprayMe,
} from "../client/src/lib/sprayUi";
import { splitLine, teamSprayTiers } from "../client/src/lib/gameScreen";
import { FIXTURE_SPRAY_KEY, fixtureSprayChatText, fixtureSprayStart, parseSprayFixture } from "../client/src/lib/sprayFixtures";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Source without block comments and whole-line or trailing `//` comments (a `//` inside a URL string is kept). */
const stripComments = (s: string) => s.replace(/\/\*[^]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

const ORIGIN = "https://vib3pulse.example";
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-9222-222222222222";
const ROOM18 = { ageLimit: "18+", minorsRoom: false, status: "live" };
const BLOCK: SprayBlock = { enabled: true, targets: ["host", "stage1"] };
const ME: SprayMe = { method: { last4: "4242", brand: "visa" }, verified: true };

function liveState(roomId = "r1"): RoomState {
  let s = roomReducer(initialRoomState("me"), { type: "client:connecting" });
  s = roomReducer(s, { type: "room:state", room: { id: roomId }, members: [], memberCount: 0, screen: null, you: { role: "guest", muted: false } });
  return s;
}
const ev = (id: string, extra: Record<string, unknown> = {}) => ({ type: "room:spray", id, tier: "bundle", v3c: 100000, fromId: "a", toId: "host", at: 1000, ...extra }) as any;

// ---------------------------------------------------------------- reducer (task 5.7)
test("reducer: room:spray is appended, newest last", () => {
  let s = liveState();
  s = roomReducer(s, ev("s1"));
  s = roomReducer(s, ev("s2", { tier: "rain", v3c: 10_000_000 }));
  assert.deepEqual(s.sprays.map((x) => x.id), ["s1", "s2"]);
  assert.equal(s.sprays[1].tier, "rain");
});
test("reducer: sprays are a ring of SPRAY_CAP (20), oldest dropped", () => {
  assert.equal(SPRAY_CAP, 20);
  let s = liveState();
  for (let i = 0; i < 25; i++) s = roomReducer(s, ev(`s${i}`));
  assert.equal(s.sprays.length, 20);
  assert.equal(s.sprays[0].id, "s5");
  assert.equal(s.sprays[19].id, "s24");
});
test("reducer: a room:spray never makes a chat line (the receipt is the server's own room:chat)", () => {
  let s = liveState();
  const before = s.chat.length;
  s = roomReducer(s, ev("s1"));
  assert.equal(s.chat.length, before);
  s = roomReducer(s, { type: "room:chat", userId: "system", text: "Ade sprayed Mara a bundle", at: 2000 });
  assert.equal(s.chat.length, before + 1);
  assert.equal(s.sprays.length, 1);
});
test("reducer: the same spray id twice is kept once (never plays twice)", () => {
  let s = liveState();
  s = roomReducer(s, ev("s1"));
  s = roomReducer(s, ev("s1"));
  assert.equal(s.sprays.length, 1);
});
test("reducer: malformed spray events are dropped", () => {
  const s0 = liveState();
  for (const bad of [ev("x", { tier: "n20" }), ev("x", { tier: "__proto__" }), ev("x", { v3c: 1.5 }), ev("x", { v3c: -1 }), ev("x", { v3c: "100000" }), ev("", {}), ev("x", { fromId: "" }), ev("x", { toId: 7 })]) {
    assert.equal(roomReducer(s0, bad).sprays.length, 0);
  }
});
test("reducer: only the broadcast fields are kept (no amount, card or reference sneaks in)", () => {
  const s = roomReducer(liveState(), ev("s1", { reference: "vib3rs_x", amountKobo: 100000, card: "4242" }));
  assert.deepEqual(Object.keys(s.sprays[0]).sort(), ["at", "fromId", "id", "tier", "toId", "v3c"]);
});
test("reducer: same room keeps sprays across room:state, another room clears them; ended rooms ignore sprays", () => {
  let s = roomReducer(liveState("r1"), ev("s1"));
  s = roomReducer(s, { type: "room:state", room: { id: "r1" }, members: [], memberCount: 0, screen: null, you: { role: "guest", muted: false } });
  assert.equal(s.sprays.length, 1);
  s = roomReducer(s, { type: "room:state", room: { id: "r2" }, members: [], memberCount: 0, screen: null, you: { role: "guest", muted: false } });
  assert.equal(s.sprays.length, 0);
  s = roomReducer(s, { type: "room:ended" });
  assert.equal(roomReducer(s, ev("s9")).sprays.length, 0);
});

// ---------------------------------------------------------------- the spray block
test("parseSprayBlock: absent, not enabled, or malformed is null", () => {
  assert.equal(parseSprayBlock(undefined, ROOM18), null);
  assert.equal(parseSprayBlock({ ...BLOCK, enabled: false }, ROOM18), null);
  assert.equal(parseSprayBlock({ ...BLOCK, targets: "host" }, ROOM18), null);
});
test("parseSprayBlock: never in a 13+/16+ room, a minors' room, a room not live, or for a listen-only viewer", () => {
  assert.equal(parseSprayBlock(BLOCK, { ...ROOM18, ageLimit: "13+" }), null);
  assert.equal(parseSprayBlock(BLOCK, { ...ROOM18, ageLimit: "16+" }), null);
  assert.equal(parseSprayBlock(BLOCK, { ...ROOM18, minorsRoom: true }), null);
  assert.equal(parseSprayBlock(BLOCK, { ...ROOM18, status: "scheduled" }), null);
  assert.equal(parseSprayBlock(BLOCK, { ...ROOM18, status: "ended" }), null);
  assert.equal(parseSprayBlock(BLOCK, ROOM18, { listenOnly: true }), null);
  assert.equal(parseSprayBlock(BLOCK, null), null);
});
test("parseSprayBlock: a good block in an 18+ or 21+ live room is kept, targets cleaned", () => {
  const b = parseSprayBlock({ ...BLOCK, targets: ["host", "host", "", 5, "stage1"] }, ROOM18)!;
  assert.deepEqual(b.targets, ["host", "stage1"]);
  assert.ok(parseSprayBlock(BLOCK, { ...ROOM18, ageLimit: "21+" }));
});
test("sprayTargets: never yourself, only people still here and still host or on stage", () => {
  const t = sprayTargets({ ...BLOCK, targets: ["host", "stage1", "me", "left", "floor"] }, { hostId: "host", stage: ["stage1", "me", "left"], memberIds: ["host", "stage1", "me", "floor"], selfId: "me" });
  assert.deepEqual(t, ["host", "stage1"]);
  assert.deepEqual(sprayTargets(null, { hostId: "host", stage: [], memberIds: ["host"], selfId: "me" }), []);
  assert.equal(defaultTarget(["stage1", "host"], "host"), "host");
  assert.equal(defaultTarget(["stage1"], "host"), "stage1");
  assert.equal(defaultTarget([], "host"), null);
});

// ---------------------------------------------------------------- the payer's settings
test("parseSprayMe: only last4 and brand of the card are ever kept", () => {
  const me = parseSprayMe({ method: { last4: "4242", brand: "visa", authorizationCode: "AUTH_secret", signature: "SIG" }, verified: true })!;
  assert.deepEqual(Object.keys(me.method!).sort(), ["brand", "last4"]);
  assert.equal(JSON.stringify(me).includes("AUTH_secret"), false);
  assert.equal(parseSprayMe({ method: { last4: "42a2", brand: "visa" }, verified: false })!.method, null);
  assert.equal(parseSprayMe({ method: null, verified: "yes" }), null);
  assert.equal(cardLabel({ last4: "4242", brand: "visa" }), "Visa ending 4242");
  assert.equal(cardLabel({ last4: "0001", brand: "weird" }), "Card ending 0001");
});

// ---------------------------------------------------------------- tray rules
test("tileAction: offline and loading are disabled with a reason", () => {
  assert.equal(tileAction("note", BLOCK, ME, false).kind, "blocked");
  assert.equal(tileAction("note", BLOCK, null, true).kind, "blocked");
});
test("tileAction: there is no spending limit, any tier pays however much was sprayed", () => {
  for (const t of ["note", "bundle", "bag", "rain"] as const) assert.equal(tileAction(t, BLOCK, ME, true).kind, "pay");
});
test("needsSlide: note taps, bundle/bag/rain slide; bag and rain say the bank will ask", () => {
  assert.equal(needsSlide("note"), false);
  for (const t of ["bundle", "bag", "rain"] as const) assert.equal(needsSlide(t), true);
  assert.match(chargeLine("bag", ME.method), /bank will ask/);
  assert.doesNotMatch(chargeLine("note", ME.method), /bank will ask/);
});

// ---------------------------------------------------------------- the state machine
const confirm = (key = K1): SprayFlow => sprayFlow(IDLE, { type: "start", tier: "bundle", targetId: "host", key });
test("machine: start makes an intent with the key; a bad key or tier is refused", () => {
  const s = confirm();
  assert.equal(s.kind, "confirming");
  assert.equal(s.kind === "confirming" && s.intent.key, K1);
  // K1 is all digits, so its upper case is itself; an uppercase key needs hex letters to be a real test
  const lettered = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  assert.equal(sprayFlow(IDLE, { type: "start", tier: "bundle", targetId: "host", key: lettered }).kind, "confirming");
  assert.equal(sprayFlow(IDLE, { type: "start", tier: "bundle", targetId: "host", key: lettered.toUpperCase() }).kind, "idle");
  assert.equal(sprayFlow(IDLE, { type: "start", tier: "bundle", targetId: "host", key: "not-a-key" }).kind, "idle");
  assert.equal(sprayFlow(IDLE, { type: "start", tier: "n20" as any, targetId: "host", key: K1 }).kind, "idle");
  assert.equal(sprayFlow(IDLE, { type: "start", tier: "note", targetId: "", key: K1 }).kind, "idle");
});
test("machine: double tap pays once (pay only from confirming; no new start while in flight)", () => {
  let s = sprayFlow(confirm(), { type: "pay", now: 1 });
  assert.equal(s.kind, "paying");
  const again = sprayFlow(s, { type: "pay", now: 2 });
  assert.equal(again, s);
  assert.equal(sprayFlow(s, { type: "start", tier: "rain", targetId: "host", key: K2 }), s);
  assert.equal(sprayFlow(s, { type: "close" }), s); // cannot drop a payment in flight
  assert.ok(inFlight(s));
});
test("machine: pending then the room:spray event delivers; another spray's event does not", () => {
  let s = sprayFlow(sprayFlow(confirm(), { type: "pay", now: 1 }), { type: "outcome", outcome: { kind: "pending", sprayId: "sp1" }, now: 2 });
  assert.equal(s.kind, "paying");
  assert.equal(sprayFlow(s, { type: "seen", sprayId: "other" }).kind, "paying");
  s = sprayFlow(s, { type: "seen", sprayId: "sp1" });
  assert.equal(s.kind, "delivered");
});
test("machine: an answer about a different spray is ignored", () => {
  const s = sprayFlow(sprayFlow(confirm(), { type: "pay", now: 1 }), { type: "outcome", outcome: { kind: "pending", sprayId: "sp1" }, now: 2 });
  assert.equal(sprayFlow(s, { type: "outcome", outcome: { kind: "delivered", sprayId: "sp2" }, now: 3 }), s);
});
test("machine: action_required (bank) then delivered from the poll", () => {
  let s = sprayFlow(sprayFlow(confirm(), { type: "pay", now: 1 }), { type: "outcome", outcome: { kind: "action_required", sprayId: "sp1", url: `${ORIGIN}/x` }, now: 5 });
  assert.equal(s.kind, "action_required");
  assert.equal(s.kind === "action_required" && s.since, 1); // the deadline counts from the Pay tap
  assert.equal(s.kind === "action_required" && s.intent.bankUrl, `${ORIGIN}/x`);
  s = sprayFlow(s, { type: "outcome", outcome: { kind: "wait" }, now: 9 });
  assert.equal(s.kind, "action_required");
  s = sprayFlow(s, { type: "outcome", outcome: { kind: "delivered", sprayId: "sp1" }, now: 10 });
  assert.equal(s.kind, "delivered");
});
test("machine: a declined payment is definitive: Try again is a NEW intent with a new key", () => {
  let s = sprayFlow(sprayFlow(confirm(), { type: "pay", now: 1 }), { type: "outcome", outcome: { kind: "failed", reason: "DECLINED", sprayId: null }, now: 2 });
  assert.equal(s.kind === "failed" && s.sameKey, false);
  s = sprayFlow(s, { type: "retry", key: K2 });
  assert.equal(s.kind === "confirming" && s.intent.key, K2);
});
test("machine: not sent, rate limited and the still-waiting deadlines retry with the SAME key", () => {
  for (const reason of ["NOT_SENT", "STILL_CHECKING", "STILL_WAITING", "RATE_LIMITED"] as const) {
    assert.ok(SAME_KEY_REASONS.has(reason), reason);
    let s = sprayFlow(sprayFlow(confirm(), { type: "pay", now: 1 }), { type: "outcome", outcome: { kind: "failed", reason, sprayId: null }, now: 2 });
    s = sprayFlow(s, { type: "retry", key: K2 });
    assert.equal(s.kind === "confirming" && s.intent.key, K1, reason);
  }
});
test("machine: saveCard is off by default and set only by the explicit choice", () => {
  let s = confirm();
  assert.equal(s.kind === "confirming" && s.intent.saveCard, false);
  s = sprayFlow(s, { type: "saveCard", on: true });
  assert.equal(s.kind === "confirming" && s.intent.saveCard, true);
  const paying = sprayFlow(s, { type: "pay", now: 1 });
  assert.equal(sprayFlow(paying, { type: "saveCard", on: false }), paying);
});

// ---------------------------------------------------------------- server answers
test("outcomeOfPost: refusals map to plain reasons, no oracle beyond the payer's own facts", () => {
  assert.equal(reasonOfRefusal(401), "SIGNED_OUT");
  assert.equal(reasonOfRefusal(402, "PAYMENT_DECLINED"), "DECLINED");
  assert.equal(reasonOfRefusal(403, "SPRAY_UNAVAILABLE"), "UNAVAILABLE");
  assert.equal(reasonOfRefusal(404), "UNAVAILABLE");
  assert.equal(reasonOfRefusal(409, "IDEMPOTENCY_MISMATCH"), "MISMATCH");
  assert.equal(reasonOfRefusal(429), "RATE_LIMITED");
  const o = outcomeOfPost({ ok: false, status: 429, code: "RATE_LIMITED", retryAfterSec: 30 }, ORIGIN);
  assert.equal(o.kind === "failed" && o.retryAfterSec, 30);
});
test("outcomeOfPost: 200 answers", () => {
  assert.deepEqual(outcomeOfPost({ ok: true, status: 200, body: { status: "delivered", sprayId: "sp1" } }, ORIGIN), { kind: "delivered", sprayId: "sp1" });
  assert.deepEqual(outcomeOfPost({ ok: true, status: 200, body: { status: "pending", sprayId: "sp1" } }, ORIGIN), { kind: "pending", sprayId: "sp1" });
  const ok = outcomeOfPost({ ok: true, status: 200, body: { status: "action_required", sprayId: "sp1", authorizationUrl: "https://checkout.paystack.com/abc" } }, ORIGIN);
  assert.equal(ok.kind, "action_required");
  const evil = outcomeOfPost({ ok: true, status: 200, body: { status: "action_required", sprayId: "sp1", authorizationUrl: "javascript:alert(1)" } }, ORIGIN);
  assert.equal(evil.kind === "failed" && evil.reason, "BAD_LINK");
  // A 200 we can't read may still mean the payment started: unknown (check again, same key), never "failed".
  assert.equal(outcomeOfPost({ ok: true, status: 200, body: { status: "delivered" } }, ORIGIN).kind, "unknown");
  // A failed row is final: NETWORK there means the checkout never started (not charged), never "your bank said no".
  const net = outcomeOfPost({ ok: true, status: 200, body: { status: "failed", sprayId: "sp1", reason: "NETWORK" } }, ORIGIN);
  assert.equal(net.kind === "failed" && net.reason, "NOT_STARTED");
  const dec = outcomeOfPost({ ok: true, status: 200, body: { status: "failed", sprayId: "sp1", reason: "DECLINED" } }, ORIGIN);
  assert.equal(dec.kind === "failed" && dec.reason, "DECLINED");
});
test("outcomeOfStatus: refunded only when reversed; a failed row is final; a failed poll never ends the wait", () => {
  const r = outcomeOfStatus({ ok: true, status: 200, body: { status: "reversed", reason: "RECIPIENT_LEFT" } }, "sp1");
  assert.equal(r.kind === "failed" && r.reason, "REVERSED", "a recipient who left no longer reverses; an old row reads as the plain reversed line");
  const net = outcomeOfStatus({ ok: true, status: 200, body: { status: "failed", reason: "NETWORK" } }, "sp1");
  assert.equal(net.kind === "failed" && net.reason, "NOT_STARTED");
  assert.equal(outcomeOfStatus({ ok: true, status: 200, body: { status: "pending" } }, "sp1").kind, "wait");
  assert.equal(outcomeOfStatus({ ok: false, status: 0 }, "sp1").kind, "wait");
  const nf = outcomeOfStatus({ ok: false, status: 404 }, "sp1");
  assert.equal(nf.kind === "failed" && nf.reason, "NOT_FOUND"); // not yours, or none: final (review M3)
  assert.equal(outcomeOfStatus({ ok: false, status: 503 }, "sp1").kind, "wait");
  const out = outcomeOfStatus({ ok: false, status: 401 }, "sp1");
  assert.equal(out.kind === "failed" && out.reason, "SIGNED_OUT");
  const unk = outcomeOfStatus({ ok: true, status: 200, body: { status: "reversed", reason: "<script>" } }, "sp1");
  assert.equal(unk.kind === "failed" && unk.reason, "REVERSED");
});
test("waits always end: a paid spray within delivery plus a sweep, a bank approval within 11 minutes", () => {
  assert.ok(waitDeadlineMs("paying") >= 60_000 && waitDeadlineMs("paying") <= 120_000);
  assert.ok(waitDeadlineMs("action_required") > 10 * 60_000 && waitDeadlineMs("action_required") <= 12 * 60_000);
});
test("safeAuthorizationUrl: production is https Paystack only; dev and test builds also allow our origin and the mock", () => {
  assert.equal(isDevBuild(), false); // outside Vite the build flag is off: production rules
  for (const dev of [false, true]) {
    assert.ok(safeAuthorizationUrl("https://checkout.paystack.com/x", ORIGIN, { dev }));
    assert.ok(safeAuthorizationUrl("https://standard.paystack.co/close", ORIGIN, { dev }));
    for (const bad of ["http://checkout.paystack.com/x", "https://paystack.com.evil.example/x", "https://user:pw@checkout.paystack.com/x", "javascript:alert(1)", "data:text/html,x", "https://evil.example/", `http://${MOCK_CHECKOUT_HOST}/x`, `https://${MOCK_CHECKOUT_HOST}.evil.example/x`, 5, ""]) {
      assert.equal(safeAuthorizationUrl(bad, ORIGIN, { dev }), null, `${String(bad)} dev=${dev}`);
    }
  }
  // Same origin and the mock checkout: never in production, only in dev and test builds.
  assert.equal(safeAuthorizationUrl("/dev/room-fixture?spray=tray", ORIGIN), null);
  assert.equal(safeAuthorizationUrl(`${ORIGIN}/anything`, ORIGIN, { dev: false }), null);
  assert.equal(safeAuthorizationUrl(`https://${MOCK_CHECKOUT_HOST}/pay/abc`, ORIGIN, { dev: false }), null);
  assert.ok(safeAuthorizationUrl("/dev/room-fixture?spray=tray", ORIGIN, { dev: true }));
  assert.ok(safeAuthorizationUrl(`https://${MOCK_CHECKOUT_HOST}/pay/abc`, ORIGIN, { dev: true }));
  // The POST answer uses the same rule: the mock link is a BAD_LINK in production, an approval in dev.
  const body = { status: "action_required", sprayId: "sp1", authorizationUrl: `https://${MOCK_CHECKOUT_HOST}/pay/abc` };
  const prod = outcomeOfPost({ ok: true, status: 200, body }, ORIGIN, { dev: false });
  assert.equal(prod.kind === "failed" && prod.reason, "BAD_LINK");
  assert.equal(outcomeOfPost({ ok: true, status: 200, body }, ORIGIN, { dev: true }).kind, "action_required");
});

// ---------------------------------------------------------------- keys, return address, effects
test("newIdempotencyKey: a lowercase UUID v4, from randomUUID or getRandomValues; no crypto fails closed", () => {
  assert.ok(idempotencyKeyShape(newIdempotencyKey({ randomUUID: () => K1.toUpperCase() })));
  const k = newIdempotencyKey({ getRandomValues: (a: Uint8Array) => { a.fill(0xab); return a; } });
  assert.ok(idempotencyKeyShape(k), k);
  assert.throws(() => newIdempotencyKey({}));
  assert.throws(() => newIdempotencyKey({ randomUUID: () => "not-a-uuid" }));
  assert.ok(idempotencyKeyShape(newIdempotencyKey()));
  assert.notEqual(newIdempotencyKey(), newIdempotencyKey());
});
test("sprayReturnId / searchWithoutSpray", () => {
  assert.equal(sprayReturnId("?spray=0b9c4d2e-1f3a-4b5c-8d6e-7f8091a2b3c4"), "0b9c4d2e-1f3a-4b5c-8d6e-7f8091a2b3c4");
  assert.equal(sprayReturnId("?spray=../../x"), null);
  assert.equal(sprayReturnId(""), null);
  assert.equal(searchWithoutSpray("?spray=abc&token=t"), "?token=t");
  assert.equal(searchWithoutSpray("?spray=abc"), "");
});
test("effects: quiet or reduced motion never animates; only new, recent sprays play", () => {
  assert.equal(animateSprays({ quiet: false, reducedMotion: false }), true);
  assert.equal(animateSprays({ quiet: true, reducedMotion: false }), false);
  assert.equal(animateSprays({ quiet: false, reducedMotion: true }), false);
  const list = [{ id: "a", at: 1000 }, { id: "b", at: 50_000 }, { id: "c", at: 59_000 }];
  assert.deepEqual(newSprays(list, new Set(["c"]), 60_000).map((x) => x.id), ["b"]);
});

// ---------------------------------------------------------------- fix round FC
const paying = (key = K1) => sprayFlow(confirm(key), { type: "pay", now: 1 });

test("I1: 402 keeps the server's reason; NETWORK is our side, never 'your bank said no'", () => {
  const o = (reason?: string) => outcomeOfPost({ ok: false, status: 402, code: "PAYMENT_DECLINED", sprayId: "sp1", ...(reason ? { reason } : {}) }, ORIGIN);
  const r = (reason?: string) => { const x = o(reason); return x.kind === "failed" ? x.reason : x.kind; };
  assert.equal(r("DECLINED"), "DECLINED");
  assert.equal(r("INSUFFICIENT_FUNDS"), "INSUFFICIENT_FUNDS");
  assert.equal(r("NOT_REUSABLE"), "NOT_REUSABLE");
  assert.equal(r("NETWORK"), "NOT_STARTED");
  assert.equal(r("TIMEOUT"), "EXPIRED");
  assert.equal(r(), "DECLINED");
  assert.equal(r("<script>"), "DECLINED");
  const x = o("DECLINED");
  assert.equal(x.kind === "failed" && x.sprayId, "sp1");
  assert.doesNotMatch(SPRAY_FAIL_COPY.NOT_STARTED.body, /bank/i);
  assert.match(SPRAY_FAIL_COPY.NOT_STARTED.body, /not charged/);
  // A 402 is definitive: Try again makes a new key (the old key's row is failed for good).
  let s = sprayFlow(paying(), { type: "outcome", outcome: o("NETWORK"), now: 2 });
  assert.equal(s.kind === "failed" && s.sameKey, false);
  s = sprayFlow(s, { type: "retry", key: K2 });
  assert.equal(s.kind === "confirming" && s.intent.key, K2);
});
test("I2: an unpaid approval that timed out says NOT charged; refunded only when the server says reversed", () => {
  const failed = outcomeOfStatus({ ok: true, status: 200, body: { status: "failed", reason: "TIMEOUT" } }, "sp1");
  assert.equal(failed.kind === "failed" && failed.reason, "EXPIRED");
  assert.equal(SPRAY_FAIL_COPY.EXPIRED.refunded, false);
  assert.match(SPRAY_FAIL_COPY.EXPIRED.body, /not charged/);
  assert.doesNotMatch(SPRAY_FAIL_COPY.EXPIRED.body + SPRAY_FAIL_COPY.EXPIRED.title, /refund/i);
  const reversed = outcomeOfStatus({ ok: true, status: 200, body: { status: "reversed", reason: "TIMEOUT" } }, "sp1");
  assert.equal(reversed.kind === "failed" && reversed.reason, "REVERSED");
  assert.equal(SPRAY_FAIL_COPY.REVERSED.refunded, true);
  // No failed-row reason can reach a "refunded" line.
  for (const reason of ["DECLINED", "INSUFFICIENT_FUNDS", "NOT_REUSABLE", "NETWORK", "RECIPIENT_LEFT", "ROOM_ENDED", "TIMEOUT", "DISPUTED", "x", undefined]) {
    for (const r of [outcomeOfStatus({ ok: true, status: 200, body: { status: "failed", reason } }, "sp1"), outcomeOfPost({ ok: true, status: 200, body: { status: "failed", sprayId: "sp1", reason } }, ORIGIN)]) {
      assert.ok(r.kind === "failed" && !SPRAY_FAIL_COPY[r.reason].refunded, String(reason));
    }
  }
  // Every "refunded" copy is reachable only from status "reversed".
  for (const [k, c] of Object.entries(SPRAY_FAIL_COPY)) if (c.refunded) assert.ok(["RECIPIENT_LEFT", "ROOM_ENDED", "TIMEOUT", "REVERSED"].includes(k), k);
});
test("I3: no answer is UNKNOWN: the flow keeps paying with the same key, says 'checking', never 'failed'", () => {
  for (const r of [{ ok: false as const, status: 0 }, { ok: false as const, status: 502 }, { ok: false as const, status: 408 }, { ok: true as const, status: 200, body: "garbled" }]) {
    assert.equal(outcomeOfPost(r, ORIGIN).kind, "unknown");
  }
  let s = sprayFlow(paying(), { type: "outcome", outcome: { kind: "unknown" }, now: 5 });
  assert.equal(s.kind === "paying" && s.unknown, true);
  assert.equal(s.kind === "paying" && s.intent.key, K1);
  assert.equal(s.kind === "paying" && s.since, 1);
  // A later answer to the same key settles it.
  s = sprayFlow(s, { type: "outcome", outcome: { kind: "pending", sprayId: "sp1" }, now: 6 });
  assert.equal(s.kind === "paying" && s.sprayId, "sp1");
  assert.equal(s.kind === "paying" && s.unknown, false);
  assert.match(SPRAY_COPY.checking, /Don't pay again/);
  assert.equal(SPRAY_FAIL_COPY.STILL_CHECKING.tone, "wait");
  assert.equal(SPRAY_FAIL_COPY.STILL_WAITING.tone, "wait");
  assert.doesNotMatch(SPRAY_FAIL_COPY.NOT_SENT.body, /refund/i);
});
test("I4: every request has a time limit, and one deadline counts from the Pay tap", () => {
  const api = src("../client/src/lib/sprayApi.ts");
  assert.match(api, /new AbortController\(\)/);
  assert.match(api, /ctl\.abort\(\)/);
  const hook = src("../client/src/components/rooms/spray/useSpray.ts");
  assert.match(hook, /const left = since \+ waitDeadlineMs\(flightKind\) - Date\.now\(\);/);
  // The paying deadline applies with or without a spray id (no `sprayId &&` gate on it).
  assert.doesNotMatch(hook, /if \(!waitingKind \|\| !sprayId\) return;/);
});
test("I5/M1: the mock checkout is allowed in dev builds only (covered above); production keeps Paystack only", () => {
  assert.equal(MOCK_CHECKOUT_HOST, "checkout.mock.test");
  const mock = src("../server/payments/mockSplitProvider.ts");
  assert.ok(mock.includes(MOCK_CHECKOUT_HOST), "the mock still uses the host the client allows in dev");
});
test("I6: system chat lines are kept as system, never as typed text; typed chat can't claim it", () => {
  let s = liveState();
  s = roomReducer(s, { type: "room:chat", userId: "ade", text: "sprayed Mara a note", at: 1, system: "spray" });
  s = roomReducer(s, { type: "room:chat", userId: "me", text: "They left the stage, so you were refunded in full.", at: 2, system: "spray_reversed" });
  s = roomReducer(s, { type: "room:chat", userId: "bob", text: "sprayed Mara a note", at: 3 });
  s = roomReducer(s, { type: "room:chat", userId: "bob", text: "x", at: 4, system: "<b>bad</b>" } as any);
  assert.equal(s.chat[0].system, "spray");
  assert.equal(s.chat[1].system, "spray_reversed");
  assert.equal(s.chat[2].system, undefined);
  assert.equal(s.chat[3].system, undefined);
  // A system line is never a reply.
  s = roomReducer(s, { type: "room:chat", userId: "ade", text: "sprayed Mara a bundle", at: 5, system: "spray", replyTo: { userId: "bob", text: "hi", at: 3 } } as any);
  assert.equal(s.chat[4].replyTo, undefined);
  assert.equal(systemChatText("spray", "sprayed Mara a note", "Ade"), "Ade sprayed Mara a note");
  assert.equal(systemChatText("spray_reversed", "They left the stage, so you were refunded in full.", "You"), "They left the stage, so you were refunded in full.");
  const log = src("../client/src/components/rooms/chat/ChatLog.tsx");
  assert.match(log, /c\.system \? \(\s*<SystemRow/);
  const strip = src("../client/src/components/rooms/RoomChat.tsx");
  assert.match(strip, /c\.system \? \(/);
});
test("I7: the flow holds the block while money is in motion or an outcome is unread", () => {
  assert.equal(holdsSprayBlock(IDLE), false);
  assert.equal(holdsSprayBlock(confirm()), false);
  assert.equal(holdsSprayBlock(paying()), true);
  assert.equal(holdsSprayBlock(sprayFlow(paying(), { type: "outcome", outcome: { kind: "action_required", sprayId: "sp1", url: "https://checkout.paystack.com/x" }, now: 2 })), true);
  assert.equal(holdsSprayBlock(sprayFlow(paying(), { type: "outcome", outcome: { kind: "failed", reason: "DECLINED", sprayId: null }, now: 2 })), true);
});
test("C1: the room is fetched again when the socket goes live (after the join and after a reconnect)", () => {
  const page = src("../client/src/pages/RoomPage.tsx");
  assert.match(page, /if \(state\.phase === "live" && sprayRoom\) void refetch\(\);/);
  assert.match(page, /\}, \[state\.phase, sprayRoom\]\);/);
  const shell = src("../client/src/components/rooms/shell/RoomShell.tsx");
  // M18: co-hosts are in the refetch key, and the key works before any block exists.
  assert.match(shell, /const stageKey = sprayPossible \? `\$\{state\.stage\.join\("\|"\)\}#\$\{cohostIds\.join\("\|"\)\}/);
  assert.match(shell, /if \(!stageKey \|\| !onSprayChanged\) return;/);
});
test("I8: slide to pay has a keyboard slider and a plain two-tap button path", () => {
  const c = src("../client/src/components/rooms/spray/SprayConfirm.tsx");
  assert.match(c, /role="slider"/);
  assert.match(c, /aria-valuetext=/);
  assert.match(c, /function TwoTapPay/);
  assert.match(c, /if \(!armed\) \{ setArmed\(true\); return; \}/);
  assert.match(c, /SPRAY_COPY\.slideAlt/);
  assert.ok(!c.includes("›"), "M12: no text glyph for the knob");
  assert.match(c, /<ChevronRightIcon/);
});
test("M8: closing the bank sheet keeps tracking; idle and outcomes still close", () => {
  const bank = sprayFlow(paying(), { type: "outcome", outcome: { kind: "action_required", sprayId: "sp1", url: "https://checkout.paystack.com/x" }, now: 2 });
  assert.equal(sprayFlow(bank, { type: "close" }), bank);
  assert.equal(sprayFlow(confirm(), { type: "close" }).kind, "idle");
  const failed = sprayFlow(paying(), { type: "outcome", outcome: { kind: "failed", reason: "DECLINED", sprayId: null }, now: 2 });
  assert.equal(sprayFlow(failed, { type: "close" }).kind, "idle");
  // A new spray can't start while the approval may still go through.
  assert.equal(sprayFlow(bank, { type: "start", tier: "note", targetId: "host", key: K2 }), bank);
});
test("M4: a saved card without last four is still a saved card", () => {
  for (const last4 of ["", null, undefined]) {
    const me = parseSprayMe({ method: { last4, brand: "visa" }, verified: true })!;
    assert.deepEqual(me.method, { last4: null, brand: "visa" }, String(last4));
    assert.equal(cardLabel(me.method), "Your saved Visa");
    assert.match(chargeLine("note", me.method), /^Charged to your saved Visa\./);
  }
  assert.equal(cardLabel({ last4: null, brand: "odd" }), "Your saved card");
  assert.equal(tileAction("note", BLOCK, { ...ME, method: { last4: null, brand: "visa" } }, true).kind, "pay");
});
test("M5: the 'Use another card' save box is wired to the new intent", () => {
  const flow = src("../client/src/components/rooms/spray/SprayFlow.tsx");
  assert.match(flow, /saveCard=\{replaceSave\} onSaveCard=\{setReplaceSave\}/);
  assert.match(flow, /const save = replaceSave;/);
  // retry then saveCard, in that order, lands the choice on the new intent.
  let s = sprayFlow(paying(), { type: "outcome", outcome: { kind: "failed", reason: "DECLINED", sprayId: null }, now: 2 });
  s = sprayFlow(sprayFlow(s, { type: "retry", key: K2 }), { type: "saveCard", on: true });
  assert.equal(s.kind === "confirming" && s.intent.saveCard, true);
  assert.equal(s.kind === "confirming" && s.intent.key, K2);
});
test("M6/Retry-After: seconds or an HTTP date, capped; the retry button waits for it", () => {
  assert.equal(parseRetryAfter("30", 0), 30);
  assert.equal(parseRetryAfter("0", 0), null);
  assert.equal(parseRetryAfter("99999", 0), 3600);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 0), 10);
  assert.equal(parseRetryAfter(new Date(0).toUTCString(), 5_000), null);
  assert.equal(parseRetryAfter("soon", 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
  const sheet = src("../client/src/components/rooms/spray/PaymentFailedSheet.tsx");
  assert.match(sheet, /disabled=\{wait > 0\}/);
});
test("M9: tracking survives a reload in this tab only, and holds no secret", () => {
  const s = sprayFlow(paying(), { type: "outcome", outcome: { kind: "pending", sprayId: "sp1" }, now: 2 });
  const raw = encodeSprayTrack("r1", s)!;
  assert.ok(raw);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["key", "roomId", "since", "sprayId", "targetId", "tier", "v"]);
  assert.equal(encodeSprayTrack("r1", paying()), null); // no spray id yet: nothing to resume
  assert.equal(encodeSprayTrack("r1", confirm()), null);
  const t = decodeSprayTrack(raw, "r1", 1000)!;
  assert.equal(t.sprayId, "sp1");
  assert.equal(decodeSprayTrack(raw, "r2", 1000), null); // another room
  assert.equal(decodeSprayTrack(raw, "r1", 1 + waitDeadlineMs("action_required") + 1), null); // too old
  assert.equal(decodeSprayTrack("{bad", "r1", 1000), null);
  assert.equal(decodeSprayTrack(JSON.stringify({ ...JSON.parse(raw), key: "nope" }), "r1", 1000), null);
  const resumed = sprayFlow(IDLE, { type: "resume", intent: { tier: t.tier, targetId: t.targetId, key: t.key, saveCard: false }, sprayId: t.sprayId, since: t.since });
  assert.equal(resumed.kind === "paying" && resumed.sprayId, "sp1");
  assert.equal(sprayFlow(confirm(), { type: "resume", intent: { tier: t.tier, targetId: t.targetId, key: t.key, saveCard: false }, sprayId: "sp1", since: 1 }).kind, "confirming");
  assert.equal(SPRAY_TRACK_KEY.startsWith("vib3."), true);
  const hook = src("../client/src/components/rooms/spray/useSpray.ts");
  assert.match(hook, /window\.sessionStorage/);
  assert.ok(!hook.includes("localStorage"));
});
test("M19: the fixture's chat line matches the server's text, and the scene parser lives in the fixture module", () => {
  assert.equal(fixtureSprayChatText("note", "Mara"), "sprayed Mara a note");
  assert.equal(fixtureSprayChatText("bundle", "Mara"), "sprayed Mara a bundle");
  assert.equal(fixtureSprayChatText("bag", "Mara"), "sprayed Mara a money bag");
  assert.equal(fixtureSprayChatText("rain", "Mara"), "made it rain on Mara");
  const server = src("../server/rooms/spray.ts");
  assert.ok(server.includes("`made it rain on ${name}`") && server.includes("`sprayed ${name} a ${SPRAY_CATALOGUE[tier].label.toLowerCase()}`"));
  assert.ok(!src("../client/src/lib/sprayUi.ts").includes("parseSprayFixture"));
});
test("ruling 9: screen effects from the prototype, V3C only, never blocking input", () => {
  assert.equal(SPRAY_SCREEN_FX.rain.dim && SPRAY_SCREEN_FX.rain.banner, true);
  assert.equal(SPRAY_SCREEN_FX.note.dim || SPRAY_SCREEN_FX.bundle.banner || SPRAY_SCREEN_FX.bag.dim, false);
  assert.equal(RAIN_FX.dimOpacity, 0.7);
  // The counter: integers from 0 up to the total, never past it, exactly the total at the end.
  let last = -1;
  for (let ms = 0; ms <= RAIN_FX.counterMs + 100; ms += 50) {
    const v = counterAt(10_000_000, ms);
    assert.ok(Number.isSafeInteger(v) && v >= last && v <= 10_000_000, `${ms}: ${v}`);
    last = v;
  }
  assert.equal(counterAt(10_000_000, RAIN_FX.counterMs), 10_000_000);
  assert.equal(counterAt(10_000_000, 0), 0);
  assert.equal(counterAt(10_000_000, NaN), 0);
  assert.equal(counterAt(1.5, 100), 0);
  assert.equal(rainBannerText("Ade", "Mara", false).sub, "Ade is making it rain");
  assert.equal(rainBannerText("Ade", "Mara", true).sub, "You are making it rain");
  assert.equal(thankYouText("Ade"), "Thank you Ade!");
  const fx = src("../client/src/components/rooms/spray/SprayEffects.tsx");
  const code = fx.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!code.includes("₦"), "no naira sign in the effects");
  assert.ok(!code.includes("room:chat"), "effects never make a chat line");
  assert.match(fx, /data-testid="spray-dim"/);
  assert.match(fx, /data-testid="spray-rain-banner"/);
  assert.match(fx, /data-testid="spray-flash"/);
  assert.match(fx, /const bump = /);
  // Everything is pointer-events none, except the one thank-you button.
  assert.equal((fx.match(/pointer-events-auto/g) ?? []).length, 1);
  // Skipped under Quiet effects / reduced motion: the chip path.
  assert.match(fx, /if \(!animate \|\| !eng\) \{\s*chip\(s\);/);
});
test("ruling 8: the note art has no rosette or wavy security lines, and is not banknote-shaped", () => {
  const art = src("../client/src/components/rooms/spray/art.ts");
  const code = art.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assert.ok(!/ROSETTE|lobes|rings/.test(code), "no rosette");
  assert.ok(!/Math\.sin\(\(x \/ w\)/.test(code), "no wavy line pattern");
  assert.match(art, /export const NOTE_ASPECT = 1\.6;/);
  assert.ok(!/\/ 2\.2/.test(code), "no 2.2:1 note anywhere");
  const engine = src("../client/src/components/rooms/spray/engine.ts");
  assert.match(engine, /NH = NW \/ NOTE_ASPECT/);
});
test("M13/M14/M15/M16: tiles stay focusable, targets are toggle buttons, 44 px rows, focus goes back to the opener", () => {
  const tray = src("../client/src/components/rooms/spray/SprayTray.tsx");
  assert.match(tray, /aria-disabled=\{blocked \|\| undefined\}/);
  assert.ok(!/disabled=\{blocked\}/.test(tray));
  assert.ok(!tray.includes('role="radio"'));
  assert.match(tray, /aria-pressed=\{t\.id === targetId\}/);
  assert.match(tray, /htmlFor="spray-quiet" className="flex min-h-\[44px\] min-w-\[44px\]/);
  const card = src("../client/src/components/rooms/spray/CardSheet.tsx");
  assert.match(card, /htmlFor="spray-save-card" className="flex h-11 w-11/);
  const shell = src("../client/src/components/rooms/shell/RoomShell.tsx");
  assert.match(shell, /returnFocusTo=\{sprayReturnFocus\}/);
  assert.match(shell, /sprayOpener\.current = byTestId\(`avatar-\$\{picked\.userId\}`\)/);
});

// ---------------------------------------------------------------- copy rules
test("copy: no em dashes, never 'cash', no legal tender wording", () => {
  for (const line of allSprayCopy()) {
    assert.ok(!line.includes("—"), line);
    assert.ok(!/cash/i.test(line), line);
    assert.ok(!/legal tender/i.test(line), line);
  }
  // The delivery rule: a charge that went through is delivered. No copy claims a refund because of the room, the player or timing.
  for (const line of allSprayCopy()) assert.ok(!/left the stage|room ended|took too long|couldn't be delivered|not delivered/i.test(line), line);
  assert.ok(!/refunded in full if it can/i.test(SPRAY_FAIL_COPY.STILL_CHECKING.body + SPRAY_FAIL_COPY.STILL_WAITING.body));
  assert.equal(SPRAY_FAIL_COPY.REVERSED.body, "This payment didn't pass our checks, so it was returned to you in full.");
  assert.equal(SPRAY_FAIL_COPY.DISPUTED.refunded, false);
  assert.match(SPRAY_FAIL_COPY.DECLINED.body, /not charged/);
  assert.match(SPRAY_FAIL_COPY.NOT_SENT.title, /offline/);
  assert.match(SPRAY_FAIL_COPY.NOT_SENT.body, /Nothing was sent/);
  assert.equal(SPRAY_FAIL_COPY.UNAVAILABLE.body, "Spraying is not available here.");
  assert.ok(SPRAY_COPY.saveCard.length > 0);
});
test("non-refundable notice: exact wording, plain, and the tray's own line is kept", () => {
  assert.equal(SPRAY_COPY.nonRefundable, "Spray purchases are non-refundable.");
  assert.equal(SPRAY_COPY.trayIntro, "You pay when you throw. Nothing is stored.");
  assert.ok(allSprayCopy().includes(SPRAY_COPY.nonRefundable), "covered by the em dash / cash checks above");
  const notice = src("../client/src/components/rooms/spray/NonRefundableNotice.tsx");
  assert.match(notice, /text-sm/, "14 px or larger");
  assert.ok(!/title=|Tooltip|sr-only|hidden/.test(notice), "always visible: no tooltip, no hidden text");
});
test("non-refundable notice: present in every state a spray can be started (tray, confirm, card, team)", () => {
  const files = [
    "../client/src/components/rooms/spray/SprayTray.tsx",
    "../client/src/components/rooms/spray/SprayConfirm.tsx",
    "../client/src/components/rooms/spray/CardSheet.tsx",
    "../client/src/components/rooms/game/SprayTeamSheet.tsx",
  ];
  for (const f of files) {
    const code = stripComments(src(f));
    assert.ok(code.includes("<NonRefundableNotice />"), f);
    assert.ok(code.includes("NonRefundableNotice"), f);
  }
  // Above the tier buttons / pay action, not after them.
  const tray = src(files[0]);
  assert.ok(tray.indexOf("<NonRefundableNotice />") < tray.indexOf("data-testid={`spray-tile-"), "tray: before the tiers");
  const team = src(files[3]);
  assert.ok(team.indexOf("<NonRefundableNotice />") < team.indexOf("spray-team-tile-"), "team sheet: before the tiers");
  const confirm = src(files[1]);
  assert.ok(confirm.indexOf("<NonRefundableNotice />") < confirm.indexOf("{paying ? ("), "confirm: before the pay controls");
});
// ---------------------------------------------------------------- team spray (one charge split between a team)
const teamStart = (key = K1): SprayFlow => sprayFlow(IDLE, { type: "start", tier: "bag", targetId: "a1", key, side: "A" });
test("team spray: the intent carries its side and the idempotency key made once for it", () => {
  const s = teamStart();
  assert.equal(s.kind === "confirming" && s.intent.side, "A");
  assert.equal(s.kind === "confirming" && s.intent.key, K1);
  assert.equal(sprayFlow(IDLE, { type: "start", tier: "bag", targetId: "a1", key: K1, side: "C" as any }).kind === "confirming" && (sprayFlow(IDLE, { type: "start", tier: "bag", targetId: "a1", key: K1, side: "C" as any }) as any).intent.side, undefined);
  assert.equal(confirm().kind === "confirming" && (confirm() as any).intent.side, undefined, "a single spray has no side");
});
test("team spray: an unknown outcome replays the SAME key and side; a definitive answer is a new intent that keeps the side", () => {
  let s = sprayFlow(teamStart(), { type: "pay", now: 1 });
  s = sprayFlow(s, { type: "outcome", outcome: { kind: "unknown" }, now: 2 });
  assert.equal(s.kind === "paying" && s.unknown, true);
  assert.equal(s.kind === "paying" && s.intent.key, K1);
  let f = sprayFlow(sprayFlow(teamStart(), { type: "pay", now: 1 }), { type: "outcome", outcome: { kind: "failed", reason: "DECLINED", sprayId: "b1" }, now: 2 });
  f = sprayFlow(f, { type: "retry", key: K2 });
  assert.equal(f.kind === "confirming" && f.intent.key, K2);
  assert.equal(f.kind === "confirming" && f.intent.side, "A");
  let g = sprayFlow(sprayFlow(teamStart(), { type: "pay", now: 1 }), { type: "outcome", outcome: { kind: "failed", reason: "STILL_CHECKING", sprayId: null }, now: 2 });
  g = sprayFlow(g, { type: "retry", key: K2 });
  assert.equal(g.kind === "confirming" && g.intent.key, K1, "same key after an unknown outcome");
});
test("team spray: the throw goes to the team route with the intent's key, side and tier, and no amount", () => {
  const api = src("../client/src/lib/sprayApi.ts");
  assert.match(api, /\/spray\/team\$\{withToken\(token\)\}/);
  assert.match(api, /tier: p\.tier, side: p\.side, idempotencyKey: p\.idempotencyKey/);
  assert.ok(!/amount|kobo|shares/i.test(api.slice(api.indexOf("export const postSprayTeam"), api.indexOf("export const getSprayTeamStatus"))), "the client sends no amount or share");
  const hook = src("../client/src/components/rooms/spray/useSpray.ts");
  assert.match(hook, /postSprayTeam\(roomId, \{ tier: intent\.tier, side: intent\.side, idempotencyKey: intent\.key/);
  assert.match(hook, /getSprayTeamStatus/);
});
test("team spray: answers read through the single spray's rules (batch id plays the spray id)", () => {
  assert.equal(outcomeOfPost({ ok: true, status: 200, body: { status: "delivered", batchId: "bt1", sprayId: "bt1" } }, ORIGIN).kind, "delivered");
  const bank = outcomeOfPost({ ok: true, status: 200, body: { status: "action_required", sprayId: "bt1", authorizationUrl: "https://checkout.paystack.com/x" } }, ORIGIN);
  assert.equal(bank.kind, "action_required");
  assert.equal(outcomeOfStatus({ ok: true, status: 200, body: { status: "delivered", sprayId: "bt1" } }, "bt1").kind, "delivered");
  assert.equal(sprayTeamReturnId("?sprayTeam=bt1"), "bt1");
  assert.equal(sprayTeamReturnId("?sprayTeam=<x>"), null);
  assert.equal(searchWithoutSpray("?sprayTeam=bt1&a=1"), "?a=1");
});
test("team spray: every refusal is the single generic 'spraying isn't available' screen", () => {
  for (const code of ["SPRAY_UNAVAILABLE"]) {
    const o = outcomeOfPost({ ok: false, status: 403, code }, ORIGIN);
    assert.equal(o.kind === "failed" && o.reason, "UNAVAILABLE");
  }
  assert.equal(SPRAY_FAIL_COPY.UNAVAILABLE.body, "Spraying is not available here.");
  const api = src("../client/src/lib/sprayApi.ts");
  assert.ok(!/reason.*SPRAY_UNAVAILABLE|which player|not payable/i.test(api), "no oracle wording in the api layer");
});
test("team spray tray: only tiers at or above the minimum, 'split equally between N players', notice above the tiers", () => {
  assert.deepEqual(teamSprayTiers(3), ["bag", "rain"]);
  assert.equal(splitLine(3), "Split equally between 3 players");
  assert.equal(splitLine(1), "Split equally between 1 player");
  const sheet = src("../client/src/components/rooms/game/SprayTeamSheet.tsx");
  assert.match(sheet, /teamSprayTiers\(players\.length\)/);
  assert.match(sheet, /splitLine\(players\.length\)/);
  assert.ok(!/to each player|formatNaira\(least\)/.test(sheet), "no invented per-player amount");
  assert.ok(sheet.indexOf("<NonRefundableNotice />") < sheet.indexOf("spray-team-tile-"));
  assert.match(sheet, /onClick=\{\(\) => \{ if \(onThrow\) onThrow\(side, tier\); \}\}/);
});
test("team spray: the toggle shows only when the config allows it, and the animation cap holds", () => {
  const shell = src("../client/src/components/rooms/shell/RoomShell.tsx");
  assert.match(shell, /const sprayTeamOk = gameCaps\.teamSpray && !!sprayBlock/);
  assert.match(shell, /maxNotes=\{gameOn \? GAME_MAX_NOTES : undefined\}/);
  assert.match(src("../client/src/lib/gameScreen.ts"), /GAME_MAX_NOTES = 70/);
});

test("copy: every tier has a price line from sprayPrice", () => {
  for (const t of SPRAY_TIERS) assert.ok(allSprayCopy().some((l) => l.startsWith(sprayPrice(t).display)), t);
});

// ---------------------------------------------------------------- fixtures
test("fixture scenes parse and start in valid states", () => {
  assert.equal(parseSprayFixture("?spray=bank"), "bank");
  assert.equal(parseSprayFixture("?spray=nope"), null);
  assert.ok(idempotencyKeyShape(FIXTURE_SPRAY_KEY));
  for (const scene of ["tray", "confirm", "bank", "declined", "quiet"] as const) {
    const f = fixtureSprayStart(scene, 1000, ORIGIN);
    if (f.flow.kind === "action_required") assert.ok(safeAuthorizationUrl(f.flow.url, ORIGIN, { dev: true }));
  }
  assert.equal(fixtureSprayStart("quiet", 0, ORIGIN).quiet, true);
});

// ---------------------------------------------------------------- source checks
test("source: the dock shows Spray only when given the spray prop; the shell gives it only from the parsed block", () => {
  const dock = src("../client/src/components/rooms/shell/RoomDock.tsx");
  assert.match(dock, /const sprayBtn = spray \?/);
  const shell = src("../client/src/components/rooms/shell/RoomShell.tsx");
  assert.match(shell, /const sprayBlock = listenOnly \? null : spray;/);
  assert.match(shell, /spray=\{sprayBlock && sprayTo\.length > 0/);
  // The flow mounts on the live block, or on the last good one only while it holds money in motion (review I7).
  assert.match(shell, /const flowBlock = sprayBlock \?\? \(sprayHold \? lastSprayBlock\.current : null\);/);
  assert.match(shell, /\{flowBlock && \(\s*<SprayFlow/);
  assert.match(shell, /onHoldChange=\{setSprayHold\}/);
  // New sprays need the live block: the targets come from it only.
  assert.match(shell, /const sprayTo = sprayTargets\(sprayBlock \?\? null,/);
  const page = src("../client/src/pages/RoomPage.tsx");
  assert.match(page, /parseSprayBlock\(detail\?\.spray, room, \{ listenOnly \}\)/);
  const sheet = src("../client/src/components/rooms/AvatarActionsSheet.tsx");
  assert.match(sheet, /!self && onSpray &&/);
});
test("source: the client never sends an amount, split, currency, payer or reference", () => {
  const api = src("../client/src/lib/sprayApi.ts");
  // code only: the doc comment of the next export ("the payer's own spray only") sits inside this slice
  const body = stripComments(api.slice(api.indexOf("export const postSpray"), api.indexOf("export const getSprayStatus")));
  assert.ok(body.includes("idempotencyKey") && body.includes("tier") && body.includes("targetId"), "the slice is the postSpray call");
  for (const word of ["amount", "kobo", "currency", "payer", "reference", "split"]) assert.ok(!new RegExp(word, "i").test(body.replace(/idempotencyKey/g, "")), word);
});
test("source: every attempt of an intent sends the intent's key; the bank link is noopener noreferrer", () => {
  const hook = src("../client/src/components/rooms/spray/useSpray.ts");
  assert.match(hook, /idempotencyKey: intent\.key/);
  assert.match(hook, /busy\.current = true/);
  const bank = src("../client/src/components/rooms/spray/BankApproval.tsx");
  assert.match(bank, /rel="noopener noreferrer"/);
});
test("source: effects never make a chat line, and the tray draws no naira sign in artwork", () => {
  // code only: the file's header comment names room:chat to say the chat line is the server's own
  const fx = stripComments(src("../client/src/components/rooms/spray/SprayEffects.tsx"));
  assert.ok(!fx.includes("room:chat"));
  assert.ok(!/\bsend\(|socket|\bws\./.test(fx), "effects never touch the socket (the thank-you is the viewer's own tap through a prop)");
  const tray = src("../client/src/components/rooms/spray/SprayTray.tsx");
  assert.ok(!tray.includes("₦"));
});

test("spray board: a live board bumps the tick, the first load does not; bad rows are dropped; at most three", () => {
  let st = liveState("R1");
  st = roomReducer(st, { type: "room:spray_board", top: [{ id: "a", name: "A", v3c: 5 }, { id: "", name: "x", v3c: 1 }, { id: "b", name: "B", v3c: -1 }, { id: "c", name: "C", v3c: 3 }, { id: "d", name: "D", v3c: 2 }, { id: "e", name: "E", v3c: 1 }], initial: true });
  assert.deepEqual(st.sprayBoard.map((r) => r.id), ["a", "c", "d"]);
  assert.equal(st.sprayBoardTick, 0);
  st = roomReducer(st, { type: "room:spray_board", top: [{ id: "anonymous", name: "Anonymous", v3c: 9 }] });
  assert.equal(st.sprayBoardTick, 1);
  assert.equal(st.sprayBoard[0].name, "Anonymous");
  assert.deepEqual(roomReducer(st, { type: "room:spray_board", top: "nope" }).sprayBoard, []);
});
test("spray received: only for this room, only sane numbers, and it resets in another room", () => {
  let st = liveState("R1");
  assert.equal(roomReducer(st, { type: "room:spray_received", roomId: "OTHER", kobo: 10, v3c: 10 }).sprayReceived, null);
  assert.equal(roomReducer(st, { type: "room:spray_received", kobo: -1, v3c: 10 }).sprayReceived, null);
  st = roomReducer(st, { type: "room:spray_received", roomId: "R1", kobo: 86_000, v3c: 1_150_000 });
  assert.deepEqual(st.sprayReceived, { kobo: 86_000, v3c: 1_150_000 });
  st = roomReducer(st, { type: "room:state", room: { id: "R2" }, members: [], memberCount: 0, screen: null, you: { role: "guest", muted: false } });
  assert.equal(st.sprayReceived, null);
});
test("anonymous: a toggle on the confirm step, off by default", () => {
  let f = sprayFlow({ kind: "idle" } as SprayFlow, { type: "start", tier: "note", targetId: "t1", key: newIdempotencyKey() });
  assert.equal((f as any).intent.anonymous, undefined);
  f = sprayFlow(f, { type: "anonymous", on: true });
  assert.equal((f as any).intent.anonymous, true);
  f = sprayFlow(f, { type: "anonymous", on: false });
  assert.equal((f as any).intent.anonymous, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
