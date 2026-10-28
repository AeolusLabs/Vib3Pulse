// Spray provider layer (no database, no network: fetch is stubbed):   npx tsx scripts/test-rooms-unit-spray-provider.ts
// Covers: token crypto (B8), spray reference (B4), the pure Paystack body builder and answer mappers (B9, B12), the mock
// provider's scripted outcomes, the Paystack provider against a fake fetch, and that no authorization code, signature or
// email ever reaches a log line, an error message or a redacted body.
import assert from "node:assert/strict";
import crypto from "crypto";
import { SPRAY_CATALOGUE, SPRAY_TIERS, MIN_CHARGE_KOBO, sprayBreakdown, type SprayTier } from "../shared/money";
import { encryptToken, decryptToken, parsePaymentTokenKey, assertPaymentTokenKeyForBoot, TOKEN_DECRYPT_FAILED, TOKEN_KEY_MISSING } from "../server/payments/tokenCrypto";
import { makeSprayReference, looksLikeSprayReference, sprayReferenceBelongsTo, sprayReferenceSecret, sprayRefundNote, sprayReferenceForLog } from "../server/payments/sprayReference";
import { makeTicketReference, looksLikeTicketReference } from "../server/rooms/ticketReference";
import {
  buildChargeBody, buildSplitBody, redactChargeBody, splitNameFor, splitMatches, classifyDecline, mapChargeData, mapVerifyData,
  isTransactionNotFound, scrubProviderMessage, sprayMetadata, createPaystackSplitProvider, THREE_DS_FLOOR_KOBO, type ChargeBodyInput,
  callbackUrlAllowed, interactiveWithoutLink,
} from "../server/payments/paystackSplit";
import { THREE_DS_AT_KOBO } from "../shared/spray";
import { sanitizeMoneyError } from "../shared/roomRefunds";
import { MockSplitProvider } from "../server/payments/mockSplitProvider";
import { getSplitProvider, setSplitProviderForTests } from "../server/payments/splitProvider";

let passed = 0, failed = 0;
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>) => { queue.push({ name, fn }); };

// ---------------------------------------------------------------- fixtures
const SECRET = "test-secret-for-spray-refs";
const ROOM = "11111111-1111-4111-8111-111111111111";
const PAYER = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const GUEST = "44444444-4444-4444-8444-444444444444";
const HOST_ACCT = "ACCT_hosthost01";
const GUEST_ACCT = "ACCT_guestguest1";
const AUTH = "AUTH_secretcode42";
const EMAIL = "payer.private@example.com";
const ref = (tier: SprayTier = "bundle", to = HOST) => makeSprayReference(ROOM, PAYER, tier, to, SECRET);

function hostSplit(tier: SprayTier) { return { shares: [{ subaccountCode: HOST_ACCT, amountKobo: sprayBreakdown(tier).host }] }; }
function guestSplit(tier: SprayTier) {
  const b = sprayBreakdown(tier, true);
  return { shares: [{ subaccountCode: GUEST_ACCT, amountKobo: b.guest as number }, { subaccountCode: HOST_ACCT, amountKobo: b.host }] };
}
function body(over: Partial<ChargeBodyInput> = {}): ChargeBodyInput {
  return { kind: "charge_authorization", reference: ref(), email: EMAIL, amountKobo: SPRAY_CATALOGUE.bundle.kobo, currency: "NGN", split: hostSplit("bundle"), metadata: { roomId: ROOM, sprayId: "s1" }, authorizationCode: AUTH, ...over };
}

// Every console line written while provider code runs is kept here and checked for secrets.
const logged: string[] = [];
const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
function captureConsole(on: boolean) {
  if (on) {
    for (const k of ["log", "warn", "error", "info"] as const) (console as any)[k] = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  } else Object.assign(console, origConsole);
}
const SECRETS = [AUTH, "SIG_", EMAIL, "AUTH_mockcard0001"];
const assertNoSecrets = (s: string, what: string) => { for (const x of SECRETS) assert.ok(!s.includes(x), `${what} contains a secret (${x.slice(0, 5)}...)`); };

// ---------------------------------------------------------------- token crypto (B8)
const KEY = crypto.randomBytes(32).toString("base64");

test("crypto: round trip, v1 prefix, different ciphertext every time", () => {
  process.env.PAYMENT_TOKEN_KEY = KEY;
  const a = encryptToken(AUTH), b = encryptToken(AUTH);
  assert.ok(a.startsWith("v1:") && b.startsWith("v1:"));
  assert.notEqual(a, b);
  assert.ok(!a.includes(AUTH));
  assert.equal(decryptToken(a), AUTH);
  assert.equal(decryptToken(b), AUTH);
});

test("crypto: any flipped byte (iv, tag, ciphertext) fails closed with the generic error", () => {
  process.env.PAYMENT_TOKEN_KEY = KEY;
  const enc = encryptToken(AUTH);
  const raw = Buffer.from(enc.slice(3), "base64url");
  for (const i of [0, 11, 12, 27, 28, raw.length - 1]) {
    const t = Buffer.from(raw); t[i] ^= 0x01;
    assert.throws(() => decryptToken("v1:" + t.toString("base64url")), (e: Error) => e.message === TOKEN_DECRYPT_FAILED, `byte ${i}`);
  }
  assert.throws(() => decryptToken("v1:" + raw.subarray(0, raw.length - 1).toString("base64url")), /PAYMENT_TOKEN_DECRYPT_FAILED/);
});

