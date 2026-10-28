// Spray split checks (no database):   npx tsx scripts/test-rooms-unit-split.ts   (also run by npm run test:rooms)
// Every kobo of a spray goes somewhere: VAT + card fee + reserve + platform + host + stage person = the price, on every tier,
// for the default rates and for any rates the admin form allows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_RATES, RATE_LIMITS, SPRAY_TIERS, rateSetProblem, sprayBreakdown, type RateKey, type Rates } from "../shared/money";
import { spraySplit } from "../shared/spray";

let passed = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const total = (b: ReturnType<typeof sprayBreakdown>) => b.vat + b.fee + b.reserve + b.platform + b.host + (b.guest ?? 0);

t("with the default rates every tier adds up and every share is a positive whole number of kobo", () => {
  for (const tier of SPRAY_TIERS) for (const stage of [false, true]) {
    const b = sprayBreakdown(tier, stage);
    assert.equal(total(b), b.price, `${tier} ${stage}`);
    for (const k of [b.host, b.platform, ...(stage ? [b.guest as number] : [])]) assert.ok(Number.isSafeInteger(k) && k > 0);
  }
});
t("the stage person gets the largest share at the defaults, the host a smaller fixed cut of what is left", () => {
  const b = sprayBreakdown("note", true);
  assert.deepEqual({ price: b.price, vat: b.vat, fee: b.fee, reserve: b.reserve, platform: b.platform, host: b.host, guest: b.guest }, { price: 50000, vat: 3488, fee: 750, reserve: 1250, platform: 6677, host: 6677, guest: 31158 });
});
t("spraySplit hands the host the whole share on a host spray and shares only on stage", () => {
  assert.equal(spraySplit("bag", "host").guestKobo, null);
  const s = spraySplit("bag", "stage");
  assert.equal(s.hostKobo + (s.guestKobo as number) + s.breakdown.platform + s.breakdown.vat + s.breakdown.fee + s.breakdown.reserve, s.breakdown.price);
});
t("any rates inside the allowed limits still add up exactly (20,000 pseudo-random sets)", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 20000; i++) {
    const rates = { ...DEFAULT_RATES } as Rates;
    for (const k of Object.keys(RATE_LIMITS) as RateKey[]) rates[k] = Math.round((RATE_LIMITS[k].min + rnd() * (RATE_LIMITS[k].max - RATE_LIMITS[k].min)) * 100) / 100;
    for (const tier of SPRAY_TIERS) for (const stage of [false, true]) {
      const b = sprayBreakdown(tier, stage, rates);
      assert.equal(total(b), b.price);
      assert.ok(b.host >= 0 && b.platform >= 0 && (b.guest ?? 0) >= 0);
    }
  }
});
t("rateSetProblem passes the defaults and refuses a set that leaves a share at zero", () => {
  assert.equal(rateSetProblem({ ...DEFAULT_RATES }), null);
  assert.ok(rateSetProblem({ ...DEFAULT_RATES, spray_platform_note: 50, stage_guest_host: 50 }));
  assert.ok(rateSetProblem({ ...DEFAULT_RATES, stage_guest_host: 0 }));
});
t("saving a rate checks the whole set, lets a repair through, and the admin route answers 400 with the reason", () => {
  const rates = readFileSync("server/rooms/roomRates.ts", "utf8");
  assert.match(rates, /if \(rateSetProblem\(current\) === null\) \{\s*const problem = rateSetProblem\(\{ \.\.\.current, \[p\.key\]: v\.value \}\);\s*if \(problem\) throw new RangeError\(problem\);/);
  assert.match(readFileSync("server/rooms/adminRoutes.ts", "utf8"), /e instanceof RangeError\) return res\.status\(400\)\.json\(\{ message: e\.message, code: "BAD_VALUE" \}\)/);
});
t("someone on stage who cannot be paid yet is told, once, with the way to fix it", () => {
  assert.match(readFileSync("client/src/components/rooms/shell/RoomShell.tsx", "utf8"), /role !== "host" && onStageNow && !listenOnly && sprayFlags\(state\.room\)\.sprayOn === true && <StagePayoutHint \/>/);
  assert.ok(readFileSync("client/src/components/rooms/shell/StageRequests.tsx", "utf8").includes("People can't spray you yet."));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
