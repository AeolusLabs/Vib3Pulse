// Room ticket checkout: pure helpers (no database, no provider):   npx tsx scripts/test-rooms-unit-ticketcheckout.ts
// ticketCode, reference binding (HMAC), amount comparison, the one purchase rule and its order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  amountMatches, checkPurchase, isSellablePrice, refusalOf, ticketCode, ticketSeatLimit,
  ROOM_TICKET_MAX_KOBO, ROOM_TICKET_MIN_KOBO, type PurchaseInput,
} from "../shared/roomTickets";
import {
  looksLikeTicketReference, makeTicketReference, ticketReferenceBelongsTo, ticketReferenceSecret,
} from "../server/rooms/ticketReference";
import { normalizePaystackMetadata, paystackMetadataObject } from "../server/payments/paystack";
import { ROOM_LIMITS } from "../shared/rooms";
import { createKeyedQueue, QueueFullError } from "../server/rooms/keyedQueue";
import { ticketCheckoutBaseUrl } from "../server/rooms/checkoutUrl";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const SECRET = "tc_unit_secret";
const ROOM = "11111111-2222-3333-4444-555555555555";
const ROOM2 = "66666666-7777-8888-9999-000000000000";
const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER2 = "ffffffff-0000-1111-2222-333333333333";

// ------------------------------------------------------------ ticketCode
test("ticketCode: first 8 hex of the id as XXXX-XXXX", () => {
  assert.equal(ticketCode("3f9a12bc-0000-4000-8000-000000000000"), "3F9A-12BC");
});
test("ticketCode: same id, same code; different ids, different codes", () => {
  assert.equal(ticketCode(ROOM), ticketCode(ROOM));
  assert.notEqual(ticketCode(ROOM), ticketCode(USER));
});

// ------------------------------------------------------------ references
test("reference: shape is vib3rt_<24 hex>_<32 hex> and Paystack-safe", () => {
  const r = makeTicketReference(ROOM, USER, SECRET);
  assert.match(r, /^vib3rt_[0-9a-f]{24}_[0-9a-f]{32}$/);
  assert.ok(r.length <= 100);
  assert.ok(looksLikeTicketReference(r));
});
test("reference: two checkouts by the same buyer get different references (random nonce)", () => {
  assert.notEqual(makeTicketReference(ROOM, USER, SECRET), makeTicketReference(ROOM, USER, SECRET));
});
test("reference: deterministic for a given nonce", () => {
  const n = "0123456789abcdef01234567";
  assert.equal(makeTicketReference(ROOM, USER, SECRET, n), makeTicketReference(ROOM, USER, SECRET, n));
});
test("reference: belongs to the room and user it was made for", () => {
  const r = makeTicketReference(ROOM, USER, SECRET);
  assert.equal(ticketReferenceBelongsTo(r, ROOM, USER, SECRET), true);
});
test("reference: another user's reference is rejected", () => {
  const r = makeTicketReference(ROOM, USER, SECRET);
  assert.equal(ticketReferenceBelongsTo(r, ROOM, USER2, SECRET), false);
});
test("reference: replay against a different room is rejected", () => {
  const r = makeTicketReference(ROOM, USER, SECRET);
  assert.equal(ticketReferenceBelongsTo(r, ROOM2, USER, SECRET), false);
});
test("reference: a different secret rejects it (MAC, not just shape)", () => {
  const r = makeTicketReference(ROOM, USER, SECRET);
  assert.equal(ticketReferenceBelongsTo(r, ROOM, USER, "tc_other_secret"), false);
});
test("reference: a tampered MAC or nonce is rejected", () => {
  const r = makeTicketReference(ROOM, USER, SECRET);
  const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "0" ? "1" : "0") + s.slice(i + 1);
  assert.equal(ticketReferenceBelongsTo(flip(r, r.length - 1), ROOM, USER, SECRET), false);
  assert.equal(ticketReferenceBelongsTo(flip(r, 8), ROOM, USER, SECRET), false);
});
test("reference: junk, the old vib3_ shape, and non-strings are rejected without throwing", () => {
  for (const x of ["", "vib3_1700000000000_abc1234", "vib3rt_x_y", `vib3rt_${"0".repeat(24)}_${"0".repeat(31)}`, null, 42, undefined, {}]) {
    assert.equal(ticketReferenceBelongsTo(x, ROOM, USER, SECRET), false);
    assert.equal(looksLikeTicketReference(x), false);
  }
});
test("reference: ids that differ only by where a separator falls do not collide", () => {
  const n = "0123456789abcdef01234567";
  assert.notEqual(makeTicketReference("a:b", "c", SECRET, n), makeTicketReference("a", "b:c", SECRET, n));
});
test("reference: a bad nonce throws", () => {
  assert.throws(() => makeTicketReference(ROOM, USER, SECRET, "xyz"));
});
test("reference secret: ROOM_TICKET_REF_SECRET, else SESSION_SECRET, else throws", () => {
  assert.equal(ticketReferenceSecret({ ROOM_TICKET_REF_SECRET: "a", SESSION_SECRET: "b" } as any), "a");
  assert.equal(ticketReferenceSecret({ SESSION_SECRET: "b" } as any), "b");
  assert.throws(() => ticketReferenceSecret({} as any));
});