test("crypto: wrong key, wrong key id, junk, empty (deleted card) all fail closed and never echo input", () => {
  process.env.PAYMENT_TOKEN_KEY = KEY;
  const enc = encryptToken(AUTH);
  process.env.PAYMENT_TOKEN_KEY = crypto.randomBytes(32).toString("base64");
  assert.throws(() => decryptToken(enc), (e: Error) => e.message === TOKEN_DECRYPT_FAILED && !e.message.includes(enc));
  process.env.PAYMENT_TOKEN_KEY = KEY;
  for (const bad of ["", "v2:" + enc.slice(3), "v1:", "v1:!!!!", "v1:AAAA", enc.slice(3)]) {
    assert.throws(() => decryptToken(bad), (e: Error) => e.message === TOKEN_DECRYPT_FAILED, JSON.stringify(bad));
  }
});

test("crypto: no key or a malformed key throws on use (never at import), never mentions the token", () => {
  for (const k of [undefined, "", "short", crypto.randomBytes(16).toString("base64"), crypto.randomBytes(33).toString("base64")]) {
    if (k === undefined) delete process.env.PAYMENT_TOKEN_KEY; else process.env.PAYMENT_TOKEN_KEY = k;
    assert.equal(parsePaymentTokenKey(process.env), null);
    assert.throws(() => encryptToken(AUTH), (e: Error) => e.message === TOKEN_KEY_MISSING && !e.message.includes(AUTH));
    assert.throws(() => decryptToken("v1:AAAA"), (e: Error) => e.message === TOKEN_KEY_MISSING);
  }
  process.env.PAYMENT_TOKEN_KEY = KEY;
  assert.ok(parsePaymentTokenKey(process.env));
});

test("crypto: boot rule, production with the flag OFF and no key still boots; flag ON and no key refuses", () => {
  assert.doesNotThrow(() => assertPaymentTokenKeyForBoot(false, { NODE_ENV: "production" } as NodeJS.ProcessEnv));
  assert.throws(() => assertPaymentTokenKeyForBoot(true, { NODE_ENV: "production" } as NodeJS.ProcessEnv), /Refusing to start/);
  assert.throws(() => assertPaymentTokenKeyForBoot(true, { NODE_ENV: "production", PAYMENT_TOKEN_KEY: "abc" } as NodeJS.ProcessEnv), /Refusing to start/);
  assert.doesNotThrow(() => assertPaymentTokenKeyForBoot(true, { NODE_ENV: "production", PAYMENT_TOKEN_KEY: KEY } as NodeJS.ProcessEnv));
  assert.doesNotThrow(() => assertPaymentTokenKeyForBoot(true, { NODE_ENV: "development" } as NodeJS.ProcessEnv));
});

// ---------------------------------------------------------------- spray reference (B4)
test("reference: shape, binds room, payer, tier and recipient", () => {
  const r = ref("bag", GUEST);
  assert.match(r, /^vib3rs_[0-9a-f]{24}_[0-9a-f]{32}$/);
  assert.ok(looksLikeSprayReference(r));
  assert.ok(sprayReferenceBelongsTo(r, ROOM, PAYER, "bag", GUEST, SECRET));
  assert.ok(!sprayReferenceBelongsTo(r, HOST, PAYER, "bag", GUEST, SECRET), "other room");
  assert.ok(!sprayReferenceBelongsTo(r, ROOM, HOST, "bag", GUEST, SECRET), "other payer");
  assert.ok(!sprayReferenceBelongsTo(r, ROOM, PAYER, "rain", GUEST, SECRET), "other tier");
  assert.ok(!sprayReferenceBelongsTo(r, ROOM, PAYER, "bag", HOST, SECRET), "other recipient");
  assert.ok(!sprayReferenceBelongsTo(r, ROOM, PAYER, "bag", GUEST, SECRET + "x"), "other secret");
  assert.ok(!sprayReferenceBelongsTo(r, ROOM, PAYER, "bag", GUEST, ""), "empty secret");
  assert.notEqual(ref(), ref(), "fresh nonce each time");
});

test("reference: forged MAC, ticket reference, junk are refused", () => {
  const r = ref();
  const forged = r.slice(0, -1) + (r.endsWith("0") ? "1" : "0");
  assert.ok(!sprayReferenceBelongsTo(forged, ROOM, PAYER, "bundle", HOST, SECRET));
  const ticket = makeTicketReference(ROOM, PAYER, SECRET);
  assert.ok(looksLikeTicketReference(ticket) && !looksLikeSprayReference(ticket));
  assert.ok(!looksLikeTicketReference(r));
  for (const j of [null, 42, "", "vib3rs_", r.toUpperCase(), r + "0", { r }]) assert.ok(!looksLikeSprayReference(j), String(j));
  assert.throws(() => makeSprayReference(ROOM, PAYER, "bundle", HOST, SECRET, "xyz"), /bad nonce/);
  assert.throws(() => makeSprayReference(ROOM, PAYER, "bundle", HOST, ""), /secret/);
});

test("reference: secret rule fails closed; refund note and log prefix", () => {
  assert.throws(() => sprayReferenceSecret({} as NodeJS.ProcessEnv), /must be set/);
  assert.equal(sprayReferenceSecret({ SESSION_SECRET: "s" } as NodeJS.ProcessEnv), "s");
  assert.equal(sprayReferenceSecret({ SESSION_SECRET: "s", ROOM_SPRAY_REF_SECRET: "r" } as NodeJS.ProcessEnv), "r");
  // fix round (ruling I4): the dedicated SPRAY_REF_SECRET wins over everything.
  assert.equal(sprayReferenceSecret({ SESSION_SECRET: "s", ROOM_SPRAY_REF_SECRET: "r", SPRAY_REF_SECRET: "d" } as NodeJS.ProcessEnv), "d");
  const r = ref();
  assert.equal(sprayRefundNote(r), `spray-refund-${r}`);
  assert.ok(sprayReferenceForLog(r).length < 20 && !sprayReferenceForLog(r).includes(r.slice(-10)));
});

