// Spraying on the client (tasks 5.7 and 5.9), pure helpers and source checks (no database, no browser):
//   npx tsx scripts/test-rooms-unit-spray-client.ts
// Written, not run (owner's no-testing rule for phase 5). Runs under npm run test:rooms with the other unit suites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPRAY_TIERS } from "../shared/money";
import { idempotencyKeyShape, sprayPrice } from "../shared/spray";
import { SPRAY_CAP, initialRoomState, roomReducer, type RoomState } from "../client/src/lib/roomReducer";
import {
  IDLE, SAME_KEY_REASONS, SPRAY_COPY, SPRAY_FAIL_COPY, allSprayCopy, animateSprays, cardLabel, chargeLine, dailyChoices, defaultTarget,
  inFlight, limitChoices, needsSlide, newIdempotencyKey, newSprays, outcomeOfPost, outcomeOfStatus, parseLimitBody, parseSprayBlock,
  parseSprayFixture, parseSprayMe, reasonOfRefusal, safeAuthorizationUrl, searchWithoutSpray, sprayFlow, sprayReturnId, sprayTargets,
  tileAction, waitDeadlineMs, type SprayBlock, type SprayFlow, type SprayMe,
} from "../client/src/lib/sprayUi";
import { FIXTURE_SPRAY_KEY, fixtureSprayStart } from "../client/src/lib/sprayFixtures";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

const ORIGIN = "https://vib3pulse.example";
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-9222-222222222222";
const ROOM18 = { ageLimit: "18+", minorsRoom: false, status: "live" };
const BLOCK: SprayBlock = { enabled: true, roomLimitKobo: 200_000, roomSpentKobo: 0, targets: ["host", "stage1"] };
const ME: SprayMe = { method: { last4: "4242", brand: "visa" }, dailyLimitKobo: 2_000_000, dailySpentKobo: 0, verified: true };

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
  assert.equal(parseSprayBlock({ ...BLOCK, roomLimitKobo: 1.5 }, ROOM18), null);
  assert.equal(parseSprayBlock({ ...BLOCK, roomSpentKobo: -1 }, ROOM18), null);
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
  const me = parseSprayMe({ method: { last4: "4242", brand: "visa", authorizationCode: "AUTH_secret", signature: "SIG" }, dailyLimitKobo: 2_000_000, dailySpentKobo: 0, verified: true })!;
  assert.deepEqual(Object.keys(me.method!).sort(), ["brand", "last4"]);
  assert.equal(JSON.stringify(me).includes("AUTH_secret"), false);
  assert.equal(parseSprayMe({ method: { last4: "42a2", brand: "visa" }, dailyLimitKobo: 1, dailySpentKobo: 0, verified: false })!.method, null);
  assert.equal(parseSprayMe({ method: null, dailyLimitKobo: "x", dailySpentKobo: 0, verified: true }), null);
  assert.equal(cardLabel({ last4: "4242", brand: "visa" }), "Visa ending 4242");
  assert.equal(cardLabel({ last4: "0001", brand: "weird" }), "Card ending 0001");
  assert.equal(parseLimitBody({ limitKobo: 500000, spentKobo: 0 })!.limitKobo, 500000);
  assert.equal(parseLimitBody({ limitKobo: "500000" }), null);
});

