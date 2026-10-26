// Immersive chat fade checks (no database):   npx tsx scripts/test-rooms-unit-chatfade.ts   (also run by npm run test:rooms)
import assert from "node:assert/strict";
import { CHAT_FADE_MS, CHAT_MAX_LINES, CHAT_TTL_MS, liveLines } from "../client/src/lib/chatFade";

let passed = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message}`); }
};
const line = (id: string, at: number) => ({ id, at });
const ids = (r: { item: { id: string } }[]) => r.map((x) => x.item.id);

t("a fresh line shows, not fading", () => assert.deepEqual(liveLines([line("a", 1000)], 1000), [{ item: line("a", 1000), fading: false }]));
t("fades in the last second", () => assert.equal(liveLines([line("a", 0)], CHAT_TTL_MS - CHAT_FADE_MS)[0].fading, true));
t("still readable just before the fade", () => assert.equal(liveLines([line("a", 0)], CHAT_TTL_MS - CHAT_FADE_MS - 1)[0].fading, false));
t("gone at the lifetime", () => assert.deepEqual(liveLines([line("a", 0)], CHAT_TTL_MS), []));
t("keeps only the newest max", () => {
  const many = Array.from({ length: 10 }, (_, i) => line(`l${i}`, 100 + i));
  assert.deepEqual(ids(liveLines(many, 200)), ["l4", "l5", "l6", "l7", "l8", "l9"]);
  assert.equal(CHAT_MAX_LINES, 6);
});
t("an open line never expires or fades", () => {
  const r = liveLines([line("old", 0), line("new", 20000)], 20000, "old");
  assert.deepEqual(ids(r), ["old", "new"]);
  assert.equal(r[0].fading, false);
});
t("an open line outside the newest max still drops", () => {
  const many = Array.from({ length: 8 }, (_, i) => line(`l${i}`, 100 + i));
  assert.equal(ids(liveLines(many, 200, "l0")).includes("l0"), false);
});
t("a future timestamp (clock skew) shows", () => assert.equal(liveLines([line("a", 5000)], 1000).length, 1));
t("max below 1 still keeps one line", () => assert.equal(liveLines([line("a", 0), line("b", 1)], 2, null, 0).length, 1));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