// ---------------------------------------------------------------- buildChargeBody (pure)
test("body: every tier to the host, kobo exact, transaction_charge = price - host, bearer account", () => {
  assert.deepEqual([...SPRAY_TIERS], ["note", "bundle", "bag", "rain"]);
  for (const tier of SPRAY_TIERS) {
    const price = SPRAY_CATALOGUE[tier].kobo;
    const b = sprayBreakdown(tier);
    const out = buildChargeBody(body({ reference: ref(tier), amountKobo: price, split: hostSplit(tier) }));
    assert.equal(out.amount, price, tier);
    assert.equal(out.currency, "NGN");
    assert.equal(out.subaccount, HOST_ACCT);
    assert.equal(out.transaction_charge, price - b.host, tier);
    assert.equal((out.transaction_charge as number) + b.host, price);
    assert.ok(Number.isInteger(out.transaction_charge));
    assert.equal(out.bearer, "account");
    assert.equal(out.split_code, undefined);
    assert.equal((out.metadata as Record<string, string>).type, "spray");
  }
});

test("body: stage guest uses a split code and never subaccount / transaction_charge", () => {
  for (const tier of SPRAY_TIERS) {
    const out = buildChargeBody(body({ reference: ref(tier, GUEST), amountKobo: SPRAY_CATALOGUE[tier].kobo, split: guestSplit(tier), splitCode: "SPL_abcdef12" }));
    assert.equal(out.split_code, "SPL_abcdef12");
    assert.equal(out.subaccount, undefined);
    assert.equal(out.transaction_charge, undefined);
  }
  assert.throws(() => buildChargeBody(body({ split: guestSplit("bundle") })), /splitCode/);
  assert.throws(() => buildChargeBody(body({ splitCode: "SPL_abcdef12" })), /splitCode/);
});

test("body: initialize is card only with a callback and no authorization code", () => {
  const out = buildChargeBody(body({ kind: "initialize", authorizationCode: undefined, callbackUrl: "https://vib3pulse.test/rooms/r?spray=s1" }));
  assert.deepEqual(out.channels, ["card"]);
  assert.equal(out.callback_url, "https://vib3pulse.test/rooms/r?spray=s1");
  assert.equal(out.authorization_code, undefined);
  assert.throws(() => buildChargeBody(body({ kind: "initialize", callbackUrl: "https://x.test/" })), /authorizationCode/);
  assert.throws(() => buildChargeBody(body({ kind: "initialize", authorizationCode: undefined })), /callbackUrl/);
  assert.throws(() => buildChargeBody(body({ callbackUrl: "https://x.test/" })), /callbackUrl/);
});

test("body: anyMethod initialize sends NO channels (every Paystack method), keeps the split; never for charge_authorization", () => {
  const cb = "https://vib3pulse.test/rooms/r?spray=s1";
  const any = buildChargeBody(body({ kind: "initialize", authorizationCode: undefined, callbackUrl: cb, anyMethod: true }));
  assert.equal("channels" in any, false);
  assert.ok(any.subaccount && any.transaction_charge && any.bearer === "account"); // the split is untouched
  assert.deepEqual(buildChargeBody(body({ kind: "initialize", authorizationCode: undefined, callbackUrl: cb, anyMethod: false })).channels, ["card"]);
  assert.throws(() => buildChargeBody(body({ anyMethod: true })), /anyMethod/); // body() defaults to charge_authorization
});

test("body: refuses non-NGN, sub-minimum, fractional, bad shares, bad reference, bad metadata", () => {
  for (const c of ["GBP", "USD", "ngn", ""]) assert.throws(() => buildChargeBody(body({ currency: c })), RangeError, c);
  assert.throws(() => buildChargeBody(body({ amountKobo: MIN_CHARGE_KOBO - 1, split: { shares: [{ subaccountCode: HOST_ACCT, amountKobo: 100 }] } })), RangeError);
  assert.throws(() => buildChargeBody(body({ amountKobo: 100000.5 })), RangeError);
  const bad: Array<{ subaccountCode: string; amountKobo: number }[]> = [
    [], [{ subaccountCode: HOST_ACCT, amountKobo: 0 }], [{ subaccountCode: HOST_ACCT, amountKobo: -1 }],
    [{ subaccountCode: HOST_ACCT, amountKobo: 1.5 }], [{ subaccountCode: HOST_ACCT, amountKobo: 100001 }],
    [{ subaccountCode: "acct_lower", amountKobo: 10 }], [{ subaccountCode: "ACCT_x", amountKobo: 10 }],
    [{ subaccountCode: HOST_ACCT, amountKobo: 10 }, { subaccountCode: HOST_ACCT, amountKobo: 10 }],
    [{ subaccountCode: HOST_ACCT, amountKobo: 60000 }, { subaccountCode: GUEST_ACCT, amountKobo: 40001 }],
    [{ subaccountCode: HOST_ACCT, amountKobo: 1 }, { subaccountCode: GUEST_ACCT, amountKobo: 1 }, { subaccountCode: "ACCT_third001", amountKobo: 1 }],
  ];
  for (const shares of bad) assert.throws(() => buildChargeBody(body({ split: { shares }, splitCode: shares.length === 2 ? "SPL_abcdef12" : undefined })), RangeError, JSON.stringify(shares));
  // Two shares summing to exactly the price are allowed (at most price). One share equal to the price is NOT: it would
  // make transaction_charge 0, which Paystack may read as "not set" (fix round: transaction_charge never 0).
  assert.doesNotThrow(() => buildChargeBody(body({ split: { shares: [{ subaccountCode: HOST_ACCT, amountKobo: 60000 }, { subaccountCode: GUEST_ACCT, amountKobo: 40000 }] }, splitCode: "SPL_abcdef12" })));
  assert.throws(() => buildChargeBody(body({ split: { shares: [{ subaccountCode: HOST_ACCT, amountKobo: 100000 }] } })), /transaction_charge/);
  for (const r of ["vib3_123", makeTicketReference(ROOM, PAYER, SECRET), ""]) assert.throws(() => buildChargeBody(body({ reference: r })), /reference/);
  assert.throws(() => buildChargeBody(body({ authorizationCode: "nope" })), /authorizationCode/);
  assert.throws(() => buildChargeBody(body({ email: "not-an-email" })), /email/);
  for (const m of [{ authorization_code: "x" }, { authEnc: "x" }, { signature: "x" }, { email: "x" }, { "bad key": "x" }, { n: 5 as unknown as string }]) {
    assert.throws(() => buildChargeBody(body({ metadata: m as Record<string, string> })), /metadata/, JSON.stringify(Object.keys(m)));
  }
  assert.equal(sprayMetadata({ type: "ticket", roomId: "r" }).type, "spray", "type: spray always wins");
});