// ------------------------------------------------------------ amounts
test("amount: exact stored price in NGN matches", () => {
  assert.equal(amountMatches(500000, 500000, "NGN"), true);
});
test("amount: one kobo less or more does not match (no 'at least')", () => {
  assert.equal(amountMatches(499999, 500000, "NGN"), false);
  assert.equal(amountMatches(500001, 500000, "NGN"), false);
});
test("amount: another currency never matches", () => {
  assert.equal(amountMatches(500000, 500000, "GBP"), false);
  assert.equal(amountMatches(500000, 500000, "ngn"), false);
});
test("amount: non-integer, NaN, string amounts never match", () => {
  for (const v of [500000.5, NaN, "500000", null, undefined, Infinity]) assert.equal(amountMatches(v, 500000, "NGN"), false);
});
test("amount: a stored price outside the limits never matches (not for sale)", () => {
  assert.equal(amountMatches(50000, 50000, "NGN"), false);
  assert.equal(amountMatches(ROOM_TICKET_MAX_KOBO + 1, ROOM_TICKET_MAX_KOBO + 1, "NGN"), false);
  assert.equal(amountMatches(null, null, "NGN"), false);
});
test("amount: default currency is NGN", () => {
  assert.equal(amountMatches(100000, 100000), true);
});
test("price: sellable only for integers within 1,000 to 100,000 naira", () => {
  assert.equal(isSellablePrice(ROOM_TICKET_MIN_KOBO), true);
  assert.equal(isSellablePrice(ROOM_TICKET_MAX_KOBO), true);
  assert.equal(isSellablePrice(ROOM_TICKET_MIN_KOBO - 1), false);
  assert.equal(isSellablePrice(150000.5), false);
  assert.equal(isSellablePrice(null), false);
});

// ------------------------------------------------------------ checkPurchase
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const base = (over: Partial<PurchaseInput> = {}, room: Partial<PurchaseInput["room"]> = {}): PurchaseInput => ({
  buyerId: USER,
  buyer: { ageVerifiedAt: new Date(), dateOfBirth: yearsAgo(30), deletedAt: null },
  room: { hostId: USER2, status: "scheduled", ageLimit: "18+", minorsRoom: false, moderationStatus: "approved", ticketPriceKobo: 500000, ticketCapacity: 20, capacity: 50, ...room },
  bannedOrBlocked: false, paidCount: 0, buyerHasPaid: false,
  ...over,
});
const code = (i: PurchaseInput) => { const c = checkPurchase(i); return c.ok ? "OK" : c.code; };

