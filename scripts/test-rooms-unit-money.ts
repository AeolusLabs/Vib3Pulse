// Rooms money math checks (no database):   npx tsx scripts/test-rooms-unit-money.ts
import assert from "node:assert/strict";
import { breakdown, sprayBreakdown, ticketBreakdown, SPRAY_CATALOGUE, TICKET_PLATFORM_PCT, UNIT_LABEL, formatV3c } from "../shared/money";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

test("money: note 100 naira", () => {
  assert.deepEqual(sprayBreakdown("n100"), { price: 10000, vat: 698, fee: 150, reserve: 250, net: 8902, platform: 2671, host: 6231, guest: null });
});
test("money: bundle 1,000 naira", () => {
  assert.deepEqual(sprayBreakdown("bundle"), { price: 100000, vat: 6977, fee: 1500, reserve: 2500, net: 89023, platform: 22256, host: 66767, guest: null });
});
test("money: money bag 10,000 naira", () => {
  assert.deepEqual(sprayBreakdown("bag"), { price: 1000000, vat: 69767, fee: 25000, reserve: 25000, net: 880233, platform: 176047, host: 704186, guest: null });
});
test("money: Make it Rain 100,000 naira", () => {
  assert.deepEqual(sprayBreakdown("rain"), { price: 10000000, vat: 697674, fee: 160000, reserve: 250000, net: 8892326, platform: 1333849, host: 7558477, guest: null });
});
test("money: ticket 5,000 naira (reserve 1%)", () => {
  assert.deepEqual(ticketBreakdown(500000), { price: 500000, vat: 34884, fee: 17500, reserve: 5000, net: 442616, platform: 66392, host: 376224, guest: null });
});
test("money: money bag to a stage guest", () => {
  assert.deepEqual(sprayBreakdown("bag", true), { price: 1000000, vat: 69767, fee: 25000, reserve: 25000, net: 880233, platform: 176047, host: 132035, guest: 572151 });
});
test("money: catalogue and constants", () => {
  assert.equal(TICKET_PLATFORM_PCT, 15);
  assert.equal(UNIT_LABEL, "V3C");
  assert.deepEqual(Object.keys(SPRAY_CATALOGUE), ["n20", "n50", "n100", "bundle", "bag", "rain"]);
  assert.equal(SPRAY_CATALOGUE.bag.v3c, 1000000);
  assert.equal(SPRAY_CATALOGUE.rain.kobo, 10000000);
  assert.equal(SPRAY_CATALOGUE.n20.kobo, 2000);
  assert.equal(typeof formatV3c(1000000), "string");
});
test("money: property, shares always sum for price 1..20000", () => {
  for (let price = 1; price <= 20000; price++) {
    const b = breakdown({ price, platformPct: 20, reservePct: 0.025 });
    assert.equal(b.platform + b.host, b.net, `net split at ${price}`);
    assert.equal(b.vat + b.fee + b.reserve + b.net, price, `price split at ${price}`);
    const g = breakdown({ price, platformPct: 20, reservePct: 0.025, stageGuest: true });
    assert.equal(g.platform + g.host + (g.guest as number), g.net, `guest split at ${price}`);
    for (const v of Object.values(g)) assert.ok(Number.isInteger(v as number), `integer at ${price}`);
  }
});
test("money: property, large prices keep sums and integers", () => {
  for (const price of [250000, 249999, 999999, 13333337, 100000000]) {
    for (const g of [false, true]) {
      const b = breakdown({ price, platformPct: 15, reservePct: 0.01, stageGuest: g });
      assert.equal(b.vat + b.fee + b.reserve + b.net, price);
      assert.equal(b.platform + b.host + (b.guest ?? 0), b.net);
    }
  }
});
test("money: odd prices throw RangeError", () => {
  for (const p of [0, -5, 10.5, NaN, Infinity]) {
    assert.throws(() => breakdown({ price: p, platformPct: 20, reservePct: 0.025 }), RangeError, String(p));
    assert.throws(() => ticketBreakdown(p), RangeError, String(p));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