test("body: error messages and the redacted body never carry the code or the email", () => {
  for (const over of [{ currency: "GBP" }, { amountKobo: 1 }, { reference: "x" }, { authorizationCode: "AUTH_bad!" }, { email: "bad email@" }] as Partial<ChargeBodyInput>[]) {
    try { buildChargeBody(body(over)); assert.fail("should throw"); } catch (e) { assertNoSecrets((e as Error).message, "error"); }
  }
  const red = redactChargeBody(buildChargeBody(body()));
  assertNoSecrets(JSON.stringify(red), "redacted body");
  assert.equal(red.authorization_code, "[redacted]");
  assert.equal(red.amount, SPRAY_CATALOGUE.bundle.kobo);
});

// ---------------------------------------------------------------- split code + answer mappers
test("split: flat NGN, kobo shares, bearer account, stable name regardless of order", () => {
  const s = guestSplit("bag").shares;
  const b = buildSplitBody(s);
  assert.equal(b.type, "flat"); assert.equal(b.currency, "NGN"); assert.equal(b.bearer_type, "account");
  assert.deepEqual(b.subaccounts, s.map((x) => ({ subaccount: x.subaccountCode, share: x.amountKobo })));
  assert.equal(splitNameFor(s), splitNameFor([...s].reverse()));
  assert.notEqual(splitNameFor(s), splitNameFor(guestSplit("rain").shares));
  assert.throws(() => buildSplitBody(hostSplit("bag").shares), RangeError);
  const row = { split_code: "SPL_abcdef12", type: "flat", currency: "NGN", active: true, bearer_type: "account", subaccounts: s.map((x) => ({ subaccount: { subaccount_code: x.subaccountCode }, share: x.amountKobo })) };
  assert.ok(splitMatches(row, s));
  assert.ok(!splitMatches({ ...row, type: "percentage" }, s));
  assert.ok(!splitMatches({ ...row, active: false }, s));
  assert.ok(!splitMatches({ ...row, bearer_type: "subaccount" }, s));
  assert.ok(!splitMatches({ ...row, subaccounts: row.subaccounts.map((x, i) => (i ? { ...x, share: x.share + 1 } : x)) }, s));
});

test("mappers: charge answers; only success is success, unknown is NETWORK", () => {
  const r = ref();
  assert.deepEqual(mapChargeData(r, { status: "success", reference: r }), { status: "success", reference: r });
  assert.equal(mapChargeData(r, { status: "failed", reference: r, gateway_response: "Insufficient Funds" }).failure, "INSUFFICIENT_FUNDS");
  assert.equal(mapChargeData(r, { status: "failed", reference: r, gateway_response: "Declined" }).failure, "DECLINED");
  assert.equal(mapChargeData(r, { status: "failed", reference: r, gateway_response: "Authorization is not reusable" }).failure, "NOT_REUSABLE");
  for (const st of ["send_otp", "pending", "open_url", "", undefined]) assert.equal(mapChargeData(r, { status: st, reference: r }).failure, "NETWORK", String(st));
  // fix round (R1 I8 / ruling 12): a bank step WITH an https link is action_required carrying the link.
  assert.deepEqual(mapChargeData(r, { status: "open_url", reference: r, url: "https://bank.example/otp/1" }), { status: "action_required", reference: r, authorizationUrl: "https://bank.example/otp/1" });
  assert.equal(mapChargeData(r, { status: "send_otp", reference: r, authorization_url: "https://bank.example/otp/2" }).authorizationUrl, "https://bank.example/otp/2");
  assert.equal(mapChargeData(r, { status: "pending", paused: true, reference: r, authorization_url: "https://bank.example/p" }).status, "action_required");
  assert.equal(mapChargeData(r, { status: "open_url", reference: r, url: "http://bank.example/otp" }).failure, "NETWORK", "never an http link");
  assert.equal(mapChargeData(r, { status: "pending", reference: r, url: "https://bank.example/x" }).failure, "NETWORK", "a link without a bank step is not one");
  assert.ok(interactiveWithoutLink(r, { status: "send_otp", reference: r }));
  assert.ok(!interactiveWithoutLink(r, { status: "send_otp", reference: r, url: "https://bank.example/o" }));
  assert.ok(!interactiveWithoutLink(r, { status: "pending", reference: r }));
  assert.equal(mapChargeData(r, { status: "success", reference: ref() }).failure, "NETWORK", "someone else's reference");
  assert.equal(mapChargeData(r, null).failure, "NETWORK");
  assert.equal(classifyDecline(undefined), "DECLINED");
});

