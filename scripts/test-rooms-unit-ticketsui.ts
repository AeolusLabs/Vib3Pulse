// Paid room tickets on the client (task 4.7), pure helpers and source checks (no database, no browser):
//   npx tsx scripts/test-rooms-unit-ticketsui.ts
// Written, not run (owner's no-testing rule for phase 4). Runs under npm run test:rooms with the other unit suites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ticketBreakdown } from "../shared/money";
import {
  AMBER, PRICE_COPY, REFUND_CLOSE_MS, REFUND_COPY, SALES_COPY, TICKET_COPY, TICKET_CREATE_ERROR, TICKET_ERROR, TICKET_LIMITS, TICKET_UI_COPY,
  afterTicketRefusal, clampPriceNaira, clampTicketCapacity, contrastRatio, defaultTicketDraft, earningsEstimate, formatDeduction, formatNaira,
  hslTripletToHex, isTicketFailure, parseSummary, parseTicketBlock, priceKoboOf, priceStepAvailable, refundPromise, refundWindow, returnRef,
  safeCheckoutUrl, salesLines, searchWithoutRef, showsPrice, ticketCreateMessage, ticketDraftProblem, ticketErrorMessage, ticketFieldSelectors,
  ticketGate, ticketPayload, ticketsLeftText, waitingClock, waitingTickMs,
} from "../client/src/lib/roomTickets";
import { DENIED_MESSAGE } from "../client/src/lib/roomsApi";
import { buildCreatePayload, defaultWizardState, isKnownStep, uiStepTitle, uiSteps } from "../client/src/lib/createRoomWizardUi";
import { stepsFor, wizardOptions } from "../client/src/lib/createRoomRules";
import { FIXTURE_TICKET, FIXTURE_TICKET_BLOCK, fixtureTicketSummary, parseTicketFixture } from "../client/src/lib/roomFixtures";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

const BLOCK = { required: true, priceKobo: 500_000, held: false, soldOut: false };

// ---------------------------------------------------------------- formatNaira
test("formatNaira: whole naira with a naira sign and thousands commas", () => {
  assert.equal(formatNaira(500_000), "₦5,000");
  assert.equal(formatNaira(100_000), "₦1,000");
  assert.equal(formatNaira(10_000_000), "₦100,000");
  assert.equal(formatNaira(0), "₦0");
  assert.equal(formatNaira(19_000_000), "₦190,000");
});
test("formatNaira: kobo shows two decimals, never float noise", () => {
  assert.equal(formatNaira(376_224), "₦3,762.24");
  assert.equal(formatNaira(5), "₦0.05");
  assert.equal(formatNaira(14_296_512), "₦142,965.12");
});
test("formatNaira: negatives use a minus sign (not a dash), junk is zero", () => {
  assert.equal(formatNaira(-2_180_600), "−₦21,806");
  assert.equal(formatDeduction(2_180_600), "−₦21,806");
  assert.equal(formatDeduction(-2_180_600), "−₦21,806");
  assert.equal(formatNaira(Number.NaN), "₦0");
  assert.equal(formatNaira(Infinity), "₦0");
  assert.ok(!/[—–]/.test(formatDeduction(100)));
});

