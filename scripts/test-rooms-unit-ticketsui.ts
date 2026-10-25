// Paid room tickets on the client (task 4.7, fix round 4F), pure helpers and source checks (no database, no browser):
//   npx tsx scripts/test-rooms-unit-ticketsui.ts
// Written, not run (owner's no-testing rule for phase 4). Runs under npm run test:rooms with the other unit suites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_RATES, ticketBreakdown } from "../shared/money";
import { ROOM_LIMITS } from "../shared/rooms";
import {
  AMBER, BUYER_REFUND_CUTOFF_MS, PRICE_COPY, REFUND_COPY, REFUND_REFUSAL, SALES_COPY, TICKET_COPY, TICKET_CREATE_ERROR, TICKET_ERROR,
  TICKET_LIMITS, TICKET_REF_SHAPE, TICKET_UI_COPY,
  afterTicketRefusal, cancelNeedsRefetch, checkoutNeedsRefetch, clampPriceNaira, clampTicketCapacity, contrastRatio, defaultTicketDraft,
  earningsEstimate, estimateText, formatDeduction, formatNaira, formatNairaWhole, hslTripletToHex, inviteTokenFor, inviteTokenKey,
  isPriceStepField, isTicketFailure, parseSummary, parseTicketBlock, priceKoboOf, priceStepAvailable, recallInviteToken, refundOutcome,
  refundPromise, refundWindow, rememberInviteToken, returnRef, safeCheckoutUrl, salesLines, salesReleaseLine, salesSoldOut, searchWithoutRef,
  showsPrice, ticketCreateMessage, ticketDraftProblem, ticketErrorMessage, ticketFieldSelectors, ticketGate, ticketPayload, ticketsLeftText,
  ticketsTooManyForVideo, verifyOutcome, verifyRetryable, waitingClock, waitingTickMs, withToken,
} from "../client/src/lib/roomTickets";
import { DENIED_MESSAGE } from "../client/src/lib/roomsApi";
import { buildCreatePayload, defaultWizardState, isKnownStep, uiStepTitle, uiSteps } from "../client/src/lib/createRoomWizardUi";
import { stepsFor, wizardOptions } from "../client/src/lib/createRoomRules";
import { FIXTURE_TICKET, FIXTURE_TICKET_BLOCK, FIXTURE_TICKET_REF, fixtureTicketSummary, parseTicketFixture } from "../client/src/lib/roomFixtures";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

const BLOCK = { required: true, priceKobo: 500_000, held: false, soldOut: false };
const REF = `vib3rt_${"ab".repeat(12)}_${"0123456789abcdef".repeat(2)}`;

// ---------------------------------------------------------------- formatNaira
test("formatNaira (prices): whole naira with a naira sign and thousands commas", () => {
  assert.equal(formatNaira(500_000), "₦5,000");
  assert.equal(formatNaira(100_000), "₦1,000");
  assert.equal(formatNaira(10_000_000), "₦100,000");
  assert.equal(formatNaira(0), "₦0");
  assert.equal(formatNaira(19_000_000), "₦190,000");
  // a price that is not whole (API only) is never misstated
  assert.equal(formatNaira(376_224), "₦3,762.24");
});
test("formatNairaWhole: whole naira, floor for earnings, ceil for deductions", () => {
  assert.equal(formatNairaWhole(376_224, "floor"), "₦3,762");
  assert.equal(formatNairaWhole(376_299, "floor"), "₦3,762");
  assert.equal(formatNairaWhole(376_201, "ceil"), "₦3,763");
  assert.equal(formatNairaWhole(376_250), "₦3,763");
  assert.equal(formatNairaWhole(14_296_512, "floor"), "₦142,965");
  assert.equal(formatNairaWhole(Number.NaN), "₦0");
  assert.equal(formatNairaWhole(Infinity), "₦0");
});
test("deductions: whole naira rounded up, a minus sign (not a dash), whatever the sign in", () => {
  assert.equal(formatDeduction(2_180_592), "−₦21,806");
  assert.equal(formatDeduction(-2_180_600), "−₦21,806");
  assert.equal(formatDeduction(0), "−₦0");
  assert.ok(!/[—–]/.test(formatDeduction(100)));
});

