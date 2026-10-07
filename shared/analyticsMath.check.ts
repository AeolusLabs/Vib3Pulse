// Run: npx tsx shared/analyticsMath.check.ts
import assert from "node:assert/strict";
import { buildFunnel, conversionPct } from "./analyticsMath";

assert.equal(conversionPct(0, 5), null);        // no views recorded -> "—", not 0%
assert.equal(conversionPct(200, 10), 5);
assert.equal(conversionPct(3, 10), 100);        // converters can't exceed 100% of views
assert.equal(conversionPct(7, 1), 14.3);

const f = buildFunnel(200, 40, 25);
assert.deepEqual(f.map((s) => s.rate), [null, 20, 63]);
assert.equal(f[0].widthPct, 100);
assert.ok(f.every((s) => s.widthPct <= 100));
// pre-tracking data (fewer views than conversions) must not overflow or divide by zero
const g = buildFunnel(0, 12, 4);
assert.ok(g.every((s) => s.widthPct <= 100 && Number.isFinite(s.widthPct)));
assert.equal(g[1].rate, null);
console.log("analyticsMath: ok");
