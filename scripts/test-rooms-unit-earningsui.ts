// Room money screens on the client (phase 6, tasks 6.1 to 6.3, lane P6-BC): parsers, outcome words, fixtures and
// source checks (no database, no browser):
//   npx tsx scripts/test-rooms-unit-earningsui.ts
// Written, not run (owner's no-testing rule for phase 6). Runs under npm run test:rooms with the other unit suites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EARNINGS_UI_COPY, PAYOUT_ERROR, accountNeedsRefetch, accountNumberValid, cleanAccountNumber, earningsEmpty, earningsHeadline,
  isEarningsRange, mergePayments, parseBanks, parseEarnings, parsePaymentsPage, parsePayoutStatus, paymentStatusWord, payoutErrorMessage,
  payoutReady, payoutStage, receiptIdOk, receiptUrl, roomKindLine, savedAccountOf,
} from "../client/src/components/rooms/earnings/earningsUi";
import {
  EARN_SCENES, FIXTURE_BANKS, FIXTURE_SAVED_STATUS, fixtureEarnings, fixturePayments, fixturePayoutStatus, parseEarnFixture,
} from "../client/src/components/rooms/earnings/earningsFixtures";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

const READY = { verifiedAdult: true, account: { bankName: "GTBank", last4: "4821", nameMatches: true }, subaccountReady: true };