test("purchase: verified adult, ticketed 18+ scheduled room with seats: ok", () => assert.equal(code(base()), "OK"));
test("purchase: live room is ok too", () => assert.equal(code(base({}, { status: "live" })), "OK"));
test("purchase: unverified adult refused", () => assert.equal(code(base({ buyer: { ageVerifiedAt: null, dateOfBirth: yearsAgo(30) } })), "NOT_VERIFIED_ADULT"));
test("purchase: under-18 refused even if marked verified", () => assert.equal(code(base({ buyer: { ageVerifiedAt: new Date(), dateOfBirth: yearsAgo(16) } })), "NOT_VERIFIED_ADULT"));
test("purchase: no birthdate refused", () => assert.equal(code(base({ buyer: { ageVerifiedAt: new Date(), dateOfBirth: null } })), "NOT_VERIFIED_ADULT"));
test("purchase: teen gets the same answer for a free room and a ticketed one (no price leak)", () => {
  const teen = { ageVerifiedAt: null, dateOfBirth: yearsAgo(15) };
  assert.equal(code(base({ buyer: teen }, { ticketPriceKobo: null })), code(base({ buyer: teen })));
  assert.equal(code(base({ buyer: teen }, { ageLimit: "all" })), "NOT_VERIFIED_ADULT");
});
test("purchase: 19-year-old verified adult in a 21+ room refused", () => assert.equal(code(base({ buyer: { ageVerifiedAt: new Date(), dateOfBirth: yearsAgo(19) } }, { ageLimit: "21+" })), "BELOW_AGE_LIMIT"));
test("purchase: minors' room never sells", () => assert.equal(code(base({}, { minorsRoom: true })), "ROOM_NOT_ADULT"));
test("purchase: all-ages room never sells", () => assert.equal(code(base({}, { ageLimit: "all" })), "ROOM_NOT_ADULT"));
test("purchase: host cannot buy", () => assert.equal(code(base({ buyerId: USER2 })), "IS_HOST"));
test("purchase: banned or blocked refused", () => assert.equal(code(base({ bannedOrBlocked: true })), "BANNED_OR_BLOCKED"));
test("purchase: deleted or missing buyer refused", () => {
  assert.equal(code(base({ buyer: null })), "BUYER_GONE");
  assert.equal(code(base({ buyer: { ageVerifiedAt: new Date(), dateOfBirth: yearsAgo(30), deletedAt: new Date() } })), "BUYER_GONE");
});
test("purchase: ended room refused", () => assert.equal(code(base({}, { status: "ended" })), "ROOM_NOT_OPEN"));
test("purchase: taken-down room refused", () => assert.equal(code(base({}, { moderationStatus: "rejected" })), "ROOM_NOT_APPROVED"));
test("purchase: no price refused", () => assert.equal(code(base({}, { ticketPriceKobo: null })), "NOT_TICKETED"));
test("purchase: already holds a paid ticket", () => assert.equal(code(base({ buyerHasPaid: true })), "ALREADY_TICKETED"));
test("purchase: sold out at the seat limit", () => {
  assert.equal(code(base({ paidCount: 19 })), "OK");
  assert.equal(code(base({ paidCount: 20 })), "SOLD_OUT");
});
test("purchase: seat limit falls back to room capacity, and a bad limit means no seats", () => {
  assert.equal(ticketSeatLimit({ ticketCapacity: null, capacity: 50 }), 50);
  assert.equal(ticketSeatLimit({ ticketCapacity: 0, capacity: 50 }), 0);
  assert.equal(code(base({ paidCount: 0 }, { ticketCapacity: 0 })), "SOLD_OUT");
});
test("purchase with payment: unbound reference refused first", () => {
  assert.equal(code(base({ payment: { bound: false, amountKobo: 500000 } })), "NOT_BOUND");
});
test("purchase with payment: amount mismatch refused", () => {
  assert.equal(code(base({ payment: { bound: true, amountKobo: 1000 } })), "AMOUNT_MISMATCH");
  assert.equal(code(base({ payment: { bound: true, amountKobo: 500000, currency: "GBP" } })), "AMOUNT_MISMATCH");
  assert.equal(code(base({ payment: { bound: true, amountKobo: 500000 } })), "OK");
});
test("purchase with payment: ineligibility outranks the amount (no seat, no price talk)", () => {
  assert.equal(code(base({ buyer: { ageVerifiedAt: null, dateOfBirth: yearsAgo(16) }, payment: { bound: true, amountKobo: 1 } })), "NOT_VERIFIED_ADULT");
});
// ---- fix round 4F: price validity, host eligibility, co-host, one source for the limits
test("limits: ROOM_TICKET_MIN/MAX_KOBO are ROOM_LIMITS.ticketMinKobo/ticketMaxKobo (one source)", () => {
  assert.equal(ROOM_TICKET_MIN_KOBO, ROOM_LIMITS.ticketMinKobo);
  assert.equal(ROOM_TICKET_MAX_KOBO, ROOM_LIMITS.ticketMaxKobo);
});
test("purchase: a stored price outside the limits is PRICE_INVALID (sales paused), not NOT_TICKETED", () => {
  assert.equal(code(base({}, { ticketPriceKobo: 50000 })), "PRICE_INVALID");
  assert.equal(code(base({}, { ticketPriceKobo: ROOM_TICKET_MAX_KOBO + 1 })), "PRICE_INVALID");
  assert.equal(code(base({}, { ticketPriceKobo: 150000.5 })), "PRICE_INVALID");
  assert.equal(code(base({}, { ticketPriceKobo: undefined })), "NOT_TICKETED");
});
test("purchase: host no longer able to sell -> SALES_PAUSED; left out -> not checked", () => {
  assert.equal(code(base({ hostCanSell: false })), "SALES_PAUSED");
  assert.equal(code(base({ hostCanSell: true })), "OK");
  assert.equal(code(base()), "OK");
});
test("purchase: SALES_PAUSED never outranks the buyer checks or NOT_TICKETED (no room facts to the ineligible)", () => {
  assert.equal(code(base({ hostCanSell: false, buyer: { ageVerifiedAt: null, dateOfBirth: yearsAgo(30) } })), "NOT_VERIFIED_ADULT");
  assert.equal(code(base({ hostCanSell: false }, { ticketPriceKobo: null })), "NOT_TICKETED");
  assert.equal(code(base({ hostCanSell: false }, { status: "ended" })), "ROOM_NOT_OPEN");
});
test("purchase: a co-host never needs to buy (IS_COHOST), after the room checks", () => {
  assert.equal(code(base({ buyerIsCohost: true })), "IS_COHOST");
  assert.equal(code(base({ buyerIsCohost: true }, { ticketPriceKobo: null })), "NOT_TICKETED");
  assert.equal(code(base({ buyerIsCohost: false })), "OK");
});
test("purchase with payment: a host who lost eligibility mid-sale refuses the charge (SALES_PAUSED before the amount)", () => {
  assert.equal(code(base({ hostCanSell: false, payment: { bound: true, amountKobo: 500000 } })), "SALES_PAUSED");
});
test("refusalOf: maps to the contract codes", () => {
  assert.equal(refusalOf("SOLD_OUT"), "SOLD_OUT");
  assert.equal(refusalOf("AMOUNT_MISMATCH"), "AMOUNT_MISMATCH");
  for (const c of ["NOT_BOUND", "BUYER_GONE", "IS_HOST", "NOT_VERIFIED_ADULT", "ROOM_NOT_ADULT", "BELOW_AGE_LIMIT", "ROOM_NOT_OPEN", "ROOM_NOT_APPROVED", "BANNED_OR_BLOCKED", "NOT_TICKETED", "PRICE_INVALID", "SALES_PAUSED", "IS_COHOST"] as const) {
    assert.equal(refusalOf(c), "INELIGIBLE");
  }
});

