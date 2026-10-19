// Rooms money math checks (no database):   npx tsx scripts/test-rooms-unit-money.ts
import assert from "node:assert/strict";
import {
  breakdown, sprayBreakdown, ticketBreakdown, SPRAY_CATALOGUE, SPRAY_TIERS, TICKET_PLATFORM_PCT, UNIT_LABEL, MIN_CHARGE_KOBO,
  formatV3c, isSprayTier, assertChargeable, type SprayTier,
} from "../shared/money";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

// ---------------------------------------------------------------- the catalogue (decided 2026-10-19)
test("catalogue: exactly note, bundle, bag, rain in that order (no n20/n50/n100)", () => {
  assert.deepEqual(Object.keys(SPRAY_CATALOGUE), ["note", "bundle", "bag", "rain"]);
  assert.deepEqual([...SPRAY_TIERS], ["note", "bundle", "bag", "rain"]);
  for (const old of ["n20", "n50", "n100"]) assert.equal(isSprayTier(old), false, old);
});
const want: Record<SprayTier, { kobo: number; v3c: number; platformPct: number }> = {
  note: { kobo: 50000, v3c: 50000, platformPct: 30 },
  bundle: { kobo: 100000, v3c: 100000, platformPct: 25 },
  bag: { kobo: 1000000, v3c: 1000000, platformPct: 20 },
  rain: { kobo: 10000000, v3c: 10000000, platformPct: 15 },
};
for (const t of ["note", "bundle", "bag", "rain"] as SprayTier[]) {
  test(`catalogue ${t}: kobo, v3c (1 V3C = 1 kobo) and platformPct`, () => {
    assert.equal(SPRAY_CATALOGUE[t].kobo, want[t].kobo);
    assert.equal(SPRAY_CATALOGUE[t].v3c, want[t].v3c);
    assert.equal(SPRAY_CATALOGUE[t].v3c, SPRAY_CATALOGUE[t].kobo);
    assert.equal(SPRAY_CATALOGUE[t].platformPct, want[t].platformPct);
    assert.ok(SPRAY_CATALOGUE[t].kobo >= MIN_CHARGE_KOBO, "every tier meets the minimum charge");
    assert.equal(typeof SPRAY_CATALOGUE[t].label, "string");
  });
}
test("catalogue is frozen (no runtime price edits)", () => {
  assert.ok(Object.isFrozen(SPRAY_CATALOGUE));
  assert.ok(Object.isFrozen(SPRAY_CATALOGUE.note));
  assert.ok(Object.isFrozen(SPRAY_TIERS));
  assert.throws(() => { (SPRAY_CATALOGUE.note as any).kobo = 1; }, TypeError);
});

// ---------------------------------------------------------------- every kobo field, every tier, both splits
const vectors: Record<SprayTier, { host: object; guest: object }> = {
  note: {
    host: { price: 50000, vat: 3488, fee: 750, reserve: 1250, net: 44512, platform: 13354, host: 31158, guest: null },
    guest: { price: 50000, vat: 3488, fee: 750, reserve: 1250, net: 44512, platform: 13354, host: 6677, guest: 24481 },
  },
  bundle: {
    host: { price: 100000, vat: 6977, fee: 1500, reserve: 2500, net: 89023, platform: 22256, host: 66767, guest: null },
    guest: { price: 100000, vat: 6977, fee: 1500, reserve: 2500, net: 89023, platform: 22256, host: 13353, guest: 53414 },
  },
  bag: {
    host: { price: 1000000, vat: 69767, fee: 25000, reserve: 25000, net: 880233, platform: 176047, host: 704186, guest: null },
    guest: { price: 1000000, vat: 69767, fee: 25000, reserve: 25000, net: 880233, platform: 176047, host: 132035, guest: 572151 },
  },
  rain: {
    host: { price: 10000000, vat: 697674, fee: 160000, reserve: 250000, net: 8892326, platform: 1333849, host: 7558477, guest: null },
    guest: { price: 10000000, vat: 697674, fee: 160000, reserve: 250000, net: 8892326, platform: 1333849, host: 1333849, guest: 6224628 },
  },
};
for (const t of SPRAY_TIERS) {
  test(`sprayBreakdown(${t}) to the host: every kobo field`, () => assert.deepEqual(sprayBreakdown(t), vectors[t].host));
  test(`sprayBreakdown(${t}, true) to a stage guest: every kobo field`, () => assert.deepEqual(sprayBreakdown(t, true), vectors[t].guest));
  test(`${t}: host + platform + vat + fee + reserve === price (and with a guest), all non-negative integers`, () => {
    const b = sprayBreakdown(t);
    assert.equal(b.host + b.platform + b.vat + b.fee + b.reserve, b.price);
    assert.equal(b.price, SPRAY_CATALOGUE[t].kobo);
    const g = sprayBreakdown(t, true);
    assert.equal(g.host + (g.guest as number) + g.platform + g.vat + g.fee + g.reserve, g.price);
    for (const v of [...Object.values(b), ...Object.values(g)]) if (v !== null) assert.ok(Number.isInteger(v) && (v as number) >= 0, String(v));
    assert.equal(b.platform, Math.round((b.net * SPRAY_CATALOGUE[t].platformPct) / 100), "platform uses the tier's platformPct");
  });
}
test("sprayBreakdown refuses an unknown tier (RangeError)", () => {
  for (const t of ["n20", "n100", "", "toString", "__proto__"]) assert.throws(() => sprayBreakdown(t as SprayTier), RangeError, t);
});