// ---------------------------------------------------------------- payout status
test("status: the plan's shape parses; extra fields (a name, a full number) are never kept", () => {
  const s = parsePayoutStatus({ ...READY, account: { ...READY.account, accountName: "ADA OBI", accountNumber: "0123454821" } });
  assert.deepEqual(s, READY);
  assert.equal(JSON.stringify(s).includes("ADA"), false);
  assert.equal(JSON.stringify(s).includes("0123454821"), false);
  assert.deepEqual(parsePayoutStatus({ verifiedAdult: false, account: null, subaccountReady: false }), { verifiedAdult: false, account: null, subaccountReady: false });
  assert.deepEqual(parsePayoutStatus({ verifiedAdult: true, subaccountReady: false })?.account, null, "a missing account is no account");
});
test("status: last4 that is not exactly four digits fails the whole status (a full number is never drawn)", () => {
  for (const last4 of ["0123454821", "482", "48a1", 4821, "", null]) {
    assert.equal(parsePayoutStatus({ ...READY, account: { ...READY.account, last4 } }), null, String(last4));
  }
  assert.equal(parsePayoutStatus({ ...READY, verifiedAdult: "yes" }), null);
  assert.equal(parsePayoutStatus({ ...READY, account: { ...READY.account, nameMatches: "true" } }), null);
  assert.equal(parsePayoutStatus({ ...READY, account: { ...READY.account, bankName: "" } }), null);
  assert.equal(parsePayoutStatus(null), null);
  assert.equal(parsePayoutStatus([]), null);
});
test("stage: unverified first, then none, mismatch, pending, ready; only ready can receive", () => {
  assert.equal(payoutStage({ ...READY, verifiedAdult: false }), "unverified");
  assert.equal(payoutStage({ ...READY, account: null }), "none");
  assert.equal(payoutStage({ ...READY, account: { ...READY.account, nameMatches: false } }), "mismatch");
  assert.equal(payoutStage({ ...READY, subaccountReady: false }), "pending");
  assert.equal(payoutStage(READY), "ready");
  assert.equal(payoutReady(READY), true);
  assert.equal(payoutReady({ ...READY, account: { ...READY.account, nameMatches: false }, subaccountReady: true }), false);
  assert.equal(payoutReady(null), false);
});
test("account number: ten digits after spaces and dashes come out", () => {
  assert.equal(accountNumberValid("0123456789"), true);
  assert.equal(accountNumberValid("012 345 6789"), true);
  assert.equal(cleanAccountNumber("012-345 6789"), "0123456789");
  for (const bad of ["012345678", "01234567890", "01234a6789", ""]) assert.equal(accountNumberValid(bad), false, bad);
});
test("save refusals in plain words; NO_VERIFIED_NAME and NAME_MISMATCH by code; the server's text never shown", () => {
  assert.equal(payoutErrorMessage({ status: 0 }), PAYOUT_ERROR.offline);
  assert.equal(payoutErrorMessage({ status: 401 }), PAYOUT_ERROR.signIn);
  assert.equal(payoutErrorMessage({ status: 403 }), PAYOUT_ERROR.unverified);
  assert.equal(payoutErrorMessage({ status: 422, code: "NAME_MISMATCH" }), PAYOUT_ERROR.nameMismatch);
  assert.equal(payoutErrorMessage({ status: 422 }), PAYOUT_ERROR.nameMismatch);
  assert.equal(payoutErrorMessage({ status: 422, code: "NO_VERIFIED_NAME" }), PAYOUT_ERROR.noVerifiedName);
  assert.equal(payoutErrorMessage({ status: 409, code: "NO_VERIFIED_NAME" }), PAYOUT_ERROR.noVerifiedName);
  assert.equal(payoutErrorMessage({ status: 429 }), PAYOUT_ERROR.rateLimited);
  assert.equal(payoutErrorMessage({ status: 429, retryAfterSec: 1800 }), PAYOUT_ERROR.rateLimitedFor(30));
  assert.equal(payoutErrorMessage({ status: 429, retryAfterSec: 20 }), PAYOUT_ERROR.rateLimitedFor(1));
  assert.equal(payoutErrorMessage({ status: 409, code: "PAYOUT_IN_FLIGHT" }), PAYOUT_ERROR.inFlight);
  assert.equal(payoutErrorMessage({ status: 409 }), PAYOUT_ERROR.busy);
  assert.equal(payoutErrorMessage({ status: 400 }), PAYOUT_ERROR.notFound);
  assert.equal(payoutErrorMessage({ status: 502 }), PAYOUT_ERROR.provider);
  assert.equal(payoutErrorMessage({ status: 404, code: "FEATURE_OFF" }), PAYOUT_ERROR.featureOff);
  assert.equal(payoutErrorMessage({ status: 500 }), PAYOUT_ERROR.generic);
  assert.equal(accountNeedsRefetch({ status: 0 }), true);
  assert.equal(accountNeedsRefetch({ status: 502 }), true);
  assert.equal(accountNeedsRefetch({ status: 422 }), false);
});
test("save answer: last four from the status shape or { account }; nothing else is read", () => {
  assert.equal(savedAccountOf(READY)?.last4, "4821");
  assert.equal(savedAccountOf({ account: READY.account })?.last4, "4821");
  assert.equal(savedAccountOf({ ok: true }), null);
  assert.equal(savedAccountOf({ account: { ...READY.account, last4: "0123454821" } }), null);
});
test("banks: bad rows dropped, duplicates once, sorted by name; a bad body is null", () => {
  const b = parseBanks({ banks: [{ name: "Zenith", code: "057" }, { name: "Access", code: "044" }, { name: "x", code: "<script>" }, { name: "Dup", code: "057" }, null] })!;
  assert.deepEqual(b.map((x) => x.code), ["044", "057"]);
  assert.equal(parseBanks({}), null);
  assert.equal(parseBanks(null), null);
});