// ------------------------------------------------------------ metadata pass-through
test("metadata: roomId comes from a room checkout (itemType room)", () => {
  const m = normalizePaystackMetadata({ itemId: ROOM, itemType: "room", roomId: ROOM, userId: USER });
  assert.equal(m.roomId, ROOM);
  assert.equal(m.userId, USER);
  assert.equal(m.eventId, undefined);
});
test("metadata: a bare roomId key without itemType room is ignored", () => {
  const m = normalizePaystackMetadata({ roomId: ROOM, userId: USER } as any);
  assert.equal(m.roomId, undefined);
});
test("metadata: event checkouts are unchanged", () => {
  const m = normalizePaystackMetadata({ itemId: "e1", itemType: "event", userId: USER });
  assert.equal(m.eventId, "e1");
  assert.equal(m.roomId, undefined);
});

// ---- M4: Paystack may hand metadata back as a JSON string
test("metadata: a JSON string is parsed (roomId and userId found)", () => {
  const m = normalizePaystackMetadata(JSON.stringify({ itemId: ROOM, itemType: "room", userId: USER }));
  assert.equal(m.roomId, ROOM);
  assert.equal(m.userId, USER);
});
test("metadata: junk strings, arrays, null become {} (never character keys)", () => {
  for (const x of ["not json", "[1,2]", "42", "", null, undefined, [1, 2] as any]) {
    assert.deepEqual(paystackMetadataObject(x), {}, JSON.stringify(x));
  }
  assert.equal(normalizePaystackMetadata("{bad").roomId, undefined);
});