// ---------------------------------------------------------------- who sees what
test("no ticket block means no price, for anyone (teen, unverified, signed out, free room)", () => {
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
test("the ticket block keeps only known fields; optional counts only as whole numbers", () => {
  const b = parseTicketBlock({ ...BLOCK, left: 62, capacity: 100, extra: "x" })!;
  assert.deepEqual(b, { ...BLOCK, left: 62, capacity: 100 });
  assert.deepEqual(parseTicketBlock({ ...BLOCK, left: -1, capacity: 1.5 }), BLOCK);
  assert.equal(ticketsLeftText(b), "62 of 100");
  assert.equal(ticketsLeftText(BLOCK), TICKET_COPY.onSale);
  assert.equal(ticketsLeftText({ ...b, soldOut: true }), TICKET_COPY.soldOut);
});
test("the plain refusal line has no price and no naira", () => {
  assert.equal(DENIED_MESSAGE.TICKET_REQUIRED, "You need a ticket to join this room.");
  assert.ok(!/₦|\d/.test(DENIED_MESSAGE.TICKET_REQUIRED));
});
test("RoomPage draws a price only through the ticket block, after the minors and age screens", () => {
  const page = src("../client/src/pages/RoomPage.tsx");
  assert.ok(page.includes("ticketBlock && showsPrice(gate)"), "the ticket page needs the parsed block");
  assert.ok(page.includes("<TicketPage room={room} host={detail.host} ticket={ticketBlock}"));
  assert.ok(page.indexOf("<MinorsRoomWarning") < page.indexOf("<TicketPage"), "minors' warning first");
  assert.ok(page.indexOf("DENIED_MESSAGE.AGE_UNKNOWN") < page.indexOf("<TicketPage"), "age unknown first");
  assert.ok(page.indexOf('room.status === "ended"') < page.indexOf("<TicketPage"), "no price on an ended room");
  assert.ok(!/priceKobo\s*[:=]\s*\d/.test(page), "never a hard-coded or inferred price");
  assert.ok(/state\.error === "TICKET_REQUIRED"/.test(page), "the socket refusal reloads the room");
});
test("components read the price from the block or the ticket, never compute a charge", () => {
  const dir = new URL("../client/src/components/rooms/tickets/", import.meta.url);
  const page = readFileSync(new URL("TicketPage.tsx", dir), "utf8");
  assert.ok(page.includes("formatNaira(ticket.priceKobo)"));
  assert.ok(!/ticketBreakdown/.test(page), "the buyer's page never computes fees");
  const api = readFileSync(new URL("ticketsApi.ts", dir), "utf8");
  assert.ok(/tickets\/checkout`, \{\}\)/.test(api), "checkout posts an empty body: no client price");
  assert.ok(!/amount|price/i.test(api.slice(api.indexOf("startCheckout"), api.indexOf("const inFlight"))), "no amount in the checkout call");
});

// ---------------------------------------------------------------- double click and redirect safety
test("Get ticket is guarded against a double click by a ref and a disabled busy button", () => {
  const page = src("../client/src/components/rooms/tickets/TicketPage.tsx");
  assert.ok(/if \(pending\.current \|\| soldOut\) return;/.test(page));
  assert.ok(/pending\.current = true; setBusy\(true\)/.test(page));
  assert.ok(/disabled=\{busy \|\| soldOut\}/.test(page));
  assert.ok(/aria-busy=\{busy \|\| undefined\}/.test(page));
  assert.ok(/window\.location\.assign/.test(page));
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
test("return reference: ref first, then Paystack's reference and trxref; junk ignored; removal keeps other params", () => {
  assert.equal(returnRef("?ref=room-abc_123"), "room-abc_123");
  assert.equal(returnRef("?trxref=T1&reference=T1"), "T1");
  assert.equal(returnRef("?reference=T2"), "T2");
  assert.equal(returnRef("?ref=%3Cscript%3E"), null);
  assert.equal(returnRef("?ref="), null);
  assert.equal(returnRef("?ref=" + "a".repeat(201)), null);
  assert.equal(returnRef(""), null);
  assert.equal(searchWithoutRef("?token=t1&ref=r&trxref=r&reference=r"), "?token=t1");
  assert.equal(searchWithoutRef("?ref=r"), "");
});

// ---------------------------------------------------------------- refusals to plain words
test("checkout codes map to plain words", () => {
  assert.equal(ticketErrorMessage({ status: 409, code: "ALREADY_TICKETED" }, "checkout"), TICKET_ERROR.alreadyTicketed);
  assert.equal(ticketErrorMessage({ status: 403, code: "FEATURE_OFF" }, "checkout"), TICKET_ERROR.featureOff);
  assert.equal(ticketErrorMessage({ status: 404 }, "checkout"), TICKET_ERROR.notFound);
  assert.equal(ticketErrorMessage({ status: 409, code: "SOLD_OUT" }, "checkout"), TICKET_ERROR.soldOut);
  assert.equal(ticketErrorMessage({ status: 403, code: "INELIGIBLE" }, "checkout"), TICKET_ERROR.ineligible);
  assert.equal(ticketErrorMessage({ status: 0 }, "checkout"), TICKET_ERROR.offline);
  assert.equal(ticketErrorMessage({ status: 429 }, "checkout"), TICKET_ERROR.rateLimited);
  assert.equal(ticketErrorMessage({ status: 500, code: "WHATEVER" }, "checkout"), TICKET_ERROR.checkoutGeneric);
});
test("verify codes say what happens to the money", () => {
  assert.equal(ticketErrorMessage({ status: 409, code: "SOLD_OUT" }, "verify"), TICKET_ERROR.verifySoldOut);
  assert.equal(ticketErrorMessage({ status: 409, code: "AMOUNT_MISMATCH" }, "verify"), TICKET_ERROR.verifyMismatch);
  assert.equal(ticketErrorMessage({ status: 403, code: "INELIGIBLE" }, "verify"), TICKET_ERROR.verifyIneligible);
  assert.equal(ticketErrorMessage({ status: 402, code: "PAYMENT_FAILED" }, "verify"), TICKET_ERROR.verifyFailed);
  assert.equal(ticketErrorMessage({ status: 202, code: "PAYMENT_PENDING" }, "verify"), TICKET_ERROR.verifyPending);
  assert.equal(ticketErrorMessage({ status: 500 }, "verify"), TICKET_ERROR.verifyGeneric);
  assert.ok(/never be charged twice/.test(TICKET_ERROR.verifyGeneric), "retry is safe and says so");
});
test("refund, summary and cancel codes", () => {
  assert.equal(ticketErrorMessage({ status: 409, code: "NOT_ALLOWED" }, "refund"), TICKET_ERROR.refundClosed);
  assert.equal(ticketErrorMessage({ status: 404 }, "refund"), TICKET_ERROR.refundNone);
  assert.equal(ticketErrorMessage({ status: 500 }, "refund"), TICKET_ERROR.refundGeneric);
  assert.equal(ticketErrorMessage({ status: 403 }, "summary"), TICKET_ERROR.notHost);
  assert.equal(ticketErrorMessage({ status: 500 }, "summary"), TICKET_ERROR.summaryGeneric);
  assert.equal(ticketErrorMessage({ status: 500 }, "cancel"), TICKET_ERROR.cancelGeneric);
});
test("create/patch ticket refusals belong to the price step", () => {
  for (const code of Object.keys(TICKET_CREATE_ERROR)) {
    assert.equal(isTicketFailure({ code }), true, code);
    assert.equal(ticketCreateMessage({ code }), TICKET_CREATE_ERROR[code]);
  }
  for (const field of ["ticketPriceKobo", "ticketCapacity", "refundBeforeStart"]) {
    assert.equal(isTicketFailure({ field }), true, field);
    assert.ok(ticketCreateMessage({ field }));
    assert.ok(ticketFieldSelectors(field).length > 0, field);
  }
  assert.equal(isTicketFailure({ code: "TEEN_PUBLIC" }), false);
  assert.equal(ticketCreateMessage({ code: "TEEN_PUBLIC" }), null);
  // the selectors are the ids StepPrice renders
  const step = src("../client/src/components/rooms/create/StepPrice.tsx") + src("../client/src/components/rooms/create/parts.tsx");
  assert.ok(step.includes('id="wiz-price"') && step.includes('id="wiz-ticket-cap"') && step.includes('id="wiz-refund"'));
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

// ---------------------------------------------------------------- refund window
test("refund window: open until 1 hour before the start, only when the host offered it", () => {
  const start = Date.UTC(2026, 9, 20, 20, 0);
  const room = { status: "scheduled" as const, scheduledFor: new Date(start).toISOString(), refundBeforeStart: true };
  const open = refundWindow(room, "paid", start - REFUND_CLOSE_MS - 1);
  assert.equal(open.open, true);
  if (open.open) assert.equal(open.closesAt, start - 60 * 60_000);
  assert.deepEqual(refundWindow(room, "paid", start - REFUND_CLOSE_MS), { open: false, reason: REFUND_COPY.closedHour });
  assert.deepEqual(refundWindow(room, "paid", start + 1), { open: false, reason: REFUND_COPY.closedHour });
  assert.deepEqual(refundWindow({ ...room, refundBeforeStart: false }, "paid", start - 86_400_000), { open: false, reason: REFUND_COPY.closedHost });
  assert.deepEqual(refundWindow({ ...room, status: "live" }, "paid", start - 86_400_000), { open: false, reason: REFUND_COPY.closedStarted });
  assert.deepEqual(refundWindow({ ...room, status: "ended" }, "paid", start - 86_400_000), { open: false, reason: REFUND_COPY.closedStarted });
  assert.deepEqual(refundWindow({ ...room, scheduledFor: null }, "paid", 0), { open: false, reason: REFUND_COPY.closedNoSchedule });
  assert.deepEqual(refundWindow(room, "refunded", 0), { open: false, reason: REFUND_COPY.closedRefunded });
  // unknown refundBeforeStart (an older payload) is left to the server
  assert.equal(refundWindow({ status: "scheduled", scheduledFor: room.scheduledFor }, "paid", start - 86_400_000).open, true);
});
test("refund promise: the 1 hour line only when the host offered it on a scheduled room; the automatic refund always", () => {
  assert.equal(refundPromise({ scheduledFor: "2026-10-20T20:00:00Z", refundBeforeStart: true }), "Full refund up to 1 hour before. If the room does not start, you are refunded automatically.");
  assert.equal(refundPromise({ scheduledFor: "2026-10-20T20:00:00Z", refundBeforeStart: false }), "If the room does not start, you are refunded automatically.");
  assert.equal(refundPromise({ scheduledFor: "2026-10-20T20:00:00Z" }), "If the room does not start, you are refunded automatically.");
  assert.equal(refundPromise({ scheduledFor: null, refundBeforeStart: true }), "If the room does not start, you are refunded automatically.");
});
test("refund button confirms first, is destructive, and treats not_allowed as a failure", () => {
  const b = src("../client/src/components/rooms/tickets/RefundButton.tsx");
  assert.ok(b.includes("AlertDialogContent") && b.includes('variant="destructive"'));
  assert.ok(/disabled=\{!win\.open \|\| busy\}/.test(b));
  assert.ok(/result === "refunded"/.test(b) && /result === "already"/.test(b));
  assert.ok(!/amber|bg-secondary/i.test(b), "refunds use the destructive token, never amber");
});

// ---------------------------------------------------------------- price step and payload
test("price limits mirror the shared contract (1,000 to 100,000 naira, 20 to 150 tickets)", () => {
  assert.equal(TICKET_LIMITS.minKobo, 100_000);
  assert.equal(TICKET_LIMITS.maxKobo, 10_000_000);
  assert.equal(TICKET_LIMITS.capacityMin, 20);
  assert.equal(TICKET_LIMITS.capacityMax, 150);
  // Once lane S1's limits land in shared/rooms.ts, they must match these.
  const shared = src("../shared/rooms.ts");
  const num = (name: string) => { const m = new RegExp(`${name}\\s*[:=]\\s*([\\d_]+)`).exec(shared); return m ? Number(m[1].replace(/_/g, "")) : null; };
  for (const [name, want] of [["ticketMinKobo", 100_000], ["ticketMaxKobo", 10_000_000], ["ticketCapacityMin", 20], ["ticketCapacityMax", 150]] as const) {
    const got = num(name);
    if (got !== null) assert.equal(got, want, name);
  }
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
test("earnings estimate comes from ticketBreakdown (₦5,000 gives about ₦3,762 per ticket, as on the board)", () => {
  const e = earningsEstimate(5000, 100)!;
  assert.equal(e.perTicketKobo, ticketBreakdown(500_000).host);
  assert.equal(formatNaira(e.perTicketKobo).startsWith("₦3,762"), true);
  assert.equal(e.half, 50);
  assert.equal(e.halfKobo, e.perTicketKobo * 50);
  assert.equal(earningsEstimate(999, 100), null);
  const step = src("../client/src/components/rooms/create/StepPrice.tsx");
  assert.ok(/earningsEstimate\(draft\.priceNaira, draft\.capacity\)/.test(step));
  const lib = src("../client/src/lib/roomTickets.ts");
  assert.ok(/ticketBreakdown\(kobo\)\.host/.test(lib), "the estimate uses the shared breakdown, no fee math of its own");
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
  assert.ok(wiz.includes("moneyPlaceholder={moneyPlaceholder && !priceAvailable}"));
  const features = src("../client/src/components/rooms/create/StepFeatures.tsx");
  assert.ok(/\{paid && \(/.test(features), "the Paid room switch exists only when the page passes it");
});

// ---------------------------------------------------------------- host sales
test("host sales lines come from the summary; the costs line is the remainder", () => {
  const s = fixtureTicketSummary(38);
  const l = salesLines(s);
  assert.equal(l.gross, "₦190,000");
  assert.equal(l.earn, formatNaira(s.hostKobo));
  assert.equal(l.platform, formatDeduction(s.platformKobo));
  assert.equal(l.costs, formatDeduction(s.grossKobo - s.platformKobo - s.hostKobo));
  assert.ok(l.earn.startsWith("₦142,965"), "matches img/f-hostsales");
  assert.equal(salesLines({ ...s, grossKobo: 0, platformKobo: 0, hostKobo: 0 }).costs, formatDeduction(0));
});
test("summary parser refuses anything but whole, non-negative numbers", () => {
  const s = fixtureTicketSummary();
  assert.deepEqual(parseSummary(s), s);
  assert.equal(parseSummary({ ...s, releaseAt: "not a date" })?.releaseAt, null);
  for (const bad of [null, "x", { ...s, sold: -1 }, { ...s, grossKobo: 1.5 }, { ...s, soldOut: "no" }, { ...s, hostKobo: "5" }]) assert.equal(parseSummary(bad), null);
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
test("amber only for money moments; never amber text classes", () => {
  for (const cls of Object.values(AMBER)) assert.ok(!/\btext-secondary\b(?!-)/.test(cls), cls);
  const dir = new URL("../client/src/components/rooms/tickets/", import.meta.url);
  for (const f of ["TicketPage.tsx", "Checkout.tsx", "TicketConfirmed.tsx", "WaitingRoom.tsx", "HostSales.tsx", "RefundButton.tsx"]) {
    const s = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/\btext-secondary\b(?!-)/.test(s), `${f}: amber text`);
    assert.ok(!/amber-\d|yellow-\d/.test(s), `${f}: raw palette instead of the token`);
  }
  const checkout = readFileSync(new URL("Checkout.tsx", dir), "utf8");
  assert.ok(!/AMBER/.test(checkout), "the progress and error screens use violet and destructive only");
});

// ---------------------------------------------------------------- fixture
test("fixture: ticket scenes parse, keep the old scenes, and the fake fetch is installed before children mount", () => {
  assert.equal(parseTicketFixture("?ticket=page"), "page");
  assert.equal(parseTicketFixture("?ticket=hostsales"), "hostsales");
  assert.equal(parseTicketFixture("?ticket=nope"), null);
  assert.equal(parseTicketFixture(""), null);
  assert.equal(FIXTURE_TICKET.code.length <= 8, true);
  assert.equal(parseTicketBlock(FIXTURE_TICKET_BLOCK)?.left, 62);
  const fx = src("../client/src/pages/dev/RoomFixture.tsx");
  const t = fx.slice(fx.indexOf("function TicketFixture"), fx.indexOf("export default function RoomFixture"));
  assert.ok(/useLayoutEffect\(\(\) => \{\s*const real = window\.fetch/.test(t));
  for (const p of ["/tickets/checkout", "/tickets/verify", "/tickets/refund", "/tickets/summary", "/cancel", "/api/csrf-token"]) assert.ok(t.includes(p), p);
  assert.ok(fx.includes("parseControlsFixture") && fx.includes("STATE_SCENES") && fx.includes("WizardFixture"), "existing scenes kept");
});

// ---------------------------------------------------------------- copy rules
test("copy: no em or en dashes, never 'cash', never 'anonymous' in any ticket line", () => {
  assert.ok(TICKET_UI_COPY.length > 60);
  for (const line of TICKET_UI_COPY) {
    assert.equal(/[—–]/.test(line), false, `dash in: ${line}`);
    assert.equal(/cash/i.test(line), false, `cash in: ${line}`);
    assert.equal(/anonymous/i.test(line), false, `anonymous in: ${line}`);
  }
  assert.equal(TICKET_COPY.getTicket(formatNaira(500_000)), "Get ticket · ₦5,000");
  assert.equal(TICKET_COPY.includesVat, "Price includes VAT");
});
test("copy: the new files hold no em dashes, 'cash' or 'anonymous', and icons come from the icon set", () => {
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