// ---------------------------------------------------------------- earnings
const WEEK = {
  totals: { sprayKobo: 10_063_500, ticketKobo: 14_296_500 }, settledKobo: 8_843_500, onItsWayKobo: 1_220_000, heldTicketKobo: 14_296_500,
  clawbackOpenKobo: 0, byRoom: [{ roomId: "r1", title: "Amapiano", sprayKobo: 6_763_500, ticketKobo: 14_296_500, at: "2026-10-19T20:00:00.000Z" }],
  nextTicketReleaseAt: null,
};
test("earnings: the plan's shape parses; the headline is spray plus ticket totals as sent", () => {
  const e = parseEarnings(WEEK)!;
  assert.ok(e);
  assert.equal(earningsHeadline(e), 24_360_000);
  assert.equal(earningsEmpty(e), false);
  assert.equal(parseEarnings({ ...WEEK, nextTicketReleaseAt: undefined })?.nextTicketReleaseAt, null);
});
test("earnings: totals may be negative (a week of refunds); the four balances may not; floats and strings fail", () => {
  assert.ok(parseEarnings({ ...WEEK, totals: { sprayKobo: -500, ticketKobo: 0 } }));
  for (const k of ["settledKobo", "onItsWayKobo", "heldTicketKobo", "clawbackOpenKobo"]) {
    assert.equal(parseEarnings({ ...WEEK, [k]: -1 }), null, k);
    assert.equal(parseEarnings({ ...WEEK, [k]: 1.5 }), null, k);
    assert.equal(parseEarnings({ ...WEEK, [k]: "100" }), null, k);
  }
  assert.equal(parseEarnings({ ...WEEK, totals: { sprayKobo: 2 ** 60, ticketKobo: 0 } }), null);
  assert.equal(parseEarnings({ ...WEEK, byRoom: [{ ...WEEK.byRoom[0], roomId: "../x" }] }), null, "a room id goes into a link");
  assert.equal(parseEarnings({ ...WEEK, byRoom: [{ ...WEEK.byRoom[0], at: "soon" }] }), null);
  assert.equal(parseEarnings({ ...WEEK, nextTicketReleaseAt: "later" }), null);
  assert.equal(parseEarnings({ ...WEEK, byRoom: "x" }), null);
});
test("earnings: room lines and the empty state", () => {
  assert.equal(roomKindLine({ sprayKobo: 1, ticketKobo: 1 }), "Tickets and sprays");
  assert.equal(roomKindLine({ sprayKobo: 0, ticketKobo: 1 }), "Tickets");
  assert.equal(roomKindLine({ sprayKobo: 1, ticketKobo: 0 }), "Sprays");
  assert.equal(earningsEmpty(parseEarnings(fixtureEarnings("empty", "week", 0))!), true);
  assert.equal(parseEarnings({ ...WEEK, byRoom: [{ ...WEEK.byRoom[0], title: null }] })?.byRoom[0].title, "A room");
  assert.equal(isEarningsRange("week") && isEarningsRange("all") && !isEarningsRange("year"), true);
});

// ---------------------------------------------------------------- payments
const P1 = { items: [{ id: "a1", kind: "ticket", title: "T", amountKobo: 500_000, vatKobo: 34_884, at: "2026-10-19T20:00:00.000Z", status: "paid" }], next: "c2" };
test("payments: shape parses; refunds are never above zero, payments never below; VAT same sign and not above the amount", () => {
  assert.equal(parsePaymentsPage(P1)?.next, "c2");
  const refund = { ...P1.items[0], id: "r1", kind: "refund", amountKobo: -500_000, vatKobo: -34_884, status: "processed" };
  assert.equal(parsePaymentsPage({ items: [refund], next: null })?.items[0].amountKobo, -500_000);
  assert.ok(parsePaymentsPage({ items: [{ ...refund, vatKobo: 0 }], next: null }));
  assert.equal(parsePaymentsPage({ items: [{ ...refund, amountKobo: 500_000 }], next: null }), null);
  assert.equal(parsePaymentsPage({ items: [{ ...P1.items[0], amountKobo: -1 }], next: null }), null);
  assert.equal(parsePaymentsPage({ items: [{ ...P1.items[0], vatKobo: 600_000 }], next: null }), null);
  assert.equal(parsePaymentsPage({ items: [{ ...P1.items[0], kind: "payout" }], next: null }), null);
  assert.equal(parsePaymentsPage({ items: [{ ...P1.items[0], id: "a/../b" }], next: null }), null);
  assert.equal(parsePaymentsPage({ items: [], next: 5 }), null);
  assert.equal(parsePaymentsPage({ items: [{ ...P1.items[0], status: "Paid <b>" }], next: null })?.items[0].status, "", "an odd status shows nothing");
});
test("payments: pages merge in order with each row once; the receipt URL is the viewer's own route, id encoded", () => {
  const a = parsePaymentsPage(P1)!;
  const b = parsePaymentsPage({ items: [P1.items[0], { ...P1.items[0], id: "a0" }], next: null })!;
  assert.deepEqual(mergePayments([a, b]).map((x) => x.id), ["a1", "a0"]);
  assert.equal(receiptUrl("rtk_1"), "/api/users/me/room-payments/rtk_1/receipt");
  assert.equal(receiptIdOk("rtk_1"), true);
  assert.equal(receiptIdOk("../x"), false);
  assert.equal(paymentStatusWord("ticket", "paid"), "Paid");
  assert.equal(paymentStatusWord("refund", "pending"), "On its way back to your card");
  assert.equal(paymentStatusWord("ticket", "whatever"), "");
});