test("mappers: verify needs success + NGN + our reference; abandoned is pending, not failed", () => {
  const r = ref();
  const auth = { authorization_code: AUTH, last4: "4081", brand: "visa", bank: "TEST BANK", reusable: true, signature: "SIG_abc", channel: "card" };
  const ok = mapVerifyData(r, { status: "success", reference: r, amount: 100000, currency: "NGN", metadata: JSON.stringify({ type: "spray", roomId: ROOM, n: 5 }), authorization: auth });
  assert.equal(ok.paid, true); assert.equal(ok.state, "paid"); assert.equal(ok.amountKobo, 100000); assert.equal(ok.currency, "NGN");
  assert.deepEqual(ok.metadata, { type: "spray", roomId: ROOM }, "string metadata parsed, non-string values dropped");
  assert.equal(ok.authorization?.reusable, true); assert.equal(ok.authorization?.last4, "4081");
  // fix round (ruling 4 / R2 I2): a success in another currency, or with an amount that is not whole kobo, IS paid (money was
  // taken) with the real currency and amount, so the caller refunds it in full instead of marking it failed and keeping it.
  const ghs = mapVerifyData(r, { status: "success", reference: r, amount: 100000, currency: "GHS" });
  assert.equal(ghs.paid, true); assert.equal(ghs.state, "paid"); assert.equal(ghs.currency, "GHS"); assert.equal(ghs.amountKobo, 100000);
  assert.equal(mapVerifyData(r, { status: "success", reference: ref(), amount: 100000, currency: "NGN" }).paid, false);
  const oddAmount = mapVerifyData(r, { status: "success", reference: r, amount: "100000", currency: "NGN" });
  assert.equal(oddAmount.paid, true); assert.equal(oddAmount.amountKobo, 0, "never equal to a stored price, so it is refunded");
  assert.equal(mapVerifyData(r, { status: "success", reference: r, amount: 100000.5, currency: "NGN" }).amountKobo, 0);
  assert.equal(ok.authorization?.authorizationCode, AUTH, "the code travels as authorizationCode (a redacted key), never `code`");
  assert.ok(!("code" in (ok.authorization ?? {})));
  assert.equal(mapVerifyData(r, { status: "abandoned", reference: r, amount: 100000, currency: "NGN" }).state, "pending");
  assert.equal(mapVerifyData(r, { status: "failed", reference: r, amount: 100000, currency: "NGN" }).state, "failed");
  assert.equal(mapVerifyData(r, { status: "reversed", reference: r, amount: 100000, currency: "NGN" }).state, "failed");
  assert.equal(mapVerifyData(r, { status: "success", reference: r, amount: 100000, currency: "NGN", authorization: { ...auth, channel: "bank" } }).authorization?.reusable, false);
  assert.equal(mapVerifyData(r, { status: "success", reference: r, amount: 100000, currency: "NGN", authorization: { ...auth, reusable: "true" } }).authorization?.reusable, false);
  assert.ok(isTransactionNotFound({ httpStatus: 400, message: "Transaction reference not found" }));
  assert.ok(!isTransactionNotFound({ httpStatus: 401, message: "Invalid key" }));
  assert.ok(!isTransactionNotFound({ httpStatus: 400, message: "Bad request" }));
});

test("scrub: provider messages lose codes, emails and long numbers", () => {
  const s = scrubProviderMessage(`Card ${AUTH} for ${EMAIL} account 0123456789 SIG_xyz failed`);
  // The scrubber keeps the bare "SIG_" / "AUTH_" prefix as a marker ("SIG_[redacted]"); the VALUES must be gone.
  for (const x of [AUTH, EMAIL, "SIG_xyz", "xyz", "secretcode42"]) assert.ok(!s.includes(x), `scrubbed contains a secret (${x.slice(0, 5)}...)`);
  assert.doesNotMatch(s, /SIG_(?!\[redacted\])|AUTH_(?!\[redacted\])/, "a signature or code prefix not followed by [redacted]");
  assert.ok(!s.includes("0123456789"));
  assert.ok(scrubProviderMessage("x".repeat(500)).length <= 120);
});

// ---------------------------------------------------------------- mock provider
const firstPay = (m: MockSplitProvider, tier: SprayTier, r: string) =>
  m.startFirstPayment({ reference: r, email: EMAIL, amountKobo: SPRAY_CATALOGUE[tier].kobo, split: hostSplit(tier), metadata: { roomId: ROOM }, callbackUrl: "https://vib3pulse.test/cb" });
const saved = (m: MockSplitProvider, tier: SprayTier, r: string, force3ds = false) =>
  m.chargeSaved({ reference: r, email: EMAIL, amountKobo: SPRAY_CATALOGUE[tier].kobo, authorizationCode: AUTH, split: hostSplit(tier), metadata: { roomId: ROOM }, force3ds, callbackUrl: "https://vib3pulse.test/cb" });

test("mock: scripted outcomes success, declined, insufficient, not reusable, network", async () => {
  const m = new MockSplitProvider();
  m.nextCharge.push("success", "declined", "insufficient", "not_reusable", "network");
  const r1 = ref("note"), r2 = ref("note"), r3 = ref("note"), r4 = ref("note"), r5 = ref("note");
  assert.equal((await saved(m, "note", r1)).status, "success");
  assert.equal((await saved(m, "note", r2)).failure, "DECLINED");
  assert.equal((await saved(m, "note", r3)).failure, "INSUFFICIENT_FUNDS");
  assert.equal((await saved(m, "note", r4)).failure, "NOT_REUSABLE");
  assert.equal((await saved(m, "note", r5)).failure, "NETWORK");
  assert.equal((await m.verify(r1))?.paid, true);
  assert.equal((await m.verify(r2))?.state, "failed");
  assert.equal((await m.verify(r5))?.state, "pending", "network = unknown, not failed");
  assert.equal(await m.verify(ref()), null, "unknown reference");
  for (const c of m.calls) assertNoSecrets(JSON.stringify(c), "recorded call");
});

