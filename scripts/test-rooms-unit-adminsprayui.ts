// Admin spray screens: the pure helpers. No database.   npm run test:rooms
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SPRAY_STATUSES } from "../shared/spray";
import {
  appliedText, attentionCapNotes, buildTxQuery, defaultRange, koboToNairaText, pickedYmd, ymd, canBlock, canResume, canSeeTransactions, csvErrorMessage, csvUrl, funnelBuckets, mismatchBanner, statusLabel, TOO_MANY_ROWS_MESSAGE,
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

test("ymd is the UTC day, and the default range is recomputed from the clock it is given", () => {
  assert.equal(ymd(new Date("2026-10-05T23:30:00Z")), "2026-10-05");
  assert.equal(ymd(new Date("2026-10-06T00:30:00+01:00")), "2026-10-05");
  assert.deepEqual(defaultRange(new Date("2026-10-25T00:10:00Z")), { from: "2026-10-18", to: "2026-10-25" });
  assert.equal(defaultRange(new Date("2026-10-26T00:10:00Z")).to, "2026-10-26");
  assert.equal(pickedYmd(new Date(2026, 9, 5)), "2026-10-05"); // a calendar click (local midnight) keeps the clicked day
});

test("filter query building carries usernames and the room prefix", () => {
  assert.equal(buildTxQuery({ from: "2026-10-01", host: "ada", payer: " bo ", recipient: "", room: "Urban" }), "from=2026-10-01&room=Urban&host=ada&payer=bo");
  assert.equal(csvUrl({ host: "ada" }), "/api/admin/rooms/sprays/transactions.csv?host=ada");
});

test("attention capped record yields one note per capped kind", () => {
  assert.deepEqual(attentionCapNotes({ pending: false, reversing: false, paid_not_delivered: false, disputed: false }), []);
  assert.deepEqual(attentionCapNotes({ pending: true, reversing: false, paid_not_delivered: true, disputed: false }), ["Showing the newest 50 pending", "Showing the newest 50 paid, not delivered"]);
  assert.deepEqual(attentionCapNotes(undefined), []);
});

test("mismatch amounts are shown in naira, not kobo", () => {
  assert.equal(koboToNairaText("Amount differs: ours 150000 kobo, provider 200000 kobo"), "Amount differs: ours ₦1,500, provider ₦2,000");
  assert.ok(!mismatchBanner({ match: false, mismatches: ["Amount differs: ours 1000 kobo, provider 2000 kobo"] }).lines[0].includes("kobo"));
});

test("ReasonDialog takes an explicit shownToHost prop, never a title regex", () => {
  const src = readFileSync("client/src/components/admin/ReasonDialog.tsx", "utf8");
  assert.ok(src.includes("shownToHost"));
  assert.ok(!/strike\|ban|includes\("host"\)/.test(src));
});