// ---------------------------------------------------------------- fixtures
test("fixture scenes parse and every scene's data has the routes' real shape", () => {
  assert.deepEqual(parseEarnFixture("?earn=week"), { scene: "week", page: "earnings" });
  assert.deepEqual(parseEarnFixture("?earn=mismatch"), { scene: "mismatch", page: "payouts" });
  assert.deepEqual(parseEarnFixture("?earn=empty&page=payments"), { scene: "empty", page: "payments" });
  assert.equal(parseEarnFixture("?earn=nope"), null);
  assert.equal(parseEarnFixture(""), null);
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  for (const s of EARN_SCENES) {
    assert.ok(parsePayoutStatus(fixturePayoutStatus(s)), `status ${s}`);
    for (const r of ["week", "month", "all"]) assert.ok(parseEarnings(fixtureEarnings(s, r, now)), `earnings ${s} ${r}`);
    const p1 = parsePaymentsPage(fixturePayments(s, null, now));
    assert.ok(p1, `payments ${s}`);
    if (p1!.next) assert.ok(parsePaymentsPage(fixturePayments(s, p1!.next, now)), `payments page 2 ${s}`);
  }
  assert.equal(payoutStage(parsePayoutStatus(fixturePayoutStatus("noaccount"))!), "none");
  assert.equal(payoutStage(parsePayoutStatus(fixturePayoutStatus("mismatch"))!), "mismatch");
  assert.equal(payoutStage(parsePayoutStatus(FIXTURE_SAVED_STATUS)!), "ready");
  assert.ok(parseBanks(FIXTURE_BANKS)!.length >= 5);
  assert.equal(parseEarnings(fixtureEarnings("clawback", "week", now))!.clawbackOpenKobo > 0, true);
});
test("fixture week adds up like board 8: settled + on its way + held = the headline", () => {
  const e = parseEarnings(fixtureEarnings("week", "week", 0))!;
  assert.equal(e.settledKobo + e.onItsWayKobo + e.heldTicketKobo, earningsHeadline(e));
  assert.equal(earningsHeadline(e), 24_360_000);
  assert.equal(e.byRoom.reduce((n, r) => n + r.sprayKobo + r.ticketKobo, 0), earningsHeadline(e));
});
test("fixture: wired into the dev-only room fixture, fake fetch before children mount, cache cleared after", () => {
  const fx = src("../client/src/pages/dev/RoomFixture.tsx");
  assert.ok(fx.includes("parseEarnFixture(window.location.search)") && fx.includes("<EarningsFixture"));
  const ef = src("../client/src/pages/dev/EarningsFixture.tsx");
  assert.ok(/useLayoutEffect\(\(\) => \{\s*const real = window\.fetch/.test(ef));
  for (const p of ["/api/rooms/payouts/status", "/api/rooms/payouts/banks", "/api/rooms/payouts/account", "/api/users/me/room-earnings", "/api/users/me/room-payments", "/api/csrf-token"]) assert.ok(ef.includes(p), p);
  assert.ok(ef.includes("removeQueries"));
  const app = src("../client/src/App.tsx");
  assert.ok(!/import .*EarningsFixture/.test(app), "the fixture is reached only through the DEV-only RoomFixture chunk");
});

// ---------------------------------------------------------------- routes, safety, copy, amber
test("routes: the three money pages sit above /rooms/:id, inside AuthenticatedLayout", () => {
  const app = src("../client/src/App.tsx");
  const param = app.indexOf('<Route path="/rooms/:id">');
  for (const p of ["/rooms/earnings", "/rooms/payouts", "/rooms/payments"]) {
    const i = app.indexOf(`<Route path="${p}">`);
    assert.ok(i > 0 && i < param, p);
    assert.ok(app.slice(i, i + 120).includes("<AuthenticatedLayout>"), p);
  }
  const home = src("../client/src/pages/RoomsPage.tsx");
  assert.ok(home.includes('href="/rooms/earnings"') && home.includes('href="/rooms/payments"') && home.includes("moneyOn &&"));
});
test("network: no amount, user id or account name ever sent; the number is cleaned and not kept", () => {
  const api = src("../client/src/lib/earningsApi.ts");
  assert.ok(api.includes('{ bankCode, accountNumber: cleanAccountNumber(accountNumber) }'));
  assert.ok(!/userId|amountKobo|accountName/.test(api.replace(/\/\/.*$/gm, "")));
  const form = src("../client/src/components/rooms/earnings/PayoutAccountView.tsx");
  assert.ok(form.includes('setNumber("")'), "the number is cleared after every answer");
  assert.ok(!/localStorage|sessionStorage/.test(form + api));
  assert.ok(!/accountName|resolvedName/.test(form), "the screen never has a resolved name to show");
  const pay = src("../client/src/components/rooms/earnings/PaymentsView.tsx");
  assert.ok(pay.includes('rel="noopener noreferrer"') && pay.includes("receiptIdOk(item.id)"));
  assert.ok(!/dangerouslySetInnerHTML/.test(pay + form + src("../client/src/components/rooms/earnings/EarningsView.tsx")));
});
test("copy: no em or en dashes, never 'cash', never 'anonymous', never 'paid' for money still on its way", () => {
  assert.ok(EARNINGS_UI_COPY.length > 60);
  for (const line of EARNINGS_UI_COPY) {
    assert.equal(/[—–]/.test(line), false, `dash in: ${line}`);
    assert.equal(/cash/i.test(line), false, `cash in: ${line}`);
    assert.equal(/anonymous/i.test(line), false, `anonymous in: ${line}`);
  }
  const ui = src("../client/src/components/rooms/earnings/earningsUi.ts");
  const block = ui.slice(ui.indexOf("export const EARNINGS_COPY"), ui.indexOf("// ---------------------------------------------------------------- payments"));
  assert.ok(block.includes('"Settled to your bank"') && block.includes('"On its way to your bank"'));
  assert.ok(!/onItsWay[^:]*:\s*"[^"]*\bpaid\b/i.test(block) && !/held:\s*"[^"]*\bpaid\b/i.test(block), "held and on-its-way lines never say paid");
});
test("files: no dashes, 'cash' or 'anonymous'; icons only from the icon set; amber only as the token fill", () => {
  const files = [
    "../client/src/components/rooms/earnings/earningsUi.ts", "../client/src/components/rooms/earnings/earningsFixtures.ts",
    "../client/src/components/rooms/earnings/PayoutAccountView.tsx", "../client/src/components/rooms/earnings/EarningsView.tsx",
    "../client/src/components/rooms/earnings/PaymentsView.tsx", "../client/src/lib/earningsApi.ts",
    "../client/src/pages/RoomEarningsPage.tsx", "../client/src/pages/RoomPayoutsPage.tsx", "../client/src/pages/RoomPaymentsPage.tsx",
    "../client/src/pages/dev/EarningsFixture.tsx",
  ];
  for (const f of files) {
    const s = src(f);
    assert.ok(!/[—–]/.test(s), `${f}: dash`);
    assert.ok(!/\bcash\b/i.test(s), `${f}: cash`);
    assert.ok(!/anonymous/i.test(s), `${f}: anonymous`);
    assert.ok(!/from "lucide-react"/.test(s), `${f}: icons must come from @/components/ui/icons`);
    assert.ok(!/\btext-secondary\b(?!-)/.test(s), `${f}: amber text`);
    assert.ok(!/amber-\d|yellow-\d|emerald-\d|green-\d/.test(s), `${f}: raw palette instead of the tokens`);
  }
  const ev = src("../client/src/components/rooms/earnings/EarningsView.tsx");
  assert.ok(ev.includes("AMBER.fill"), "the earnings headline is the amber money moment (contrast checked in test-rooms-unit-ticketsui)");
  for (const f of ["PayoutAccountView.tsx", "PaymentsView.tsx"]) assert.ok(!src(`../client/src/components/rooms/earnings/${f}`).includes("AMBER"), f);
  for (const f of ["PayoutAccountView.tsx", "EarningsView.tsx", "PaymentsView.tsx"]) assert.ok(/<h1\b/.test(src(`../client/src/components/rooms/earnings/${f}`)), `${f}: h1`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
