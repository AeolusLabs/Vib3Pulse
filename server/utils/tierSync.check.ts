// Run: npx tsx server/utils/tierSync.check.ts
import assert from "node:assert/strict";
import { planTierSync, TierSyncError } from "./tierSync";

const ex = [{ id: "a", name: "Early", sold: 3 }, { id: "b", name: "GA", sold: 0 }];

// keep + edit sold tier in place, drop unsold tier, add new one
let p = planTierSync(ex, [{ id: "a", name: "Early bird", quantity: 10 }, { name: "VIP", quantity: 5 }]);
assert.deepEqual(p.update.map((t) => t.id), ["a"]);
assert.deepEqual(p.insert.map((t) => t.name), ["VIP"]);
assert.deepEqual(p.removeIds, ["b"]);

// the old bug: removing a tier that has sales must be refused, not attempted
assert.throws(() => planTierSync(ex, [{ id: "b", name: "GA", quantity: 5 }]), TierSyncError);
// cannot shrink below what's sold
assert.throws(() => planTierSync(ex, [{ id: "a", name: "Early", quantity: 2 }, { id: "b", name: "GA", quantity: 5 }]), /can't go below 3/);
// unknown / duplicate ids become inserts, never updates of someone else's tier
p = planTierSync(ex, [{ id: "a", name: "Early", quantity: 3 }, { id: "a", name: "Dupe", quantity: 1 }, { id: "zzz", name: "X", quantity: 1 }]);
assert.equal(p.update.length, 1);
assert.equal(p.insert.length, 2);
// switching to free/no tiers is fine only when nothing sold
assert.throws(() => planTierSync(ex, []), TierSyncError);
assert.deepEqual(planTierSync([{ id: "b", name: "GA", sold: 0 }], []).removeIds, ["b"]);
console.log("tierSync: ok");
