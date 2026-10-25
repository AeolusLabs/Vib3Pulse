// Admin spray screens: the pure helpers. No database.   npm run test:rooms
import assert from "node:assert/strict";
import { test } from "node:test";
import { SPRAY_STATUSES } from "../shared/spray";
import {
  appliedText, buildTxQuery, canBlock, canResume, canSeeTransactions, csvErrorMessage, csvUrl, funnelBuckets, mismatchBanner, statusLabel, TOO_MANY_ROWS_MESSAGE,
} from "../client/src/lib/adminSprayUi";

const bucket = (count: number, kobo: number) => ({ count, kobo });

test("query string includes only set filters", () => {
  assert.equal(buildTxQuery({}), "");
  assert.equal(buildTxQuery({ from: "2026-10-01", to: "", status: "failed", q: "  " }), "from=2026-10-01&status=failed");
  assert.equal(buildTxQuery({ q: "a b&c" }, { cursor: "abc", limit: 50 }), "q=a+b%26c&cursor=abc&limit=50");
});

test("every status has a label and a non-colour cue", () => {
  for (const s of SPRAY_STATUSES) {
    const m = statusLabel(s);
    assert.ok(m.label.length > 0 && m.icon, `${s} lacks a label or icon`);
  }
  assert.equal(new Set(SPRAY_STATUSES.map((s) => statusLabel(s).label)).size, SPRAY_STATUSES.length, "labels must be distinct");
  assert.ok(statusLabel("nope").label);
});

test("funnel buckets sum to the total", () => {
  const o = { funnel: { initiated: bucket(10, 1000), paid: bucket(1, 100), delivered: bucket(5, 500), failed: bucket(2, 200), reversed: bucket(1, 100), disputed: bucket(0, 0), pending: bucket(1, 100) }, byDay: [] };
  const f = funnelBuckets(o);
  assert.equal(f.sumCount, f.total.count);
  assert.equal(f.sumKobo, f.total.kobo);
  assert.ok(f.reconciles);
  assert.ok(!funnelBuckets({ ...o, funnel: { ...o.funnel, failed: bucket(3, 200) } }).reconciles);
  assert.equal(funnelBuckets(null).total.count, 0);
});

test("unblock/resume enabled only for super_admin", () => {
  assert.equal(canResume("super_admin"), true);
  for (const r of ["finance_manager", "content_moderator", "user_support", "", null, undefined]) assert.equal(canResume(r), false);
});

test("finance cannot see unblock enabled, can block", () => {
  assert.equal(canResume("finance_manager"), false);
  assert.equal(canBlock("finance_manager"), true);
  assert.equal(canBlock("super_admin"), true);
  assert.equal(canBlock("content_moderator"), false);
});

test("mismatch banner lists each mismatch and shows MATCH when none", () => {
  assert.equal(mismatchBanner({ match: true, mismatches: [] }).verdict, "MATCH");
  const b = mismatchBanner({ match: false, mismatches: ["Amount differs", "We show delivered but the provider status is failed"] });
  assert.equal(b.verdict, "MISMATCH");
  assert.deepEqual(b.lines, ["Amount differs", "We show delivered but the provider status is failed"]);
  assert.equal(mismatchBanner({ match: false, mismatches: [] }).verdict, "MISMATCH");
});

test("csv url carries the filters", () => {
  assert.equal(csvUrl({}), "/api/admin/rooms/sprays/transactions.csv");
  assert.equal(csvUrl({ from: "2026-10-01", to: "2026-10-07", status: "delivered", hostId: "h1" }), "/api/admin/rooms/sprays/transactions.csv?from=2026-10-01&to=2026-10-07&status=delivered&hostId=h1");
});

test("Transactions tab hidden for non-finance", () => {
  assert.equal(canSeeTransactions("finance_manager"), true);
  assert.equal(canSeeTransactions("super_admin"), true);
  for (const r of ["content_moderator", "user_support", "", undefined]) assert.equal(canSeeTransactions(r), false);
});

test("TOO_MANY_ROWS message", () => {
  assert.equal(TOO_MANY_ROWS_MESSAGE, "Narrow the date range: exports are limited to 50,000 rows");
  assert.equal(csvErrorMessage(413, { code: "TOO_MANY_ROWS" }), TOO_MANY_ROWS_MESSAGE);
  assert.equal(csvErrorMessage(500, null), "The export did not work. Try again.");
});

test("applied text shows a count only when the API gives one", () => {
  assert.equal(appliedText({}), "Applied");
  assert.equal(appliedText({ appliedTo: 3 }), "Applied to 3 live rooms");
  assert.equal(appliedText({ appliedTo: 1 }), "Applied to 1 live room");
});