test("mock: bag and rain never charge silently (3D Secure), force3ds too", async () => {
  const m = new MockSplitProvider();
  for (const tier of ["bag", "rain"] as SprayTier[]) {
    assert.ok(SPRAY_CATALOGUE[tier].kobo >= THREE_DS_FLOOR_KOBO);
    const r = ref(tier);
    const res = await saved(m, tier, r);
    assert.equal(res.status, "action_required"); assert.ok(res.authorizationUrl);
    assert.equal((await m.verify(r))?.paid, false);
    m.completeCheckout(r);
    assert.equal((await m.verify(r))?.paid, true);
  }
  assert.equal((await saved(m, "bundle", ref(), true)).status, "action_required");
  await assert.rejects(m.chargeSaved({ reference: ref("bag"), email: EMAIL, amountKobo: SPRAY_CATALOGUE.bag.kobo, authorizationCode: AUTH, split: hostSplit("bag"), metadata: {}, force3ds: true }), /callbackUrl/);
});

test("mock: first payment, refund recorded once, processed, verify then says failed", async () => {
  const m = new MockSplitProvider();
  const r = ref();
  const { url } = await firstPay(m, "bundle", r);
  assert.ok(url.includes(r));
  m.completeCheckout(r, { reusable: true });
  const v = await m.verify(r);
  assert.equal(v?.paid, true); assert.equal(v?.authorization?.reusable, true); assert.equal(v?.metadata.type, "spray");
  await m.refund(r); await m.refund(r);
  assert.deepEqual(m.refunds, [r], "one refund only");
  assert.equal(await m.refundState(r), "in_progress");
  assert.equal(m.processRefunds(), 1);
  assert.equal(await m.refundState(r), "done");
  assert.equal((await m.verify(r))?.state, "failed");
  m.refundMode = "outage";
  await assert.rejects(m.refund(ref()), /Paystack unavailable/);
  m.refundMode = "fail";
  await assert.rejects(m.refund(r), /Paystack error/);
});

test("mock: tampered currency / amount and foreign payments", async () => {
  const m = new MockSplitProvider();
  const r = ref();
  await firstPay(m, "bundle", r); m.completeCheckout(r);
  m.tamper(r, { currency: "GHS" });
  // Same contract as Paystack (fix round): paid with the real currency; the caller compares and refunds.
  assert.equal((await m.verify(r))?.paid, true);
  assert.equal((await m.verify(r))?.currency, "GHS");
  m.tamper(r, { currency: "NGN", amountKobo: 1 });
  assert.equal((await m.verify(r))?.amountKobo, 1, "the caller compares with the stored row");
  const forged = ref().replace(/_[0-9a-f]{32}$/, "_" + "0".repeat(32));
  m.injectForeignPayment(forged, 100000, { type: "spray", roomId: ROOM });
  assert.equal((await m.verify(forged))?.paid, true, "the provider says paid...");
  assert.ok(!sprayReferenceBelongsTo(forged, ROOM, PAYER, "bundle", HOST, SECRET), "...but the forged reference fails the MAC check");
  m.verifyMode = "outage";
  await assert.rejects(m.verify(r), /Paystack unavailable/);
});

test("mock and seam: refused in production; override returned; mock not chosen by default", () => {
  const prev = process.env.NODE_ENV;
  const m = new MockSplitProvider();
  setSplitProviderForTests(m);
  assert.equal(getSplitProvider(), m);
  setSplitProviderForTests(null);
  const prevProvider = process.env.SPRAY_PROVIDER;
  delete process.env.SPRAY_PROVIDER;
  assert.ok(!(getSplitProvider() instanceof MockSplitProvider), "default is the real provider, never the mock");
  process.env.SPRAY_PROVIDER = "mock";
  assert.ok(getSplitProvider() instanceof MockSplitProvider);
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => new MockSplitProvider(), /not allowed in production/);
    assert.throws(() => setSplitProviderForTests(m), /not allowed in production/);
    assert.ok(!(getSplitProvider() instanceof MockSplitProvider), "SPRAY_PROVIDER=mock is ignored in production");
  } finally {
    process.env.NODE_ENV = prev;
    if (prevProvider === undefined) delete process.env.SPRAY_PROVIDER; else process.env.SPRAY_PROVIDER = prevProvider;
  }
});

// ---------------------------------------------------------------- Paystack provider against a fake fetch
type Route = (url: string, init: RequestInit | undefined) => { status: number; body: unknown } | "throw";
const sent: Array<{ url: string; method: string; body: any }> = [];
function withFetch(route: Route) {
  sent.length = 0;
  captureConsole(true); // restored after each test by the runner
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = route(url, init);
    if (r === "throw") throw new Error("ECONNRESET");
    return { status: r.status, json: async () => r.body } as unknown as Response;
  };
}
const realFetch = globalThis.fetch;

test("paystack: saved card to the host posts one charge_authorization with the exact body", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const r = ref();
  withFetch((url) => url.endsWith("/transaction/charge_authorization") ? { status: 200, body: { status: true, data: { status: "success", reference: r } } } : { status: 404, body: { status: false, message: "no" } });
  captureConsole(true);
  const res = await createPaystackSplitProvider().chargeSaved({ reference: r, email: EMAIL, amountKobo: 100000, authorizationCode: AUTH, split: hostSplit("bundle"), metadata: { roomId: ROOM }, force3ds: false });
  captureConsole(false);
  assert.equal(res.status, "success");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.transaction_charge, 100000 - sprayBreakdown("bundle").host);
  assert.equal(sent[0].body.authorization_code, AUTH);
  assert.equal(sent[0].body.currency, "NGN");
});