// ---------------------------------------------------------------- who sees what
test("no ticket block means no price, for anyone (teen, unverified, banned, signed out, free room)", () => {
  for (const t of [undefined, null, {}, "x", 5, { required: true }, { ...BLOCK, priceKobo: "5000" }, { ...BLOCK, priceKobo: 0 }, { ...BLOCK, priceKobo: 12.5 }, { ...BLOCK, held: "no" }]) {
    assert.equal(parseTicketBlock(t), null, JSON.stringify(t));
    assert.equal(ticketGate(t, "guest"), "none", JSON.stringify(t));
    assert.equal(showsPrice(ticketGate(t, "guest")), false);
    assert.equal(afterTicketRefusal(t), "plain", "a socket refusal without a block shows the plain line, no price");
  }
});
test("an eligible adult guest sees the ticket page; holders see no price; sold out keeps the page with the button off", () => {
  assert.equal(ticketGate(BLOCK, "guest"), "buy");
  assert.equal(ticketGate(BLOCK, null), "buy");
  assert.equal(ticketGate({ ...BLOCK, soldOut: true }, "guest"), "soldout");
  assert.equal(ticketGate({ ...BLOCK, held: true }, "guest"), "held");
  assert.equal(showsPrice("buy"), true);
  assert.equal(showsPrice("soldout"), true);
  assert.equal(showsPrice("held"), false);
  assert.equal(afterTicketRefusal(BLOCK), "page");
});
test("host and co-hosts never get a ticket page; a free room (required false) shows nothing", () => {
  assert.equal(ticketGate(BLOCK, "host"), "none");
  assert.equal(ticketGate(BLOCK, "cohost"), "none");
  assert.equal(ticketGate({ ...BLOCK, required: false }, "guest"), "none");
  assert.equal(afterTicketRefusal({ ...BLOCK, required: false }), "plain");
});
test("the ticket block keeps only known fields; left, capacity and refundBeforeStart only in the right shape", () => {
  const b = parseTicketBlock({ ...BLOCK, left: 62, capacity: 100, refundBeforeStart: true, extra: "x" })!;
  assert.deepEqual(b, { ...BLOCK, left: 62, capacity: 100, refundBeforeStart: true });
  assert.deepEqual(parseTicketBlock({ ...BLOCK, left: -1, capacity: 1.5, refundBeforeStart: "yes" }), BLOCK);
  assert.equal(parseTicketBlock({ ...BLOCK, refundBeforeStart: false })?.refundBeforeStart, false);
  assert.equal(ticketsLeftText(b), "62 of 100");
  assert.equal(ticketsLeftText(BLOCK), TICKET_COPY.onSale, "counts absent: On sale");
  assert.equal(ticketsLeftText({ ...b, soldOut: true }), TICKET_COPY.soldOut);
});
test("the plain refusal line has no price and no naira", () => {
  assert.equal(DENIED_MESSAGE.TICKET_REQUIRED, "You need a ticket to join this room.");
  assert.ok(!/₦|\d/.test(DENIED_MESSAGE.TICKET_REQUIRED));
});
test("RoomPage: price only through the ticket block; the Paystack return is handled before load, errors and not-available", () => {
  const page = src("../client/src/pages/RoomPage.tsx");
  assert.ok(page.includes("ticketBlock && showsPrice(gate)"), "the ticket page needs the parsed block");
  assert.ok(page.includes("<TicketPage room={room} host={detail.host} ticket={ticketBlock} token={token}"));
  assert.ok(page.indexOf("<MinorsRoomWarning") < page.indexOf("<TicketPage"), "minors' warning first");
  assert.ok(page.indexOf("DENIED_MESSAGE.AGE_UNKNOWN") < page.indexOf("<TicketPage"), "age unknown first");
  assert.ok(page.indexOf('room.status === "ended"') < page.indexOf("<TicketPage"), "no price on an ended room");
  assert.ok(!/priceKobo\s*[:=]\s*\d/.test(page), "never a hard-coded or inferred price");
  assert.ok(/state\.error === "TICKET_REQUIRED"/.test(page), "the socket refusal reloads the room");
  // C2: the payRef branch comes before loading, the load error and the not-available panel
  const pay = page.indexOf("} else if (payRef) {");
  assert.ok(pay > 0, "payRef branch");
  for (const later of ["} else if (isLoading) {", "} else if (error) {", "} else if (!detail || !room) {"]) {
    assert.ok(page.indexOf(later) > pay, `payRef before ${later}`);
  }
  assert.ok(page.includes("<Checkout roomId={id} reference={payRef}"));
  // C2: the token falls back to the one kept before the Paystack trip
  assert.ok(page.includes("inviteTokenFor(window.location.search, sessionStore(), id)"));
  assert.ok(/<WaitingRoom [^\n]*token=\{token\}/.test(page), "the refund call gets the token");
  assert.ok(/ticketBlock\.refundBeforeStart \?\? room\.refundBeforeStart/.test(page), "refund promise from the block");
  // C1: the host's capacity comes from the host's own room
  assert.ok(page.includes("capacity={room.ticketCapacity ?? ticketBlock?.capacity ?? null}"));
});
test("components read the price from the block or the ticket, never compute a charge", () => {
  const dir = new URL("../client/src/components/rooms/tickets/", import.meta.url);
  const page = readFileSync(new URL("TicketPage.tsx", dir), "utf8");
  assert.ok(page.includes("formatNaira(ticket.priceKobo)"));
  assert.ok(!/ticketBreakdown/.test(page), "the buyer's page never computes fees");
  const api = readFileSync(new URL("ticketsApi.ts", dir), "utf8");
  assert.ok(/tickets\/checkout\$\{withToken\(token\)\}`, \{\}\)/.test(api), "checkout posts an empty body: no client price");
  assert.ok(!/amount|price/i.test(api.slice(api.indexOf("export const startCheckout"), api.indexOf("const inFlight"))), "no amount in the checkout call");
  assert.ok(/tickets\/refund\$\{withToken\(token\)\}/.test(api), "refund carries the token");
  assert.ok(/\/cancel\$\{withToken\(token\)\}/.test(api), "cancel carries the token");
  assert.ok(!/verify\$\{withToken/.test(api), "verify needs no token (MAC-bound)");
  assert.ok(/no browser mock payment provider/i.test(api), "M9 dev note");
});

// ---------------------------------------------------------------- invite token across the Paystack trip (C2)
function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}
test("invite token: kept per room before the redirect, URL first, storage as the fallback", () => {
  const st = memStore();
  assert.equal(inviteTokenKey("r1"), "room-invite:r1");
  rememberInviteToken(st, "r1", "a".repeat(48));
  assert.equal(st.m.get("room-invite:r1"), "a".repeat(48));
  assert.equal(recallInviteToken(st, "r1"), "a".repeat(48));
  assert.equal(recallInviteToken(st, "r2"), undefined, "per room");
  assert.equal(inviteTokenFor("?token=urltok", st, "r1"), "urltok", "the URL wins");
  assert.equal(inviteTokenFor("?ref=" + REF, st, "r1"), "a".repeat(48), "the return from Paystack has no token: fallback");
  assert.equal(inviteTokenFor("", null, "r1"), undefined);
  rememberInviteToken(st, "r3", undefined);
  rememberInviteToken(st, "r3", "<bad token>");
  assert.equal(st.m.has("room-invite:r3"), false, "nothing or junk is not stored");
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => rememberInviteToken(throwing, "r1", "tok"));
  assert.equal(recallInviteToken(throwing, "r1"), undefined);
  assert.equal(withToken("t 1"), "?token=t%201");
  assert.equal(withToken(undefined), "");
});
test("TicketPage stores the token before leaving for Paystack and passes it to checkout", () => {
  const page = src("../client/src/components/rooms/tickets/TicketPage.tsx");
  assert.ok(page.includes("startCheckout(room.id, token)"));
  const keep = page.indexOf("rememberInviteToken(sessionStore(), room.id, token)");
  const leave = page.indexOf("window.location.assign(u)");
  assert.ok(keep > 0 && leave > keep, "kept before the redirect");
});

// ---------------------------------------------------------------- double click, bfcache and redirect safety
test("Get ticket is guarded against a double click by a ref and a disabled busy button; bfcache resets it", () => {
  const page = src("../client/src/components/rooms/tickets/TicketPage.tsx");
  assert.ok(/if \(pending\.current \|\| soldOut\) return;/.test(page));
  assert.ok(/pending\.current = true; setBusy\(true\)/.test(page));
  assert.ok(/disabled=\{busy \|\| soldOut\}/.test(page));
  assert.ok(/aria-busy=\{busy \|\| undefined\}/.test(page));
  assert.ok(/window\.location\.assign/.test(page));
  assert.ok(/addEventListener\("pageshow"/.test(page) && /e\.persisted/.test(page), "M6: pageshow persisted resets busy");
  assert.ok(/checkoutNeedsRefetch\(r\)\) onRefetch\?\.\(\)/.test(page), "I8: any checkout 409 reloads the room");
});
test("verify runs once per reference at a time", () => {
  const api = src("../client/src/components/rooms/tickets/ticketsApi.ts");
  assert.ok(/inFlight\.get\(key\)/.test(api) && /inFlight\.delete\(key\)/.test(api));
});
test("checkout only ever leaves for Paystack over https or our own origin", () => {
  const o = "https://vib3pulse.app";
  assert.equal(safeCheckoutUrl("https://checkout.paystack.com/abc123", o), "https://checkout.paystack.com/abc123");
  assert.equal(safeCheckoutUrl("/dev/room-fixture?ticket=checkout", o), "https://vib3pulse.app/dev/room-fixture?ticket=checkout");
  for (const bad of ["http://checkout.paystack.com/x", "https://paystack.com.evil.io/x", "https://evil.io/?paystack.com", "javascript:alert(1)", "", null, 7, "//evil.io/x"]) {
    assert.equal(safeCheckoutUrl(bad, o), null, String(bad));
  }
});
test("return reference: only vib3rt_<24 hex>_<32 hex>, from ref, reference or trxref; removal keeps other params", () => {
  assert.ok(TICKET_REF_SHAPE.test(REF));
  assert.ok(TICKET_REF_SHAPE.test(FIXTURE_TICKET_REF), "the fixture reference has the real shape");
  assert.equal(returnRef(`?ref=${REF}`), REF);
  assert.equal(returnRef(`?trxref=${REF}&reference=${REF}`), REF);
  assert.equal(returnRef(`?reference=${REF}`), REF);
  assert.equal(returnRef(`?ref=junk&trxref=${REF}`), REF, "junk ref is skipped, the next key is read");
  for (const bad of [
    "?ref=room-abc_123", "?ref=T1", "?ref=%3Cscript%3E", "?ref=", "",
    `?ref=${REF.toUpperCase()}`, `?ref=${REF}x`, `?ref=x${REF}`, `?ref=vib3rt_${"a".repeat(23)}_${"b".repeat(32)}`,
    `?ref=vib3rt_${"a".repeat(24)}_${"b".repeat(31)}`, `?ref=vib3rt_${"g".repeat(24)}_${"b".repeat(32)}`,
  ]) assert.equal(returnRef(bad), null, bad);
  assert.equal(searchWithoutRef("?token=t1&ref=r&trxref=r&reference=r"), "?token=t1");
  assert.equal(searchWithoutRef("?ref=r"), "");
});

// ---------------------------------------------------------------- refusals to plain words (I1)
test("checkout: the real codes map to their own lines; unknown falls back to generic", () => {
  const m = (status: number, code?: string) => ticketErrorMessage({ status, code }, "checkout");
  assert.equal(m(401), "Sign in again to buy a ticket.");
  assert.equal(m(403, "FEATURE_OFF"), TICKET_ERROR.featureOff);
  assert.equal(m(429, "RATE_LIMITED"), TICKET_ERROR.rateLimited);
  assert.equal(m(429), TICKET_ERROR.rateLimited);
  assert.equal(m(404), TICKET_ERROR.notFound);
  assert.equal(m(404, "NOT_ELIGIBLE"), "You can't buy a ticket for this room.");
  assert.equal(m(409, "IS_HOST"), "You host this room, so you don't need a ticket.");
  assert.equal(m(409, "NOT_TICKETED"), "This room doesn't sell tickets.");
  assert.equal(m(409, "ROOM_ENDED"), TICKET_ERROR.ended);
  assert.equal(m(409, "NOT_ON_SALE"), "Tickets aren't on sale right now.");
  assert.equal(m(409, "ALREADY_TICKETED"), TICKET_ERROR.alreadyTicketed);
  assert.equal(m(409, "SOLD_OUT"), TICKET_ERROR.soldOut);
  assert.equal(m(409, "ROOM_LOCKED"), "The host has paused ticket sales.");
  assert.equal(m(409, "SALES_PAUSED"), "Ticket sales are paused for this room.");
  assert.equal(m(502, "CHECKOUT_FAILED"), TICKET_ERROR.checkoutGeneric);
  assert.equal(m(500, "CHECKOUT_FAILED"), TICKET_ERROR.checkoutGeneric);
  assert.equal(m(0), TICKET_ERROR.offline);
  assert.equal(m(409), TICKET_ERROR.checkoutGeneric, "a bare 409 is no longer read as already ticketed");
  for (const gone of ["INELIGIBLE", "AGE_LIMIT", "NOT_VERIFIED", "ROOM_STARTED", "OVERSOLD"]) assert.equal(m(409, gone), TICKET_ERROR.checkoutGeneric, gone);
  // I8: every checkout 409 reloads the room
  for (const c of ["IS_HOST", "NOT_TICKETED", "ROOM_ENDED", "NOT_ON_SALE", "ALREADY_TICKETED", "SOLD_OUT", "ROOM_LOCKED", "SALES_PAUSED", undefined]) {
    assert.equal(checkoutNeedsRefetch({ status: 409, code: c }), true, String(c));
  }
  assert.equal(checkoutNeedsRefetch({ status: 404, code: "NOT_ELIGIBLE" }), false);
  assert.equal(checkoutNeedsRefetch({ status: 500 }), false);
});
test("verify: the real codes, what happens to the money, and whether Try again makes sense", () => {
  const m = (status: number, code?: string) => ticketErrorMessage({ status, code }, "verify");
  assert.equal(m(400), "This payment link isn't valid.");
  assert.equal(verifyRetryable({ status: 400 }), false);
  assert.equal(m(404, "PAYMENT_NOT_FOUND"), "We couldn't find this payment on your account.");
  assert.equal(verifyRetryable({ status: 404, code: "PAYMENT_NOT_FOUND" }), false);
  assert.equal(m(402, "NOT_PAID"), "Your payment hasn't gone through. If you paid, try again in a moment. If not, you have not been charged.");
  assert.equal(verifyRetryable({ status: 402, code: "NOT_PAID" }), true);
  for (const [status, code] of [[502, "VERIFY_FAILED"], [500, "VERIFY_ERROR"], [500, undefined]] as const) {
    assert.equal(m(status, code), TICKET_ERROR.verifyGeneric);
    assert.equal(verifyRetryable({ status, code }), true);
  }
  assert.ok(/never be charged twice/.test(TICKET_ERROR.verifyGeneric), "retry is safe and says so");
  assert.equal(m(409, "SOLD_OUT"), TICKET_ERROR.verifySoldOut);
  assert.equal(m(409, "AMOUNT_MISMATCH"), TICKET_ERROR.verifyMismatch);
  assert.equal(m(409, "INELIGIBLE"), TICKET_ERROR.verifyIneligible);
  for (const c of ["SOLD_OUT", "AMOUNT_MISMATCH", "INELIGIBLE"]) assert.equal(verifyRetryable({ status: 409, code: c }), false, c);
  assert.equal(m(401), TICKET_ERROR.signInVerify);
  assert.equal(verifyRetryable({ status: 401 }), false, "sign in instead");
  for (const gone of ["PAYMENT_PENDING", "PENDING", "PAYMENT_FAILED", "DECLINED", "ABANDONED", "OVERSOLD"]) assert.equal(m(409, gone), TICKET_ERROR.verifyGeneric, gone);
});
test("verify body (I5): only status paid is You are in; refunded says so; duplicateRefunded is read", () => {
  const paid = verifyOutcome({ ticket: FIXTURE_TICKET });
  assert.equal(paid.kind, "paid");
  if (paid.kind === "paid") { assert.equal(paid.ticket.code, FIXTURE_TICKET.code); assert.equal(paid.duplicateRefunded, false); }
  const dup = verifyOutcome({ ticket: FIXTURE_TICKET, duplicateRefunded: true });
  assert.equal(dup.kind === "paid" && dup.duplicateRefunded, true);
  assert.deepEqual(verifyOutcome({ ticket: { ...FIXTURE_TICKET, status: "refunded" } }), { kind: "refunded" });
  for (const bad of [null, {}, { ticket: null }, { ticket: { ...FIXTURE_TICKET, code: "" } }, { ticket: { ...FIXTURE_TICKET, status: "pending" } }, { ticket: { ...FIXTURE_TICKET, status: undefined } }]) {
    assert.deepEqual(verifyOutcome(bad), { kind: "bad" }, JSON.stringify(bad));
  }
  assert.equal(TICKET_ERROR.verifyRefunded, "This ticket was refunded.");
  assert.equal(TICKET_COPY.duplicateRefunded, "You already had a ticket; the second payment is being refunded.");
  const checkout = src("../client/src/components/rooms/tickets/Checkout.tsx");
  assert.ok(checkout.includes("verifyOutcome(r.body)") && /o\.kind === "paid"/.test(checkout));
  assert.ok(/failure\.retry &&/.test(checkout) && /failure\.signIn &&/.test(checkout), "Try again only when it helps; sign in on 401");
  const ok = src("../client/src/components/rooms/tickets/TicketConfirmed.tsx");
  assert.ok(ok.includes("TICKET_COPY.duplicateRefunded"));
});
test("refund: each refusal code has its own plain line; 200 bodies read as refunded, already or on its way", () => {
  const m = (status: number, code?: string) => ticketErrorMessage({ status, code }, "refund");
  for (const code of ["ROOM_NOT_SCHEDULED", "NO_REFUNDS", "NO_START_TIME", "WINDOW_CLOSED", "PAYOUT_RELEASED", "BAD_STATE", "REFUND_IN_PROGRESS"]) {
    assert.equal(m(409, code), REFUND_REFUSAL[code], code);
  }
  assert.equal(new Set(Object.values(REFUND_REFUSAL)).size, Object.keys(REFUND_REFUSAL).length, "one line per code");
  assert.equal(m(404, "NO_TICKET"), "You don't have a ticket to refund.");
  assert.equal(m(404), TICKET_ERROR.notFound);
  assert.equal(m(429, "RATE_LIMITED"), TICKET_ERROR.rateLimited);
  assert.equal(m(500), TICKET_ERROR.refundGeneric);
  assert.equal(m(409, "SOMETHING_NEW"), TICKET_ERROR.refundGeneric);
  assert.deepEqual(refundOutcome({ result: "refunded", settled: true }), { kind: "refunded", text: REFUND_COPY.done });
  assert.deepEqual(refundOutcome({ result: "refunded" }), { kind: "refunded", text: REFUND_COPY.done }, "settled absent: refunded");
  assert.deepEqual(refundOutcome({ result: "already", settled: true }), { kind: "already", text: REFUND_COPY.already });
  assert.deepEqual(refundOutcome({ result: "refunded", settled: false }), { kind: "pending", text: REFUND_COPY.pending });
  assert.deepEqual(refundOutcome({ result: "already", settled: false }), { kind: "pending", text: REFUND_COPY.pending });
  assert.deepEqual(refundOutcome({ result: "pending" }), { kind: "pending", text: REFUND_COPY.pending });
  assert.ok(REFUND_COPY.pending.startsWith("Your refund is on its way"));
  assert.equal(refundOutcome({ result: "not_allowed" }), null);
  assert.equal(refundOutcome(null), null);
});
test("summary and cancel codes", () => {
  assert.equal(ticketErrorMessage({ status: 403 }, "summary"), TICKET_ERROR.notHost);
  assert.equal(ticketErrorMessage({ status: 500 }, "summary"), TICKET_ERROR.summaryGeneric);
  const c = (status: number, code?: string) => ticketErrorMessage({ status, code }, "cancel");
  assert.equal(c(403), "Only the host can cancel this room.");
  assert.equal(c(409, "ROOM_LIVE"), "A live room can't be cancelled. End it instead.");
  assert.equal(c(409, "BAD_STATE"), "This room can't be cancelled now.");
  assert.equal(c(500), TICKET_ERROR.cancelGeneric);
  assert.equal(cancelNeedsRefetch({ status: 409, code: "BAD_STATE" }), true);
  assert.equal(cancelNeedsRefetch({ status: 500 }), false);
  const hs = src("../client/src/components/rooms/tickets/HostSales.tsx");
  assert.ok(/cancelNeedsRefetch\(r\)\) onChanged\(\)/.test(hs));
});
test("create/patch ticket refusals belong to the price step; the guessed codes are gone", () => {
  for (const code of Object.keys(TICKET_CREATE_ERROR)) {
    assert.equal(isTicketFailure({ code }), true, code);
    assert.equal(ticketCreateMessage({ code }), TICKET_CREATE_ERROR[code]);
  }
  for (const code of ["FEATURE_OFF", "HOST_NOT_ADULT", "HOST_NOT_VERIFIED", "NO_PAYOUT_ACCOUNT", "ROOM_NOT_ADULT", "TICKETS_SOLD", "CAPACITY_BELOW_SOLD", "NOT_SCHEDULED"]) {
    assert.ok(TICKET_CREATE_ERROR[code], code);
  }
  assert.equal(TICKET_CREATE_ERROR.TICKETS_SOLD, "Tickets are sold, so the price, age limit and refunds can't change.");
  assert.equal(TICKET_CREATE_ERROR.NOT_SCHEDULED, "You can only start selling tickets before the room goes live.");
  assert.equal("PRICE_LOCKED" in TICKET_CREATE_ERROR, false);
  for (const field of ["ticketPriceKobo", "ticketCapacity", "refundBeforeStart"]) {
    assert.equal(isTicketFailure({ field }), true, field);
    assert.ok(ticketCreateMessage({ field }));
    assert.ok(ticketFieldSelectors(field).length > 0, field);
    assert.equal(isPriceStepField(field), true);
  }
  assert.equal(isPriceStepField(""), false);
  assert.equal(isTicketFailure({ code: "TEEN_PUBLIC" }), false);
  assert.equal(ticketCreateMessage({ code: "TEEN_PUBLIC" }), null);
  // the selectors are the ids StepPrice renders
  const step = src("../client/src/components/rooms/create/StepPrice.tsx") + src("../client/src/components/rooms/create/parts.tsx");
  assert.ok(step.includes('id="wiz-price"') && step.includes('id="wiz-ticket-cap"') && step.includes('id="wiz-refund"'));
});
test("I6: a ticket refusal with a code and no field shows in the price step's general alert", () => {
  const step = src("../client/src/components/rooms/create/StepPrice.tsx");
  assert.ok(step.includes("error && !isPriceStepField(error.field) ? error.reason : null"));
  assert.ok(/generalErr && <p role="alert"/.test(step));
});

// ---------------------------------------------------------------- countdown
test("waiting clock: mm:ss under an hour, h:mm:ss under a day, days and hours beyond", () => {
  assert.equal(waitingClock((12 * 60 + 8) * 1000), "12:08");
  assert.equal(waitingClock(59_000), "00:59");
  assert.equal(waitingClock(1), "00:01", "a part second rounds up, never shows zero early");
  assert.equal(waitingClock(3_600_000), "1:00:00");
  assert.equal(waitingClock((2 * 3600 + 5 * 60 + 9) * 1000), "2:05:09");
  assert.equal(waitingClock((2 * 86400 + 3 * 3600) * 1000), "2d 3h");
  assert.equal(waitingClock(0), "00:00");
  assert.equal(waitingClock(-5000), "00:00");
  assert.equal(waitingClock(Number.NaN), "00:00");
  assert.equal(waitingTickMs(60_000), 1000);
  assert.equal(waitingTickMs(2 * 86_400_000), 60_000);
  assert.equal(waitingTickMs(null), 1000);
});

// ---------------------------------------------------------------- refund window (shared rule)
test("refund window follows shared buyerRefundCheck: open until 1 hour before, only when the host offered it", () => {
  assert.equal(BUYER_REFUND_CUTOFF_MS, 60 * 60_000);
  const start = Date.UTC(2026, 9, 20, 20, 0);
  const room = { status: "scheduled" as const, scheduledFor: new Date(start).toISOString(), refundBeforeStart: true };
  const open = refundWindow(room, "paid", start - BUYER_REFUND_CUTOFF_MS - 1);
  assert.equal(open.open, true);
  if (open.open) assert.equal(open.closesAt, start - 60 * 60_000);
  assert.deepEqual(refundWindow(room, "paid", start - BUYER_REFUND_CUTOFF_MS), { open: false, reason: REFUND_REFUSAL.WINDOW_CLOSED });
  assert.deepEqual(refundWindow(room, "paid", start + 1), { open: false, reason: REFUND_REFUSAL.WINDOW_CLOSED });
  assert.deepEqual(refundWindow({ ...room, refundBeforeStart: false }, "paid", start - 86_400_000), { open: false, reason: REFUND_REFUSAL.NO_REFUNDS });
  assert.deepEqual(refundWindow({ ...room, status: "live" }, "paid", start - 86_400_000), { open: false, reason: REFUND_REFUSAL.ROOM_NOT_SCHEDULED });
  assert.deepEqual(refundWindow({ ...room, status: "ended" }, "paid", start - 86_400_000), { open: false, reason: REFUND_REFUSAL.ROOM_NOT_SCHEDULED });
  assert.deepEqual(refundWindow({ ...room, scheduledFor: null }, "paid", 0), { open: false, reason: REFUND_REFUSAL.NO_START_TIME });
  assert.deepEqual(refundWindow({ ...room, scheduledFor: "not a date" }, "paid", 0), { open: false, reason: REFUND_REFUSAL.NO_START_TIME });
  assert.deepEqual(refundWindow(room, "refunded", 0), { open: false, reason: REFUND_COPY.closedRefunded });
  // unknown refundBeforeStart (the server did not send it): left to the server, the button stays on
  assert.equal(refundWindow({ status: "scheduled", scheduledFor: room.scheduledFor }, "paid", start - 86_400_000).open, true);
  const lib = src("../client/src/lib/roomTickets.ts");
  assert.ok(lib.includes('from "@shared/roomRefunds"') && lib.includes("buyerRefundCheck("), "the shared rule, not a copy");
});
test("refund promise: the 1 hour line only when the host offered it on a scheduled room; the automatic refund always", () => {
  assert.equal(refundPromise({ scheduledFor: "2026-10-20T20:00:00Z", refundBeforeStart: true }), "Full refund up to 1 hour before. If the room does not start, you are refunded automatically.");
  assert.equal(refundPromise({ scheduledFor: "2026-10-20T20:00:00Z", refundBeforeStart: false }), "If the room does not start, you are refunded automatically.");
  assert.equal(refundPromise({ scheduledFor: "2026-10-20T20:00:00Z" }), "If the room does not start, you are refunded automatically.");
  assert.equal(refundPromise({ scheduledFor: null, refundBeforeStart: true }), "If the room does not start, you are refunded automatically.");
  const page = src("../client/src/components/rooms/tickets/TicketPage.tsx");
  assert.ok(page.includes("ticket.refundBeforeStart ?? room.refundBeforeStart"), "I3: from the ticket block");
});
test("refund button confirms first, is destructive, reads the body through refundOutcome, sends the token", () => {
  const b = src("../client/src/components/rooms/tickets/RefundButton.tsx");
  assert.ok(b.includes("AlertDialogContent") && b.includes('variant="destructive"'));
  assert.ok(/disabled=\{!win\.open \|\| busy\}/.test(b));
  assert.ok(b.includes("refundOutcome(r.body)"));
  assert.ok(b.includes("refundMyTicket(room.id, token)"));
  assert.ok(!/amber|bg-secondary/i.test(b), "refunds use the destructive token, never amber");
});

// ---------------------------------------------------------------- price step and payload
test("price limits come from shared ROOM_LIMITS (1,000 to 100,000 naira, 20 to 150 tickets)", () => {
  assert.equal(TICKET_LIMITS.minKobo, ROOM_LIMITS.ticketMinKobo);
  assert.equal(TICKET_LIMITS.maxKobo, ROOM_LIMITS.ticketMaxKobo);
  assert.equal(TICKET_LIMITS.capacityMin, ROOM_LIMITS.ticketCapacityMin);
  assert.equal(TICKET_LIMITS.capacityMax, ROOM_LIMITS.ticketCapacityMax);
  assert.equal(TICKET_LIMITS.minKobo, 100_000);
  assert.equal(TICKET_LIMITS.maxKobo, 10_000_000);
  assert.equal(TICKET_LIMITS.capacityMin, 20);
  assert.equal(TICKET_LIMITS.capacityMax, 150);
  const lib = src("../client/src/lib/roomTickets.ts");
  assert.ok(/minKobo: ROOM_LIMITS\.ticketMinKobo/.test(lib), "imported, not copied");
});
test("price and capacity: whole numbers in range only; the stepper clamps", () => {
  assert.equal(priceKoboOf(5000), 500_000);
  assert.equal(priceKoboOf(1000), 100_000);
  assert.equal(priceKoboOf(100_000), 10_000_000);
  for (const bad of [999, 100_001, 5000.5, Number.NaN, -1, 0]) assert.equal(priceKoboOf(bad), null, String(bad));
  assert.equal(clampPriceNaira(500), 1000);
  assert.equal(clampPriceNaira(200_000), 100_000);
  assert.equal(clampPriceNaira(Number.NaN), TICKET_LIMITS.defaultPriceNaira);
  assert.equal(clampTicketCapacity(5), 20);
  assert.equal(clampTicketCapacity(500), 150);
  const d = { ...defaultTicketDraft(), on: true };
  assert.equal(ticketDraftProblem(d), null);
  assert.equal(ticketDraftProblem({ ...d, priceNaira: 999 })?.field, "ticketPriceKobo");
  assert.equal(ticketDraftProblem({ ...d, capacity: 151 })?.field, "ticketCapacity");
  assert.equal(ticketDraftProblem({ ...d, capacity: 19 })?.field, "ticketCapacity");
  assert.equal(ticketDraftProblem({ ...d, on: false, priceNaira: 1 }), null, "a free room is never checked for a price");
});
test("earnings estimate comes from ticketBreakdown, shown in whole naira rounded down (about ₦3,762 per ticket)", () => {
  const e = earningsEstimate(5000, 100)!;
  assert.equal(e.perTicketKobo, ticketBreakdown(500_000).host);
  assert.equal(estimateText(e.perTicketKobo), "about ₦3,762");
  assert.equal(e.half, 50);
  assert.equal(e.halfKobo, e.perTicketKobo * 50);
  assert.equal(estimateText(e.halfKobo), `about ${formatNairaWhole(e.halfKobo, "floor")}`);
  assert.ok(!/\./.test(estimateText(e.halfKobo)), "no kobo");
  assert.equal(earningsEstimate(999, 100), null);
  const step = src("../client/src/components/rooms/create/StepPrice.tsx");
  assert.ok(/earningsEstimate\(draft\.priceNaira, draft\.capacity, /.test(step), "the step passes the saved rates");
  assert.ok(step.includes("estimateText(est.perTicketKobo)") && step.includes("estimateText(est.halfKobo)"));
  // M7: aria-live only on the two numbers, not the whole box
  assert.ok(!/data-testid="price-estimate"[^>]*aria-live/.test(step) && !/aria-live="polite" data-testid="price-estimate"/.test(step));
  assert.equal((step.match(/aria-live="polite"/g) ?? []).length, 2);
  const lib = src("../client/src/lib/roomTickets.ts");
  assert.ok(/ticketBreakdown\(kobo, /.test(lib) && /\)\.host/.test(lib), "the estimate uses the shared breakdown (with the saved rates), no fee math of its own");
});
test("wizard payload: ticket fields only when the price step is enabled and switched on", () => {
  const s = defaultWizardState({ title: "Amapiano Sunday", ageLimit: "18+" });
  const draft = { ...defaultTicketDraft(), on: true, priceNaira: 5000, capacity: 100, refundBeforeStart: false };
  const free = buildCreatePayload(s) as unknown as Record<string, unknown>;
  for (const k of ["ticketPriceKobo", "ticketCapacity", "refundBeforeStart"]) assert.equal(k in free, false, k);
  const off = buildCreatePayload(s, { ticket: draft, ticketsEnabled: false }) as unknown as Record<string, unknown>;
  for (const k of ["ticketPriceKobo", "ticketCapacity", "refundBeforeStart"]) assert.equal(k in off, false, `flag off: ${k}`);
  const notOn = buildCreatePayload(s, { ticket: { ...draft, on: false }, ticketsEnabled: true }) as unknown as Record<string, unknown>;
  assert.equal("ticketPriceKobo" in notOn, false, "switch off: free room");
  const paid = buildCreatePayload(s, { ticket: draft, ticketsEnabled: true });
  assert.equal(paid.ticketPriceKobo, 500_000);
  assert.equal(paid.ticketCapacity, 100);
  assert.equal(paid.refundBeforeStart, false);
  assert.equal(paid.capacity, s.capacity, "the free capacity field is unchanged");
  assert.deepEqual(ticketPayload(undefined, true), {});
  // An out-of-range price is still sent as typed (kobo) so the server names the field.
  assert.equal((ticketPayload({ ...draft, priceNaira: 999 }, true) as { ticketPriceKobo: number }).ticketPriceKobo, 99_900);
});
test("price step shows only with the flag on and money unlocked; the free path keeps its five steps", () => {
  const adult = { age: 30, accountAgeDays: 400, idVerifiedAdult: true };
  const teen = { age: 15, accountAgeDays: 400, idVerifiedAdult: false };
  const on = { paidRooms: true, spray: false }, off = { paidRooms: false, spray: false };
  const adultRoom = defaultWizardState({ title: "x", ageLimit: "18+" });
  assert.equal(priceStepAvailable(true, wizardOptions(adult, on, 0, "18+").moneyLocked), true);
  assert.equal(priceStepAvailable(false, wizardOptions(adult, off, 0, "18+").moneyLocked), false);
  assert.equal(priceStepAvailable(true, wizardOptions(adult, on, 0, "13+").moneyLocked), false, "not an adult room");
  assert.equal(priceStepAvailable(true, wizardOptions(teen, on, 0, "18+").moneyLocked), false, "teen host");
  assert.equal(priceStepAvailable(true, undefined), false, "options not loaded yet");
  assert.deepEqual(uiSteps(stepsFor(adultRoom, on, adult), true), ["basics", "audience", "features", "money", "when", "review"]);
  assert.deepEqual(uiSteps(stepsFor(adultRoom, on, adult), false), ["basics", "audience", "features", "when", "review"], "switch off");
  assert.deepEqual(uiSteps(stepsFor(adultRoom, off, adult), true), ["basics", "audience", "features", "when", "review"], "flag off");
  assert.deepEqual(uiSteps(["basics", "price", "review"], true), ["basics", "review"], "unknown names still skipped");
  assert.equal(isKnownStep("money"), false, "the free path's known steps are unchanged");
  assert.equal(uiStepTitle("money"), PRICE_COPY.title);
  assert.equal(uiStepTitle("when"), "When does it start?");
});
test("wizard wires the price step through the shared rules and sends tickets only when on", () => {
  const wiz = src("../client/src/components/rooms/create/CreateRoomWizard.tsx");
  assert.ok(wiz.includes("priceStepAvailable(flags.paidRooms, options?.moneyLocked)"));
  assert.ok(wiz.includes("const priceStepOn = priceAvailable && ticket.on;"));
  assert.ok(wiz.includes("ticketsEnabled: priceStepOn"));
  assert.ok(/current === "money" && priceStepOn \?/.test(wiz));
  assert.ok(wiz.includes("money={{ view: money,"), "the Money section replaces the old placeholder");
  const features = src("../client/src/components/rooms/create/StepFeatures.tsx");
  assert.ok(/\{money && \(/.test(features), "the Money section (Paid room and Spray) exists only when the page passes it");
});
test("M4: review shows the ticket count; live video is off above liveVideoMax tickets and not asked for", () => {
  assert.equal(ROOM_LIMITS.liveVideoMax, 50);
  assert.equal(ticketsTooManyForVideo({ on: true, capacity: 51 }), true);
  assert.equal(ticketsTooManyForVideo({ on: true, capacity: 50 }), false);
  assert.equal(ticketsTooManyForVideo({ on: true, capacity: Number.NaN }), true);
  assert.equal(ticketsTooManyForVideo({ on: false, capacity: 150 }), false, "a free room is not touched");
  const wiz = src("../client/src/components/rooms/create/CreateRoomWizard.tsx");
  assert.ok(wiz.includes("createRoom(withVideoRule({ ...s, sprayEnabled: sprayOn })"), "live video is not requested");
  assert.ok(wiz.includes("<StepReview state={withVideoRule(state)}"));
  assert.ok(wiz.includes("ticketCount={ticketKobo !== null ? ticket.capacity : null}"));
  assert.ok(wiz.includes("videoBlocked={videoOverTickets ? PRICE_COPY.videoNeedsFewer : null}"));
  const review = src("../client/src/components/rooms/create/StepReview.tsx");
  assert.ok(review.includes("ticketCount !== null ? PRICE_COPY.reviewTickets(ticketCount) : `up to ${state.capacity}`"));
  const step = src("../client/src/components/rooms/create/StepPrice.tsx");
  assert.ok(step.includes("liveVideo && ticketsTooManyForVideo(draft)"));
});

// ---------------------------------------------------------------- host sales (C1)
test("summary parser reads the real body { summary: {...} }; payout optional; junk refused", () => {
  const body = fixtureTicketSummary(38);
  const s = parseSummary(body)!;
  assert.ok(s, "parses");
  const { payout, ...rest } = body.summary;
  assert.deepEqual({ ...s, payout: null }, { ...rest, payout: null });
  assert.deepEqual(s.payout, payout);
  assert.equal(parseSummary(body.summary), null, "a flat body is not the route's shape");
  assert.equal(parseSummary({ summary: { ...body.summary, refusedCharges: { count: 1, grossKobo: 500_000 } } })?.sold, 38, "extra fields ignored");
  assert.equal(parseSummary(fixtureTicketSummary(0, null))?.payout, null);
  assert.equal(parseSummary({ summary: { ...body.summary, payout: { ...payout!, releaseAt: "not a date" } } })?.payout?.releaseAt, null);
  for (const bad of [null, "x", {}, { summary: null }, { summary: { ...body.summary, sold: -1 } }, { summary: { ...body.summary, grossKobo: 1.5 } }, { summary: { ...body.summary, hostKobo: "5" } }, { summary: { ...body.summary, vatKobo: undefined } }]) {
    assert.equal(parseSummary(bad), null, JSON.stringify(bad));
  }
});
test("host sales lines: whole naira, costs = vat + fee + reserve, earnings rounded down (img/f-hostsales)", () => {
  const s = parseSummary(fixtureTicketSummary(38))!;
  const l = salesLines(s);
  assert.equal(l.gross, "₦190,000");
  assert.equal(l.costs, formatDeduction(s.vatKobo + s.feeKobo + s.reserveKobo));
  assert.equal(l.costs, "−₦21,806");
  assert.equal(l.platform, formatDeduction(s.platformKobo));
  assert.equal(l.earn, "₦142,965", "matches img/f-hostsales, rounded down");
  for (const v of Object.values(l)) assert.ok(!/\./.test(v), `no kobo: ${v}`);
  const zero = parseSummary(fixtureTicketSummary(0, null, 0))!;
  assert.equal(salesLines(zero).costs, formatDeduction(0));
});
test("sold out comes from the host room's capacity; the payout line from the payout row", () => {
  assert.equal(salesSoldOut(100, 100), true);
  assert.equal(salesSoldOut(99, 100), false);
  assert.equal(salesSoldOut(5, null), false);
  const when = (iso: string) => `at ${iso}`;
  assert.equal(salesReleaseLine(null, when), SALES_COPY.heldAfterEnd);
  assert.equal(salesReleaseLine({ status: "held", amountKobo: 1, releaseAt: "2026-10-22T20:00:00.000Z", paidAt: null }, when), SALES_COPY.heldUntil("at 2026-10-22T20:00:00.000Z"));
  assert.equal(salesReleaseLine({ status: "paid", amountKobo: 1, releaseAt: "2026-10-22T20:00:00.000Z", paidAt: "2026-10-22T21:00:00.000Z" }, when), SALES_COPY.paidOn("at 2026-10-22T21:00:00.000Z"));
  const hs = src("../client/src/components/rooms/tickets/HostSales.tsx");
  assert.ok(hs.includes("salesSoldOut(summary.sold, capacity)") && hs.includes("fetchTicketSummary(room.id, token)"));
  assert.ok(SALES_COPY.heldUntil("Mon 20 Oct").includes("Mon 20 Oct"));
});

// ---------------------------------------------------------------- amber contrast
test("amber fill with its own text colour passes 4.5:1 on both themes (from index.css)", () => {
  const css = src("../client/src/index.css");
  const light = css.slice(css.indexOf(":root"), css.indexOf(".dark"));
  const dark = css.slice(css.indexOf(".dark"));
  const v = (block: string, name: string) => { const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block); assert.ok(m, name); return hslTripletToHex(m![1]); };
  for (const [label, block] of [["light", light], ["dark", dark]] as const) {
    const ratio = contrastRatio(v(block, "secondary"), v(block, "secondary-foreground"));
    assert.ok(ratio >= 4.5, `${label}: amber fill ${ratio.toFixed(2)}:1`);
  }
  // and why amber is never text on the page: on the light background it is far below 4.5:1
  assert.ok(contrastRatio(v(light, "secondary"), v(light, "background")) < 4.5);
});
test("contrast helper sanity", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(hslTripletToHex("0 0% 100%"), "#ffffff");
  assert.equal(hslTripletToHex("0 0% 0%"), "#000000");
  assert.throws(() => contrastRatio("red", "#fff"));
});
test("amber only for money moments; never amber text classes; the ticket cover is violet only (M3)", () => {
  for (const cls of Object.values(AMBER)) assert.ok(!/\btext-secondary\b(?!-)/.test(cls), cls);
  const dir = new URL("../client/src/components/rooms/tickets/", import.meta.url);
  for (const f of ["TicketPage.tsx", "Checkout.tsx", "TicketConfirmed.tsx", "WaitingRoom.tsx", "HostSales.tsx", "RefundButton.tsx"]) {
    const s = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/\btext-secondary\b(?!-)/.test(s), `${f}: amber text`);
    assert.ok(!/amber-\d|yellow-\d/.test(s), `${f}: raw palette instead of the token`);
  }
  const checkout = readFileSync(new URL("Checkout.tsx", dir), "utf8");
  assert.ok(!/AMBER/.test(checkout), "the progress and error screens use violet and destructive only");
  const page = readFileSync(new URL("TicketPage.tsx", dir), "utf8");
  const cover = /bg-gradient-to-br [^"]*/.exec(page)?.[0] ?? "";
  assert.ok(cover && !/secondary/.test(cover), `cover gradient: ${cover}`);
});
test("M7: every bare ticket screen has an h1", () => {
  const dir = new URL("../client/src/components/rooms/tickets/", import.meta.url);
  for (const f of ["TicketPage.tsx", "Checkout.tsx", "TicketConfirmed.tsx", "WaitingRoom.tsx"]) {
    assert.ok(/<h1\b/.test(readFileSync(new URL(f, dir), "utf8")), f);
  }
});

// ---------------------------------------------------------------- fixture (M8)
test("fixture: ticket scenes parse, keep the old scenes, and the fake fetch is installed before children mount", () => {
  assert.equal(parseTicketFixture("?ticket=page"), "page");
  assert.equal(parseTicketFixture("?ticket=hostsales"), "hostsales");
  assert.equal(parseTicketFixture("?ticket=nope"), null);
  assert.equal(parseTicketFixture(""), null);
  assert.equal(FIXTURE_TICKET.code.length <= 8, true);
  assert.equal(parseTicketBlock(FIXTURE_TICKET_BLOCK)?.left, 62);
  assert.equal(parseTicketBlock(FIXTURE_TICKET_BLOCK)?.refundBeforeStart, true);
  assert.ok(parseSummary(fixtureTicketSummary()), "the fixture summary has the route's real shape");
  const fx = src("../client/src/pages/dev/RoomFixture.tsx");
  const t = fx.slice(fx.indexOf("function TicketFixture"), fx.indexOf("export default function RoomFixture"));
  assert.ok(/useLayoutEffect\(\(\) => \{\s*const real = window\.fetch/.test(t));
  for (const p of ["/tickets/checkout", "/tickets/verify", "/tickets/refund", "/tickets/summary", "/cancel", "/api/csrf-token"]) assert.ok(t.includes(p), p);
  assert.ok(t.includes("reference: FIXTURE_TICKET_REF") && !t.includes('"fx-ref"'));
  assert.ok(t.includes("parseSummary(fixtureTicketSummary())"));
  assert.ok(fx.includes("parseControlsFixture") && fx.includes("STATE_SCENES") && fx.includes("WizardFixture"), "existing scenes kept");
});

// ---------------------------------------------------------------- copy rules
test("copy: no em or en dashes, never 'cash', never 'anonymous' in any ticket line", () => {
  assert.ok(TICKET_UI_COPY.length > 80);
  for (const line of TICKET_UI_COPY) {
    assert.equal(/[—–]/.test(line), false, `dash in: ${line}`);
    assert.equal(/cash/i.test(line), false, `cash in: ${line}`);
    assert.equal(/anonymous/i.test(line), false, `anonymous in: ${line}`);
  }
  assert.equal(TICKET_COPY.getTicket(formatNaira(500_000)), "Get ticket · ₦5,000");
  assert.equal(TICKET_COPY.includesVat, "Price includes VAT");
});
test("copy: the ticket files hold no em dashes, 'cash' or 'anonymous', and icons come from the icon set", () => {
  const files = [
    "../client/src/components/rooms/tickets/TicketPage.tsx", "../client/src/components/rooms/tickets/Checkout.tsx",
    "../client/src/components/rooms/tickets/TicketConfirmed.tsx", "../client/src/components/rooms/tickets/WaitingRoom.tsx",
    "../client/src/components/rooms/tickets/HostSales.tsx", "../client/src/components/rooms/tickets/RefundButton.tsx",
    "../client/src/components/rooms/tickets/ticketsApi.ts", "../client/src/components/rooms/create/StepPrice.tsx",
    "../client/src/lib/roomTickets.ts",
  ];
  for (const f of files) {
    const s = src(f);
    assert.ok(!/[—–]/.test(s), `${f}: dash`);
    assert.ok(!/\bcash\b/i.test(s), `${f}: cash`);
    assert.ok(!/anonymous/i.test(s), `${f}: anonymous`);
    assert.ok(!/from "lucide-react"/.test(s), `${f}: icons must come from @/components/ui/icons`);
  }
});
test("ticket confirmed has a short code and no QR in this phase", () => {
  const s = src("../client/src/components/rooms/tickets/TicketConfirmed.tsx");
  assert.ok(s.includes("ticket.code"));
  assert.ok(!/qr/i.test(s.replace(/no QR/gi, "")), "no QR");
});

// ---------------------------------------------------------------- saved ticket rates (rooms rates plan, task 4)
test("earnings estimate follows the saved ticket rates, and no rates means today's defaults", () => {
  const rates = { ticketPlatformPct: 20, ticketReservePct: 2.5 };
  const withRates = earningsEstimate(5000, 100, rates)!;
  assert.equal(withRates.perTicketKobo, ticketBreakdown(500_000, { ...DEFAULT_RATES, ticket_platform: 20, ticket_reserve: 2.5 }).host);
  assert.ok(withRates.perTicketKobo < earningsEstimate(5000, 100)!.perTicketKobo, "a higher platform share means the host earns less");
  assert.equal(earningsEstimate(5000, 100)!.perTicketKobo, ticketBreakdown(500_000).host);
  assert.equal(earningsEstimate(5000, 100, undefined)!.perTicketKobo, earningsEstimate(5000, 100)!.perTicketKobo);
  assert.equal(earningsEstimate(999, 100, rates), null);
});
test("the fees note states the percent it is given, not a fixed 15", () => {
  assert.equal(PRICE_COPY.feesNote(20), "After VAT (7.5%), card fees and a fraud reserve, we take 20%. Price includes VAT.");
  assert.equal(PRICE_COPY.feesNote(12.5), "After VAT (7.5%), card fees and a fraud reserve, we take 12.5%. Price includes VAT.");
});
test("the host sales screen no longer prints a fixed platform percent (past tickets may carry different rates)", () => {
  assert.equal(SALES_COPY.platform, "Platform share");
});
test("no client file prints the fixed ticket percent, and the price step reads the saved rates from the config", () => {
  const tickets = src("../client/src/lib/roomTickets.ts");
  assert.ok(!/TICKET_PLATFORM_PCT/.test(tickets), "roomTickets.ts must not use TICKET_PLATFORM_PCT");
  const step = src("../client/src/components/rooms/create/StepPrice.tsx");
  assert.ok(step.includes("useRoomsConfig") && step.includes("rates"), "StepPrice must read the saved rates from the config");
  const api = src("../client/src/lib/roomsApi.ts");
  assert.ok(/rates\?: \{ ticketPlatformPct: number; ticketReservePct: number \}/.test(api), "RoomsConfig must carry the two ticket rates");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
