// Admin spray ledger, the parts that need no database:   npx tsx scripts/test-rooms-unit-sprayledger.ts
// endedAs, funnel buckets, the synthetic timeline, CSV cells, the provider comparison, the mock and Paystack verifyCharge,
// and a source-level check that the ledger routes never write to the money tables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPRAY_STATUSES } from "../shared/spray";
import { SPRAY_CATALOGUE, sprayBreakdown } from "../shared/money";
import {
  CSV_COLUMNS, compareWithProvider, csvCell, csvLine, endedAs, funnelBucket, ngn, syntheticTimeline,
} from "../shared/sprayLedger";
import { makeSprayReference } from "../server/payments/sprayReference";
import { MockSplitProvider } from "../server/payments/mockSplitProvider";
import { createPaystackSplitProvider } from "../server/payments/paystackSplit";

let passed = 0, failed = 0;
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>) => { queue.push({ name, fn }); };
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const ROOM = "11111111-1111-4111-8111-111111111111", PAYER = "22222222-2222-4222-8222-222222222222", HOST = "33333333-3333-4333-8333-333333333333";
const ref = () => makeSprayReference(ROOM, PAYER, "bundle", HOST, "unit-secret");
const pay = async (m: MockSplitProvider, r = ref()) => {
  await m.startFirstPayment({
    reference: r, email: "x@example.com", amountKobo: SPRAY_CATALOGUE.bundle.kobo, split: { shares: [{ subaccountCode: "ACCT_hosthost01", amountKobo: sprayBreakdown("bundle").host }] },
    metadata: { roomId: ROOM }, callbackUrl: "https://vib3pulse.test/cb",
  });
  m.completeCheckout(r);
  return r;
};

test("endedAs covers every status", () => {
  const seen = new Set<string>();
  for (const status of SPRAY_STATUSES) {
    const line = endedAs({ status, reason: status === "failed" ? "TIMEOUT" : null, recipientUsername: "ada" });
    assert.ok(line && line !== "Unknown", status);
    seen.add(line);
  }
  assert.equal(seen.size, 7, "created and pending share one line");
  assert.equal(endedAs({ status: "delivered", recipientUsername: "ada" }), "Delivered to ada");
  assert.equal(endedAs({ status: "reversed" }), "Refunded to payer");
  assert.equal(endedAs({ status: "failed", reason: "DECLINED" }), "Failed: card declined");
  assert.equal(endedAs({ status: "failed", reason: null }), "Failed: no reason recorded");
  assert.equal(endedAs({ status: "disputed" }), "Disputed");
  assert.equal(endedAs({ status: "pending" }), "Still pending");
  assert.equal(endedAs({ status: "paid" }), "Paid, not yet delivered");
  assert.equal(endedAs({ status: "reversing" }), "Reversing");
});

test("every status lands in exactly one funnel bucket", () => {
  const buckets = new Set(["paid", "delivered", "failed", "reversed", "disputed", "pending"]);
  for (const s of SPRAY_STATUSES) assert.ok(buckets.has(funnelBucket(s)), s);
  assert.equal(funnelBucket("reversing"), "reversed");
  assert.equal(funnelBucket("created"), "pending");
});

test("synthetic timeline is built from the row's own timestamps, in order", () => {
  const t = syntheticTimeline({
    status: "reversed", reason: "AMOUNT_MISMATCH", createdAt: "2026-01-01T10:00:00.000Z", paidAt: "2026-01-01T10:01:00.000Z", deliveredAt: null,
    reversedAt: "2026-01-01T10:09:00.000Z", refundRequestedAt: "2026-01-01T10:01:00.000Z",
  });
  assert.deepEqual(t.map((e) => e.toStatus), ["created", "paid", "reversing", "reversed"]);
  assert.ok(t.every((e) => e.source === "system"));
  const d = syntheticTimeline({ status: "delivered", reason: null, createdAt: "2026-01-01T10:00:00.000Z", paidAt: "2026-01-01T10:01:00.000Z", deliveredAt: "2026-01-01T10:01:02.000Z", reversedAt: null, refundRequestedAt: null });
  assert.deepEqual(d.map((e) => e.toStatus), ["created", "paid", "delivered"]);
  const f = syntheticTimeline({ status: "failed", reason: "TIMEOUT", createdAt: "2026-01-01T10:00:00.000Z", paidAt: null, deliveredAt: null, reversedAt: null, refundRequestedAt: null });
  assert.equal(f[f.length - 1].toStatus, "failed");
  assert.equal(f[f.length - 1].at, null, "no failure time is stored, so none is invented");
});