test("paystack: stage guest finds or creates the flat split, then charges with split_code", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const r = ref("bundle", GUEST);
  const shares = guestSplit("bundle").shares;
  withFetch((url, init) => {
    if (url.includes("/split?name=")) return { status: 200, body: { status: true, data: [] } };
    if (url.endsWith("/split") && init?.method === "POST") return { status: 200, body: { status: true, data: { split_code: "SPL_newsplit01", type: "flat", currency: "NGN", active: true, bearer_type: "account", subaccounts: shares.map((s) => ({ subaccount: { subaccount_code: s.subaccountCode }, share: s.amountKobo })) } } };
    if (url.endsWith("/transaction/charge_authorization")) return { status: 200, body: { status: true, data: { status: "success", reference: r } } };
    return { status: 404, body: { status: false, message: "no" } };
  });
  const p = createPaystackSplitProvider();
  const res = await p.chargeSaved({ reference: r, email: EMAIL, amountKobo: 100000, authorizationCode: AUTH, split: { shares }, metadata: {}, force3ds: false });
  assert.equal(res.status, "success");
  assert.deepEqual(sent.map((s) => s.method), ["GET", "POST", "POST"]);
  assert.equal(sent[1].body.type, "flat");
  assert.equal(sent[2].body.split_code, "SPL_newsplit01");
  assert.equal(sent[2].body.subaccount, undefined);
  // second spray with the same shares reuses the cached code: one call only
  const r2 = ref("bundle", GUEST);
  withFetch((url) => url.endsWith("/transaction/charge_authorization") ? { status: 200, body: { status: true, data: { status: "success", reference: r2 } } } : { status: 500, body: {} });
  assert.equal((await p.chargeSaved({ reference: r2, email: EMAIL, amountKobo: 100000, authorizationCode: AUTH, split: { shares }, metadata: {}, force3ds: false })).status, "success");
  assert.equal(sent.length, 1);
});

test("paystack: declines, duplicate reference resolved by verify, outage stays unknown", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const p = createPaystackSplitProvider();
  const args = (r: string) => ({ reference: r, email: EMAIL, amountKobo: 100000, authorizationCode: AUTH, split: hostSplit("bundle"), metadata: {}, force3ds: false });
  let r = ref();
  withFetch(() => ({ status: 400, body: { status: false, message: "Insufficient Funds" } }));
  assert.equal((await p.chargeSaved(args(r))).failure, "INSUFFICIENT_FUNDS");
  r = ref();
  withFetch((url) => url.includes("/transaction/verify/")
    ? { status: 200, body: { status: true, data: { status: "success", reference: r, amount: 100000, currency: "NGN" } } }
    : { status: 400, body: { status: false, message: "Duplicate Transaction Reference" } });
  assert.equal((await p.chargeSaved(args(r))).status, "success", "an earlier attempt already charged: success, never a second charge");
  r = ref();
  withFetch((url) => url.includes("/transaction/verify/") ? { status: 400, body: { status: false, message: "Transaction reference not found" } } : { status: 400, body: { status: false, message: "Something odd" } });
  assert.equal((await p.chargeSaved(args(r))).failure, "DECLINED", "refused and nothing created");
  r = ref();
  withFetch(() => "throw");
  assert.equal((await p.chargeSaved(args(r))).failure, "NETWORK", "outage = unknown");
  r = ref();
  withFetch((url) => url.includes("/transaction/verify/") ? { status: 400, body: { status: false, message: "Transaction reference not found" } } : "throw");
  assert.equal((await p.chargeSaved(args(r))).failure, "NETWORK", "outage then not found: still unknown (it may land late)");
  withFetch(() => ({ status: 502, body: { status: false, message: "bad gateway" } }));
  await assert.rejects(p.verify(ref()), /Paystack unavailable/);
  withFetch(() => ({ status: 401, body: { status: false, message: "Invalid key" } }));
  await assert.rejects(p.verify(ref()), /Paystack error/);
  sent.length = 0;
  assert.equal(await p.verify("not-a-spray-ref"), null);
  assert.equal(sent.length, 0, "a junk reference never reaches Paystack");
});

test("paystack: 3D Secure tier starts a card checkout, never charge_authorization", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const r = ref("bag");
  withFetch((url) => url.endsWith("/transaction/initialize") ? { status: 200, body: { status: true, data: { authorization_url: "https://checkout.paystack.com/abc", reference: r } } } : { status: 404, body: { status: false } });
  const res = await createPaystackSplitProvider().chargeSaved({ reference: r, email: EMAIL, amountKobo: SPRAY_CATALOGUE.bag.kobo, authorizationCode: AUTH, split: hostSplit("bag"), metadata: {}, force3ds: false, callbackUrl: "https://vib3pulse.test/cb" });
  assert.equal(res.status, "action_required");
  assert.equal(res.authorizationUrl, "https://checkout.paystack.com/abc");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.endsWith("/transaction/initialize"));
  assert.equal(sent[0].body.authorization_code, undefined, "the saved card code is not sent to a checkout");
  assert.deepEqual(sent[0].body.channels, ["card"]);
});