// ---------------------------------------------------------------- tickets (unchanged)
test("money: ticket 5,000 naira (reserve 1%)", () => {
  assert.deepEqual(ticketBreakdown(500000), { price: 500000, vat: 34884, fee: 17500, reserve: 5000, net: 442616, platform: 66392, host: 376224, guest: null });
});
test("money: constants", () => {
  assert.equal(TICKET_PLATFORM_PCT, 15);
  assert.equal(UNIT_LABEL, "V3C");
  assert.equal(MIN_CHARGE_KOBO, 50000);
});

// ---------------------------------------------------------------- isSprayTier / assertChargeable
test("isSprayTier: only the four names", () => {
  for (const t of SPRAY_TIERS) assert.equal(isSprayTier(t), true, t);
  for (const x of ["NOTE", " note", "constructor", "toString", "__proto__", "hasOwnProperty", 1, null, undefined, {}, ["note"]]) {
    assert.equal(isSprayTier(x), false, String(x));
  }
});
test("assertChargeable: at or above 50,000 kobo integers pass, anything else is a RangeError", () => {
  for (const k of [50000, 50001, 100000, 10000000]) assert.doesNotThrow(() => assertChargeable(k), String(k));
  for (const k of [49999, 0, -50000, 50000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => assertChargeable(k), RangeError, String(k));
  assert.throws(() => assertChargeable("50000" as unknown as number), RangeError);
});

// ---------------------------------------------------------------- breakdown input validation
test("breakdown: platformPct must be finite and 0..100", () => {
  for (const p of [-1, 100.01, NaN, Infinity, -Infinity]) assert.throws(() => breakdown({ price: 100000, platformPct: p, reservePct: 0.025 }), RangeError, String(p));
  assert.throws(() => breakdown({ price: 100000, platformPct: "20" as unknown as number, reservePct: 0.025 }), RangeError);
  assert.doesNotThrow(() => breakdown({ price: 100000, platformPct: 0, reservePct: 0 }));
  assert.doesNotThrow(() => breakdown({ price: 100000, platformPct: 100, reservePct: 0.2 }));
});
test("breakdown: reservePct must be finite and 0..0.2", () => {
  for (const r of [-0.001, 0.2001, 1, 2.5, NaN, Infinity]) assert.throws(() => breakdown({ price: 100000, platformPct: 20, reservePct: r }), RangeError, String(r));
  assert.throws(() => breakdown({ price: 100000, platformPct: 20, reservePct: undefined as unknown as number }), RangeError);
});
test("breakdown: odd prices throw RangeError", () => {
  for (const p of [0, -5, 10.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => breakdown({ price: p, platformPct: 20, reservePct: 0.025 }), RangeError, String(p));
    assert.throws(() => ticketBreakdown(p), RangeError, String(p));
  }
});
test("breakdown: platform 100% leaves the host 0, never negative", () => {
  const b = breakdown({ price: 100000, platformPct: 100, reservePct: 0.025 });
  assert.equal(b.host, 0);
  assert.equal(b.platform, b.net);
});

// ---------------------------------------------------------------- property
test("property: shares always sum for price 1..20000", () => {
  for (let price = 1; price <= 20000; price++) {
    const b = breakdown({ price, platformPct: 20, reservePct: 0.025 });
    assert.equal(b.platform + b.host, b.net, `net split at ${price}`);
    assert.equal(b.vat + b.fee + b.reserve + b.net, price, `price split at ${price}`);
    const g = breakdown({ price, platformPct: 20, reservePct: 0.025, stageGuest: true });
    assert.equal(g.platform + g.host + (g.guest as number), g.net, `guest split at ${price}`);
    for (const v of Object.values(g)) assert.ok(Number.isInteger(v as number), `integer at ${price}`);
  }
});
test("property: large prices keep sums and integers", () => {
  for (const price of [250000, 249999, 999999, 13333337, 100000000]) {
    for (const g of [false, true]) {
      const b = breakdown({ price, platformPct: 15, reservePct: 0.01, stageGuest: g });
      assert.equal(b.vat + b.fee + b.reserve + b.net, price);
      assert.equal(b.platform + b.host + (b.guest ?? 0), b.net);
    }
  }
});

// ---------------------------------------------------------------- formatV3c (exact)
test("formatV3c: exact grouping, integer in", () => {
  assert.equal(formatV3c(50000), "50,000 V3C");
  assert.equal(formatV3c(100000), "100,000 V3C");
  assert.equal(formatV3c(1000000), "1,000,000 V3C");
  assert.equal(formatV3c(10000000), "10,000,000 V3C");
  assert.equal(formatV3c(0), "0 V3C");
  assert.equal(formatV3c(999), "999 V3C");
  assert.equal(formatV3c(1000), "1,000 V3C");
  assert.equal(formatV3c(-1500), "-1,500 V3C");
  for (const t of SPRAY_TIERS) assert.match(formatV3c(SPRAY_CATALOGUE[t].v3c), /^\d{1,3}(,\d{3})* V3C$/);
});
test("formatV3c: a fraction, NaN or Infinity throws (never rounded silently)", () => {
  for (const n of [0.5, 49999.9, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => formatV3c(n), RangeError, String(n));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
