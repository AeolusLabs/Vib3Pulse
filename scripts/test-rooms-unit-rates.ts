// Rates as a value in the shared money module (rooms rates plan, task 1). No database.   npx tsx scripts/test-rooms-unit-rates.ts
import assert from "node:assert/strict";
import {
  DEFAULT_RATES, RATE_KEYS, RATE_LIMITS, validateRate, sprayBreakdown, ticketBreakdown, SPRAY_TIERS, TICKET_PLATFORM_PCT, type Rates, type RateKey,
} from "../shared/money";
import { spraySplit } from "../shared/spray";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

test("DEFAULT_RATES equal today's constants, keys in a fixed order", () => {
  assert.deepEqual([...RATE_KEYS], ["spray_platform_note", "spray_platform_bundle", "spray_platform_bag", "spray_platform_rain", "ticket_platform", "stage_guest_host", "spray_reserve", "ticket_reserve"]);
  assert.deepEqual({ ...DEFAULT_RATES }, { spray_platform_note: 15, spray_platform_bundle: 12, spray_platform_bag: 10, spray_platform_rain: 8, ticket_platform: 15, stage_guest_host: 15, spray_reserve: 2.5, ticket_reserve: 1 });
  assert.equal(TICKET_PLATFORM_PCT, 15);
});

// Pinned from the code as it was before this change: with no rates passed nothing may move.
test("no rates passed: every number equals the pre-change result", () => {
  assert.deepEqual(ticketBreakdown(500000), { price: 500000, vat: 34884, fee: 17500, reserve: 5000, net: 442616, platform: 66392, host: 376224, guest: null });
  assert.deepEqual(ticketBreakdown(100000), { price: 100000, vat: 6977, fee: 1500, reserve: 1000, net: 90523, platform: 13578, host: 76945, guest: null });
  assert.deepEqual(sprayBreakdown("note"), { price: 50000, vat: 3488, fee: 750, reserve: 1250, net: 44512, platform: 6677, host: 37835, guest: null });
  assert.deepEqual(sprayBreakdown("note", true), { price: 50000, vat: 3488, fee: 750, reserve: 1250, net: 44512, platform: 6677, host: 6677, guest: 31158 });
  assert.deepEqual(sprayBreakdown("bundle"), { price: 100000, vat: 6977, fee: 1500, reserve: 2500, net: 89023, platform: 10683, host: 78340, guest: null });
  assert.deepEqual(sprayBreakdown("bag"), { price: 1000000, vat: 69767, fee: 25000, reserve: 25000, net: 880233, platform: 88023, host: 792210, guest: null });
  assert.deepEqual(sprayBreakdown("rain"), { price: 10000000, vat: 697674, fee: 160000, reserve: 250000, net: 8892326, platform: 711386, host: 8180940, guest: null });
});

test("passing DEFAULT_RATES explicitly gives the same answer as passing nothing", () => {
  assert.deepEqual(ticketBreakdown(500000, DEFAULT_RATES), ticketBreakdown(500000));
  for (const t of SPRAY_TIERS) assert.deepEqual(sprayBreakdown(t, true, DEFAULT_RATES), sprayBreakdown(t, true));
});

test("a changed ticket platform share is that percent of net, host is the rest", () => {
  const rates: Rates = { ...DEFAULT_RATES, ticket_platform: 20 };
  const b = ticketBreakdown(500000, rates);
  assert.equal(b.net, 442616);
  assert.equal(b.platform, Math.round((442616 * 20) / 100));
  assert.equal(b.host, b.net - b.platform);
});

test("a changed spray tier share only moves that tier", () => {
  const rates: Rates = { ...DEFAULT_RATES, spray_platform_note: 10 };
  assert.equal(sprayBreakdown("note", false, rates).platform, Math.round((44512 * 10) / 100));
  assert.deepEqual(sprayBreakdown("bundle", false, rates), sprayBreakdown("bundle"));
});

test("reserve rates are percent of price and move only the reserve, net and shares", () => {
  const rates: Rates = { ...DEFAULT_RATES, ticket_reserve: 2 };
  const b = ticketBreakdown(500000, rates);
  assert.equal(b.reserve, 10000);
  assert.equal(b.vat, 34884);
  assert.equal(b.net, 500000 - 34884 - 17500 - 10000);
  const s = sprayBreakdown("note", false, { ...DEFAULT_RATES, spray_reserve: 5 });
  assert.equal(s.reserve, 2500);
});

test("stage guest host share is a percent of net and the guest gets the rest", () => {
  const b = sprayBreakdown("note", true, { ...DEFAULT_RATES, stage_guest_host: 20 });
  assert.equal(b.host, Math.round((b.net * 20) / 100));
  assert.equal(b.guest, b.net - b.platform - b.host);
});

test("spraySplit threads rates through and defaults when none", () => {
  const rates: Rates = { ...DEFAULT_RATES, spray_platform_note: 10 };
  assert.equal(spraySplit("note", "host", rates).breakdown.platform, sprayBreakdown("note", false, rates).platform);
  assert.deepEqual(spraySplit("note", "host").breakdown, sprayBreakdown("note"));
  assert.equal(spraySplit("note", "stage", rates).guestKobo, sprayBreakdown("note", true, rates).guest);
});

test("validateRate: bounds, decimals and types", () => {
  const platform: RateKey = "ticket_platform", reserve: RateKey = "spray_reserve";
  for (const v of [0, 50, 12.5, 7.25, 15]) assert.deepEqual(validateRate(platform, v), { ok: true, value: v }, String(v));
  for (const v of [-1, 50.01, 1.234, "15", NaN, Infinity, null, undefined, {}]) assert.equal(validateRate(platform, v).ok, false, String(v));
  for (const v of [0, 10, 2.5]) assert.equal(validateRate(reserve, v).ok, true, String(v));
  for (const v of [10.01, -0.01]) assert.equal(validateRate(reserve, v).ok, false, String(v));
  assert.deepEqual({ ...RATE_LIMITS.ticket_platform }, { min: 0, max: 50 });
  assert.deepEqual({ ...RATE_LIMITS.spray_reserve }, { min: 0, max: 10 });
  assert.equal(validateRate("nope" as RateKey, 5).ok, false);
});

test("every allowed combination at the extremes keeps every share non-negative and the parts add up", () => {
  const extreme: Rates = { spray_platform_note: 50, spray_platform_bundle: 50, spray_platform_bag: 50, spray_platform_rain: 50, ticket_platform: 50, stage_guest_host: 50, spray_reserve: 10, ticket_reserve: 10 };
  for (const t of SPRAY_TIERS) for (const stage of [false, true]) {
    const b = sprayBreakdown(t, stage, extreme);
    assert.ok(b.platform >= 0 && b.host >= 0 && (b.guest ?? 0) >= 0 && b.net >= 0, `${t} stage=${stage} ${JSON.stringify(b)}`);
    assert.equal(b.platform + b.host + (b.guest ?? 0), b.net, `${t} stage=${stage}`);
  }
  for (const price of [100000, 500000, 10000000]) {
    const b = ticketBreakdown(price, extreme);
    assert.ok(b.platform >= 0 && b.host >= 0 && b.net >= 0 && b.platform + b.host === b.net, `ticket ${price}`);
  }
  const zero: Rates = { ...DEFAULT_RATES, ticket_platform: 0, spray_platform_note: 0, spray_reserve: 0, ticket_reserve: 0 };
  assert.equal(ticketBreakdown(500000, zero).platform, 0);
  assert.equal(sprayBreakdown("note", false, zero).host, sprayBreakdown("note", false, zero).net);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