test("paystack: refund looks up first and never refunds twice", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const r = ref();
  let refundStatus: string | null = null;
  withFetch((url, init) => {
    if (url.includes("/transaction/verify/")) return { status: 200, body: { status: true, data: { id: 77, status: "success", reference: r } } };
    if (url.includes("/refund?transaction=")) return { status: 200, body: { status: true, data: refundStatus ? [{ status: refundStatus, transaction: 77 }] : [] } };
    if (url.endsWith("/refund") && init?.method === "POST") return { status: 200, body: { status: true, data: {} } };
    return { status: 404, body: { status: false, message: "no" } };
  });
  const p = createPaystackSplitProvider();
  await p.refund(r);
  assert.equal(sent.filter((s) => s.method === "POST").length, 1);
  assert.equal(sent.find((s) => s.method === "POST")?.body.merchant_note, sprayRefundNote(r));
  refundStatus = "pending";
  sent.length = 0;
  await p.refund(r);
  assert.equal(sent.filter((s) => s.method === "POST").length, 0, "in progress: no second refund");
  assert.equal(await p.refundState(r), "in_progress");
  refundStatus = "processed";
  assert.equal(await p.refundState(r), "done");
});

// ---------------------------------------------------------------- fix round
test("fix round: one 3D Secure constant; transaction_charge never 0; https callback only", () => {
  assert.equal(THREE_DS_FLOOR_KOBO, THREE_DS_AT_KOBO);
  const price = SPRAY_CATALOGUE.bundle.kobo;
  assert.throws(() => buildChargeBody(body({ split: { shares: [{ subaccountCode: HOST_ACCT, amountKobo: price }] } })), /transaction_charge/);
  assert.ok(callbackUrlAllowed("https://vib3pulse.test/rooms/r?spray=s"));
  assert.ok(!callbackUrlAllowed("http://vib3pulse.test/rooms/r"), "plain http to a public host");
  assert.ok(callbackUrlAllowed("http://127.0.0.1:5000/rooms/r", { NODE_ENV: "test" } as NodeJS.ProcessEnv), "local dev and the test server");
  assert.ok(!callbackUrlAllowed("http://127.0.0.1:5000/rooms/r", { NODE_ENV: "production" } as NodeJS.ProcessEnv));
  assert.ok(!callbackUrlAllowed("javascript:alert(1)"));
  assert.throws(() => buildChargeBody(body({ kind: "initialize", authorizationCode: undefined, callbackUrl: "http://evil.example/x" })), /callbackUrl/);
});

test("fix round: sanitizeMoneyError scrubs card codes, signatures and emails", () => {
  const s = sanitizeMoneyError(new Error(`charge ${AUTH} SIG_abc123 for ${EMAIL} acct 0123456789`));
  for (const x of [AUTH, "SIG_abc123", EMAIL, "0123456789"]) assert.ok(!s.includes(x), x.slice(0, 5));
  assert.match(s, /AUTH_\[redacted\]/);
});

test("paystack: a saved-card charge that needs an OTP page answers action_required with the bank link", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const r = ref("note");
  withFetch((url) => url.endsWith("/transaction/charge_authorization")
    ? { status: 200, body: { status: true, data: { status: "open_url", reference: r, url: "https://bank.example/3ds/abc" } } }
    : { status: 404, body: { status: false, message: "no" } });
  const res = await createPaystackSplitProvider().chargeSaved({ reference: r, email: EMAIL, amountKobo: SPRAY_CATALOGUE.note.kobo, authorizationCode: AUTH, split: hostSplit("note"), metadata: {}, force3ds: false });
  assert.deepEqual(res, { status: "action_required", reference: r, authorizationUrl: "https://bank.example/3ds/abc" });
});

test("paystack: an OTP step without a link is NOT_REUSABLE once verify shows nothing final", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const r = ref("note");
  withFetch((url) => url.endsWith("/transaction/charge_authorization")
    ? { status: 200, body: { status: true, data: { status: "send_otp", reference: r } } }
    : url.includes("/transaction/verify/") ? { status: 200, body: { status: true, data: { status: "ongoing", reference: r, amount: 50000, currency: "NGN" } } }
    : { status: 404, body: { status: false, message: "no" } });
  const res = await createPaystackSplitProvider().chargeSaved({ reference: r, email: EMAIL, amountKobo: SPRAY_CATALOGUE.note.kobo, authorizationCode: AUTH, split: hostSplit("note"), metadata: {}, force3ds: false });
  assert.equal(res.status, "failed"); assert.equal(res.failure, "NOT_REUSABLE");
});

test("paystack: a processed refund for less than the full amount is needs_attention, never done (R1 M3)", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_never_real";
  const r = ref();
  let rows: unknown[] = [{ status: "processed", transaction: 77, amount: 40000 }];
  withFetch((url) => {
    if (url.includes("/transaction/verify/")) return { status: 200, body: { status: true, data: { id: 77, status: "success", reference: r } } };
    if (url.includes("/refund?transaction=")) return { status: 200, body: { status: true, data: rows } };
    return { status: 404, body: { status: false, message: "no" } };
  });
  const p = createPaystackSplitProvider();
  assert.equal(await p.refundState(r, 100000), "needs_attention");
  rows = [{ status: "processed", transaction: 77, amount: 40000 }, { status: "processed", transaction: 77, amount: 60000 }];
  assert.equal(await p.refundState(r, 100000), "done");
  rows = [{ status: "processed", transaction: 77 }];
  assert.equal(await p.refundState(r, 100000), "needs_attention", "no amount reported: a person checks");
  assert.equal(await p.refundState(r), "done", "without the full amount: the phase 4 behaviour");
});

test("logs: no provider call wrote an authorization code, signature or email to the console", () => {
  for (const line of logged) assertNoSecrets(line, "console line");
});

// ---------------------------------------------------------------- run
(async () => {
  for (const t of queue) {
    try { await t.fn(); passed++; console.log(`PASS ${t.name}`); }
    catch (e: any) { failed++; console.log(`FAIL ${t.name}  ${String(e?.message ?? e).split("\n")[0]}`); }
    finally { captureConsole(false); }
  }
  (globalThis as any).fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