// ---- M9: the checkout return URL never comes from the Host header in production
test("base URL: APP_URL wins (trailing slashes trimmed)", () => {
  assert.equal(ticketCheckoutBaseUrl({ APP_URL: "https://vib3pulse.com/", NODE_ENV: "production" } as any, "http://evil.example"), "https://vib3pulse.com");
});
test("base URL: production without APP_URL -> null (checkout answers 500 CHECKOUT_FAILED)", () => {
  assert.equal(ticketCheckoutBaseUrl({ NODE_ENV: "production" } as any, "http://evil.example"), null);
  assert.equal(ticketCheckoutBaseUrl({ NODE_ENV: "production", APP_URL: "   " } as any, "http://evil.example"), null);
});
test("base URL: a malformed or non-http APP_URL -> null", () => {
  assert.equal(ticketCheckoutBaseUrl({ APP_URL: "not a url" } as any, "http://x"), null);
  assert.equal(ticketCheckoutBaseUrl({ APP_URL: "javascript:alert(1)" } as any, "http://x"), null);
});
test("base URL: outside production the request host is the fallback (dev and tests)", () => {
  assert.equal(ticketCheckoutBaseUrl({ NODE_ENV: "development" } as any, "http://127.0.0.1:5000"), "http://127.0.0.1:5000");
  assert.equal(ticketCheckoutBaseUrl({} as any, "http://127.0.0.1:5000"), "http://127.0.0.1:5000");
});
test("checkout route uses the helper, never a bare Host-header fallback", () => {
  const src = readFileSync(new URL("../server/rooms/ticketRoutes.ts", import.meta.url), "utf8");
  assert.match(src, /ticketCheckoutBaseUrl\(process\.env/);
  assert.doesNotMatch(src, /process\.env\.APP_URL \|\|/);
});

// ---- I4: the per-room issue queue (pure, async)
const atests: Array<[string, () => Promise<void>]> = [];
const atest = (name: string, fn: () => Promise<void>) => { atests.push([name, fn]); };
const tick = () => new Promise<void>((r) => setImmediate(r));
atest("queue: tasks for one key run one at a time, in arrival order", async () => {
  const qu = createKeyedQueue({ maxPending: 10 });
  const log: string[] = [];
  let running = 0, maxRunning = 0;
  const task = (n: number) => qu.run("room", async () => {
    running++; maxRunning = Math.max(maxRunning, running); log.push(`start${n}`);
    await tick(); await tick();
    log.push(`end${n}`); running--; return n;
  });
  const out = await Promise.all([task(1), task(2), task(3)]);
  assert.deepEqual(out, [1, 2, 3]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(log, ["start1", "end1", "start2", "end2", "start3", "end3"]);
  assert.equal(qu.pending("room"), 0);
});
atest("queue: different keys do not wait for each other", async () => {
  const qu = createKeyedQueue({ maxPending: 10 });
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => { releaseA = r; });
  const a = qu.run("A", async () => { await gateA; return "a"; });
  const b = await qu.run("B", async () => "b"); // finishes while A is still held
  assert.equal(b, "b");
  assert.equal(qu.pending("A"), 1);
  releaseA();
  assert.equal(await a, "a");
});
atest("queue: beyond maxPending for one key -> QueueFullError at once, nothing queued; other keys unaffected", async () => {
  const qu = createKeyedQueue({ maxPending: 2 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ran = 0;
  const p1 = qu.run("R", async () => { ran++; await gate; });
  const p2 = qu.run("R", async () => { ran++; });
  let err: unknown = null;
  try { await qu.run("R", async () => { ran++; }); } catch (e) { err = e; }
  assert.ok(err instanceof QueueFullError, String(err));
  assert.equal(qu.pending("R"), 2);
  assert.equal(await qu.run("OTHER", async () => 7), 7);
  release();
  await Promise.all([p1, p2]);
  assert.equal(ran, 2, "the refused task never ran");
  assert.equal(qu.pending("R"), 0);
  await qu.run("R", async () => { ran++; }); // accepted again once drained
  assert.equal(ran, 3);
});
atest("queue: a failing task rejects its own caller only and never blocks the next", async () => {
  const qu = createKeyedQueue({ maxPending: 5 });
  const bad = qu.run("R", async () => { throw new Error("boom"); });
  const good = qu.run("R", async () => "ok");
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "ok");
  assert.equal(qu.pending("R"), 0);
});
atest("queue: maxPending must be a positive integer", async () => {
  assert.throws(() => createKeyedQueue({ maxPending: 0 }));
  assert.throws(() => createKeyedQueue({ maxPending: 1.5 }));
});
atest("issueRoomTicket goes through the queue before taking a connection, and the room row lock stays", async () => {
  const src = readFileSync(new URL("../server/rooms/tickets.ts", import.meta.url), "utf8");
  assert.match(src, /issueQueue\.run\(roomId, \(\) => db\.transaction\(/);
  assert.match(src, /\.from\(rooms\)\.where\(eq\(rooms\.id, roomId\)\)\.for\("update"\)/);
});
for (const [name, fn] of atests) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e?.message ?? e).split("\n")[0]}`); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
