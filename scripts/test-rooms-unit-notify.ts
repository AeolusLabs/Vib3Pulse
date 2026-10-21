// Room money notifications: copy, links and the one-notice-per-spray key (no database):
//   npx tsx scripts/test-rooms-unit-notify.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EARNINGS_LINK, ROOM_MONEY_NOTIFICATION_TYPES, notificationLinkFor, payoutPaidNotice, refundIssuedNotice,
  safeRoomMoneyLink, sprayNoticeKey, sprayReceivedNotice, ticketIssuedNotice,
} from "../shared/roomNotifications";
import { notificationTypes } from "../shared/schema";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const ROOM = "3f0c1d2e-0000-4000-8000-000000000001";
const copies = () => [
  sprayReceivedNotice(500000, "Friday Pre-Drinks"),
  ticketIssuedNotice("Friday Pre-Drinks"),
  refundIssuedNotice(250000, "Friday Pre-Drinks"),
  payoutPaidNotice(1234567, "Friday Pre-Drinks"),
];

test("every new type is declared in notificationTypes", () => {
  for (const t of ["room_ticket", "room_refund", "spray_received", "payout_paid", "spray_reversed"]) {
    assert.ok((notificationTypes as readonly string[]).includes(t), t);
  }
});

test("each room money type has a link: earnings for money received, the room otherwise", () => {
  for (const t of ROOM_MONEY_NOTIFICATION_TYPES) {
    const l = notificationLinkFor(t, ROOM);
    assert.ok(l === EARNINGS_LINK || l === `/rooms/${ROOM}`, `${t} -> ${l}`);
    assert.equal(safeRoomMoneyLink(l), l, `${t} link must pass the bell's check`);
  }
  assert.equal(notificationLinkFor("spray_received", ROOM), "/rooms/earnings");
  assert.equal(notificationLinkFor("payout_paid", ROOM), "/rooms/earnings");
  assert.equal(notificationLinkFor("room_ticket", ROOM), `/rooms/${ROOM}`);
});

test("the bell follows only in-app room or earnings paths", () => {
  for (const bad of ["https://evil.example/rooms/x", "//evil.example", "/rooms/a/b", "/rooms/", "javascript:alert(1)", "/rooms/%2F..%2F", null, undefined, "/rooms/earnings/x", "/settings"]) {
    assert.equal(safeRoomMoneyLink(bad as any), null, String(bad));
  }
  assert.equal(safeRoomMoneyLink("/rooms/earnings"), "/rooms/earnings");
});

test("copy: plain words, amounts in naira, no em dash, never 'cash' or 'anonymous'", () => {
  for (const c of copies()) {
    const all = `${c.title} ${c.message}`;
    assert.ok(!all.includes("—"), all);
    assert.ok(!/cash|anonymous/i.test(all), all);
    assert.ok(c.title.length > 0 && c.message.length > 0);
  }
  assert.equal(sprayReceivedNotice(500000, "Friday Pre-Drinks").title, "You received ₦5,000 in Friday Pre-Drinks");
  assert.match(payoutPaidNotice(1234567, "R").message, /₦12,345\.67/);
});

test("spray copy never names a payer (it takes only an amount and the room title)", () => {
  assert.equal(sprayReceivedNotice.length, 2);
  const n = sprayReceivedNotice(100000, "Room");
  assert.ok(!/from @|sprayed you|by /i.test(`${n.title} ${n.message}`));
});

test("payout copy says sent only (it is only used after Paystack confirmed the transfer)", () => {
  assert.match(payoutPaidNotice(100, "R").title, /sent/);
  assert.match(refundIssuedNotice(100, "R").title, /on its way/); // never "refunded" before the provider says so
});

test("room titles in copy are one line and cut to 80 characters", () => {
  const t = sprayReceivedNotice(100, `a\n\n${"x".repeat(200)}`).title;
  assert.ok(!t.includes("\n"));
  assert.ok(t.length <= "You received ₦1 in ".length + 80, String(t.length));
});

test("one notice per spray (owner decision): the key is the spray id, the copy is that spray's amount", () => {
  const SPRAY = "9a0c1d2e-0000-4000-8000-000000000002";
  assert.equal(sprayNoticeKey(SPRAY), `spray-received:${SPRAY}`);
  assert.equal(sprayReceivedNotice(40000, "Room").title, "You received ₦400 in Room");
  assert.match(sprayReceivedNotice(40000, "Room").message, /a spray/);
  assert.doesNotMatch(sprayReceivedNotice(40000, "Room").title, /so far|total/i, "never a running total");
});

test("notify.ts: de-duplicated by spray, read from the stored row, bounded concurrency, no batching left", () => {
  const src = readFileSync(new URL("../server/rooms/notify.ts", import.meta.url), "utf8");
  assert.match(src, /where not exists \(select 1 from notifications where user_id = \$1(::varchar)? and type = 'spray_received' and related_entity_id = \$5(::varchar)?\)/);
  assert.match(src, /where s\.id = \$1::uuid and s\.status = 'delivered'/);
  assert.match(src, /SPRAY_NOTIFY_CONCURRENCY = 4/);
  assert.doesNotMatch(src, /sprayBatchDecision|SPRAY_BATCH_WINDOW_MS|BEGIN|pg_advisory/, "no batching transaction or lock remains");
  const spray = readFileSync(new URL("../server/rooms/spray.ts", import.meta.url), "utf8");
  assert.match(spray, /void notifySprayReceived\(row\.hostId, row\.roomId, row\.hostKobo, row\.id\)/);
});

test("notify.ts: spray_received rows never carry a related user, and every hook site uses void (fire-and-forget)", () => {
  const src = readFileSync(new URL("../server/rooms/notify.ts", import.meta.url), "utf8");
  const insert = src.slice(src.indexOf("insert into notifications"), src.indexOf("insert into notifications") + 200);
  assert.ok(!/related_user_id/.test(insert), "spray_received insert must not set related_user_id");
  for (const [file, call] of [["tickets.ts", "notifyTicketIssued("], ["settlement.ts", "notifyPayoutPaid("], ["spray.ts", "notifySprayReceived("]] as const) {
    const s = readFileSync(new URL(`../server/rooms/${file}`, import.meta.url), "utf8");
    const lines = s.split("\n").filter((l) => l.includes(call) && !l.trim().startsWith("import"));
    assert.ok(lines.length > 0, `${file} calls ${call}`);
    for (const l of lines) assert.match(l, /void notify/, `${file}: ${l.trim()}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