test("csv: columns, quoting, injection guard", () => {
  assert.equal(CSV_COLUMNS.join(","), "id,created_at,status,ended_as,room,host,payer,recipient,tier,amount_ngn,vat,fee,reserve,platform,host_share,recipient_share,provider_ref,batch_id");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  for (const bad of ["=1+1", "+1", "-1", "@sum", "\tx", "\rx"]) assert.ok(csvCell(bad).replace(/^"/, "").startsWith("'"), JSON.stringify(bad));
  assert.equal(csvCell("=HYPERLINK(\"x\",\"y\")"), `"'=HYPERLINK(""x"",""y"")"`);
  assert.equal(csvCell(null), "");
  assert.equal(ngn(150000), "1500.00");
  assert.equal(csvLine(["a", "b,c", "=x"]), `a,"b,c",'=x`);
});

test("compareWithProvider: agree, amount, refunded, unknown, not-taken", () => {
  const ok = { status: "success", amountKobo: 50000, paidAt: null, feeKobo: 750, refunded: false, refundedKobo: 0, split: null, currency: "NGN" };
  assert.deepEqual(compareWithProvider({ status: "delivered", amountKobo: 50000 }, ok), []);
  assert.equal(compareWithProvider({ status: "delivered", amountKobo: 50000 }, { ...ok, amountKobo: 40000 }).length, 1);
  assert.equal(compareWithProvider({ status: "delivered", amountKobo: 50000 }, { ...ok, status: "reversed", refunded: true }).length, 1);
  assert.deepEqual(compareWithProvider({ status: "reversed", amountKobo: 50000 }, { ...ok, status: "reversed", refunded: true, refundedKobo: 50000 }), []);
  assert.equal(compareWithProvider({ status: "reversed", amountKobo: 50000 }, ok).length, 1);
  assert.equal(compareWithProvider({ status: "failed", amountKobo: 50000 }, ok).length, 1, "taken but we say failed");
  assert.deepEqual(compareWithProvider({ status: "pending", amountKobo: 50000 }, { ...ok, status: "abandoned" }), []);
  assert.equal(compareWithProvider({ status: "delivered", amountKobo: 50000 }, null).length, 1);
  assert.equal(compareWithProvider({ status: "delivered", amountKobo: 50000 }, { ...ok, currency: "USD" }).length, 1);
});

test("mock verifyCharge: match, tampered mismatch, unknown, outage; split masked", async () => {
  const m = new MockSplitProvider();
  const r = await pay(m);
  const d = await m.verifyCharge(r);
  assert.ok(d);
  assert.equal(d.status, "success");
  assert.deepEqual(d.split, { subaccountLast4: ["st01"] });
  assert.deepEqual(compareWithProvider({ status: "delivered", amountKobo: SPRAY_CATALOGUE.bundle.kobo }, { ...d, currency: d.currency }), []);
  m.tamper(r, { amountKobo: 1 });
  const t = await m.verifyCharge(r);
  assert.equal(compareWithProvider({ status: "delivered", amountKobo: SPRAY_CATALOGUE.bundle.kobo }, t && { ...t }).length, 1);
  assert.equal(await m.verifyCharge(ref()), null);
  m.verifyMode = "outage";
  await assert.rejects(m.verifyCharge(r), /unavailable|outage/i);
  const text = JSON.stringify(d);
  assert.ok(!/ACCT_hosthost01|AUTH_|SIG_/.test(text), "no full subaccount code or card secret");
  assert.equal(m.refunds.length, 0, "a look-up never refunds");
});

test("paystack verifyCharge: reversed payment, not found, outage", async () => {
  const real = globalThis.fetch;
  const key = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
  const calls: string[] = [];
  const reply = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const p = createPaystackSplitProvider();
    const r = ref();
    globalThis.fetch = reply(200, { status: true, data: { status: "reversed", amount: 50000, currency: "ngn", paid_at: "2026-01-01T00:00:00.000Z", fees: 750, split: { shares: { subaccounts: [{ subaccount: "ACCT_abcdef123456" }] } }, authorization: { authorization_code: "AUTH_secret" } } });
    const d = await p.verifyCharge(r);
    assert.ok(d);
    assert.equal(d.refunded, true); assert.equal(d.refundedKobo, 50000); assert.equal(d.currency, "NGN"); assert.equal(d.feeKobo, 750);
    assert.deepEqual(d.split, { subaccountLast4: ["3456"] });
    assert.ok(!JSON.stringify(d).includes("AUTH_secret") && !JSON.stringify(d).includes("ACCT_abcdef"));
    assert.ok(calls.every((c) => c.startsWith("GET ")), "read-only: only GET requests");
    globalThis.fetch = reply(404, { status: false, message: "Transaction reference not found" });
    assert.equal(await p.verifyCharge(r), null);
    globalThis.fetch = reply(503, { status: false });
    await assert.rejects(p.verifyCharge(r));
  } finally {
    globalThis.fetch = real;
    if (key === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = key;
  }
});

test("ledger routes never write to the money tables", () => {
  const src = readFileSync(join(root, "server/rooms/adminSprayLedger.ts"), "utf8");
  assert.ok(!/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\s+(?:spray_|payment_|room_)/i.test(src));
  assert.ok(!/refund\(|markSprayStatus|markBatchStatus|finalizeSpray/.test(src), "no refund or status call");
  assert.ok(!/auth_enc|authorization_code|authorizationCode|email|date_of_birth|phone/i.test(src.replace(/\/\/.*$/gm, "")), "no secret or PII column is selected");
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); passed++; console.log(`PASS ${t.name}`); }
    catch (e: any) { failed++; console.log(`FAIL ${t.name}  ${String(e.message).split("\n")[0]}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