// ---------------------------------------------------------------- tray rules
test("tileAction: offline and loading are disabled with a reason", () => {
  assert.equal(tileAction("note", BLOCK, ME, false).kind, "blocked");
  assert.equal(tileAction("note", BLOCK, null, true).kind, "blocked");
});
test("tileAction: equal to the room limit pays, one kobo over asks to raise it", () => {
  assert.equal(tileAction("bundle", { ...BLOCK, roomLimitKobo: 200_000, roomSpentKobo: 100_000 }, ME, true).kind, "pay");
  assert.equal(tileAction("bundle", { ...BLOCK, roomLimitKobo: 200_000, roomSpentKobo: 100_001 }, ME, true).kind, "limit");
  assert.equal(tileAction("bag", BLOCK, ME, true).kind, "limit");
});
test("tileAction: over the daily limit is disabled", () => {
  const a = tileAction("note", BLOCK, { ...ME, dailySpentKobo: 1_960_000 }, true);
  assert.equal(a.kind, "blocked");
});
test("tileAction: rain over the highest room option has nothing to raise to", () => {
  assert.equal(tileAction("rain", { ...BLOCK, roomLimitKobo: 10_000_000, roomSpentKobo: 50_000 }, { ...ME, dailyLimitKobo: 100_000_000 }, true).kind, "blocked");
});
test("limitChoices: too low and unverified-above-ID options are not offered", () => {
  const c = limitChoices({ ...BLOCK, roomSpentKobo: 50_000 }, sprayPrice("bag").kobo, false);
  assert.equal(c.find((x) => x.kobo === 1_000_000)!.ok, false); // 50,000 + 1,000,000 > 1,000,000
  assert.equal(c.find((x) => x.kobo === 10_000_000)!.ok, false); // above the ID line, unverified
  assert.equal(limitChoices(BLOCK, sprayPrice("bag").kobo, true).find((x) => x.kobo === 10_000_000)!.ok, true);
  assert.equal(dailyChoices(false).find((x) => x.kobo === 5_000_000)!.ok, false);
  assert.equal(dailyChoices(true).every((x) => x.ok), true);
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
  assert.equal(sprayFlow(IDLE, { type: "start", tier: "bundle", targetId: "host", key: K1.toUpperCase() }).kind, "idle");
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
  assert.equal(s.kind === "action_required" && s.since, 5);
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
test("machine: an unknown outcome (offline, 5xx, still waiting) retries with the SAME key", () => {
  for (const reason of ["OFFLINE", "SERVER", "STILL_WAITING", "RATE_LIMITED", "NETWORK"] as const) {
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
  assert.equal(reasonOfRefusal(0), "OFFLINE");
  assert.equal(reasonOfRefusal(401), "SIGNED_OUT");
  assert.equal(reasonOfRefusal(402, "PAYMENT_DECLINED"), "DECLINED");
  assert.equal(reasonOfRefusal(403, "SPRAY_UNAVAILABLE"), "UNAVAILABLE");
  assert.equal(reasonOfRefusal(404), "UNAVAILABLE");
  assert.equal(reasonOfRefusal(409, "ROOM_LIMIT"), "ROOM_LIMIT");
  assert.equal(reasonOfRefusal(409, "DAILY_LIMIT"), "DAILY_LIMIT");
  assert.equal(reasonOfRefusal(409, "IDEMPOTENCY_MISMATCH"), "MISMATCH");
  assert.equal(reasonOfRefusal(429), "RATE_LIMITED");
  assert.equal(reasonOfRefusal(503), "SERVER");
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
  assert.equal(outcomeOfPost({ ok: true, status: 200, body: { status: "delivered" } }, ORIGIN).kind, "failed");
  // NETWORK is an unknown outcome: keep checking, never "failed".
  assert.deepEqual(outcomeOfPost({ ok: true, status: 200, body: { status: "failed", sprayId: "sp1", reason: "NETWORK" } }, ORIGIN), { kind: "pending", sprayId: "sp1" });
  const dec = outcomeOfPost({ ok: true, status: 200, body: { status: "failed", sprayId: "sp1", reason: "DECLINED" } }, ORIGIN);
  assert.equal(dec.kind === "failed" && dec.reason, "DECLINED");
});
test("outcomeOfStatus: refunded reasons, NETWORK keeps waiting, a failed poll never ends the wait", () => {
  const r = outcomeOfStatus({ ok: true, status: 200, body: { status: "reversed", reason: "RECIPIENT_LEFT" } }, "sp1");
  assert.equal(r.kind === "failed" && r.reason, "RECIPIENT_LEFT");
  assert.equal(outcomeOfStatus({ ok: true, status: 200, body: { status: "failed", reason: "NETWORK" } }, "sp1").kind, "wait");
  assert.equal(outcomeOfStatus({ ok: true, status: 200, body: { status: "pending" } }, "sp1").kind, "wait");
  assert.equal(outcomeOfStatus({ ok: false, status: 0 }, "sp1").kind, "wait");
  assert.equal(outcomeOfStatus({ ok: false, status: 404 }, "sp1").kind, "wait");
  const out = outcomeOfStatus({ ok: false, status: 401 }, "sp1");
  assert.equal(out.kind === "failed" && out.reason, "SIGNED_OUT");
  const unk = outcomeOfStatus({ ok: true, status: 200, body: { status: "reversed", reason: "<script>" } }, "sp1");
  assert.equal(unk.kind === "failed" && unk.reason, "REVERSED");
});
test("waits always end: a paid spray within delivery plus a sweep, a bank approval within 11 minutes", () => {
  assert.ok(waitDeadlineMs("paying") >= 60_000 && waitDeadlineMs("paying") <= 120_000);
  assert.ok(waitDeadlineMs("action_required") > 10 * 60_000 && waitDeadlineMs("action_required") <= 12 * 60_000);
});
test("safeAuthorizationUrl: our origin or https Paystack only", () => {
  assert.ok(safeAuthorizationUrl("https://checkout.paystack.com/x", ORIGIN));
  assert.ok(safeAuthorizationUrl("https://standard.paystack.co/close", ORIGIN));
  assert.ok(safeAuthorizationUrl("/dev/room-fixture?spray=tray", ORIGIN));
  for (const bad of ["http://checkout.paystack.com/x", "https://paystack.com.evil.example/x", "https://user:pw@checkout.paystack.com/x", "javascript:alert(1)", "data:text/html,x", "https://evil.example/", 5, ""]) {
    assert.equal(safeAuthorizationUrl(bad, ORIGIN), null, String(bad));
  }
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

// ---------------------------------------------------------------- copy rules
test("copy: no em dashes, never 'cash', no legal tender wording", () => {
  for (const line of allSprayCopy()) {
    assert.ok(!line.includes("—"), line);
    assert.ok(!/cash/i.test(line), line);
    assert.ok(!/legal tender/i.test(line), line);
  }
  assert.equal(SPRAY_FAIL_COPY.RECIPIENT_LEFT.body, "They left the stage, so you were refunded in full.");
  assert.match(SPRAY_FAIL_COPY.DECLINED.body, /not charged/);
  assert.match(SPRAY_FAIL_COPY.OFFLINE.title, /offline/);
  assert.equal(SPRAY_FAIL_COPY.UNAVAILABLE.body, "Spraying is not available here.");
  assert.ok(SPRAY_COPY.saveCard.length > 0);
});
test("copy: every tier has a price line from sprayPrice", () => {
  for (const t of SPRAY_TIERS) assert.ok(allSprayCopy().some((l) => l.startsWith(sprayPrice(t).display)), t);
});

// ---------------------------------------------------------------- fixtures
test("fixture scenes parse and start in valid states", () => {
  assert.equal(parseSprayFixture("?spray=bank"), "bank");
  assert.equal(parseSprayFixture("?spray=nope"), null);
  assert.ok(idempotencyKeyShape(FIXTURE_SPRAY_KEY));
  for (const scene of ["tray", "confirm", "bank", "declined", "limit", "quiet"] as const) {
    const f = fixtureSprayStart(scene, 1000, ORIGIN);
    if (f.flow.kind === "action_required") assert.ok(safeAuthorizationUrl(f.flow.url, ORIGIN));
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
  assert.match(shell, /\{sprayBlock && \(\s*<SprayFlow/);
  const page = src("../client/src/pages/RoomPage.tsx");
  assert.match(page, /parseSprayBlock\(detail\?\.spray, room, \{ listenOnly \}\)/);
  const sheet = src("../client/src/components/rooms/AvatarActionsSheet.tsx");
  assert.match(sheet, /!self && onSpray &&/);
});
test("source: the client never sends an amount, split, currency, payer or reference", () => {
  const api = src("../client/src/lib/sprayApi.ts");
  const body = api.slice(api.indexOf("export const postSpray"), api.indexOf("export const getSprayStatus"));
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
  const fx = src("../client/src/components/rooms/spray/SprayEffects.tsx");
  assert.ok(!fx.includes("room:chat"));
  const tray = src("../client/src/components/rooms/spray/SprayTray.tsx");
  assert.ok(!tray.includes("₦"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
