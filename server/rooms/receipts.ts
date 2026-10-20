// Rooms phase 6, task 6.3: the payer's own room payments and their receipts.
//
// RULES
//  - Own rows only: room_tickets.user_id = viewer, spray_payments.payer_id = viewer. Every query carries the viewer's id from
//    the session; an id that is not theirs (or does not exist, or is malformed) is the same 404.
//  - Nothing about the other side: no host, no recipient, no payment reference, no provider data. The room title is the
//    only thing about the room. Card: last four digits of the payer's own saved card, when stored.
//  - Lines: a ticket (paid, or refunded), a spray the payer was charged for (paid_at set, or disputed), and a NEGATIVE refund
//    line for every refunded ticket (refused charges too) and every reversing / reversed spray.
//  - Pagination: ordered by (created_at of the purchase, item id) descending; a refund line uses its purchase's created_at,
//    so lines never move once listed (a refund made later appears just above its purchase). Cursor = "<µs>.<item id>".
import { pool } from "../storage";
import {
  decodePaymentsCursor, encodePaymentsCursor, parseItemId, renderReceiptHtml,
  type ReceiptBusiness, type ReceiptData, type RoomPaymentItem, type RoomPaymentKind, type RoomPaymentStatus, type RoomPaymentsPage,
} from "@shared/roomEarnings";
import { SPRAY_CATALOGUE, isSprayTier } from "@shared/money";

export const PAYMENTS_PAGE_SIZE = 20;

/** Business details printed on receipts. Placeholders until the owner provides the company details (config, not code). */
export function receiptBusinessDetails(env: NodeJS.ProcessEnv = process.env): ReceiptBusiness {
  const v = (k: string, fallback: string) => (typeof env[k] === "string" && env[k]!.trim() ? env[k]!.trim().slice(0, 200) : fallback);
  return {
    name: v("RECEIPT_BUSINESS_NAME", "Vib3Pulse (company name to be confirmed)"),
    address: v("RECEIPT_BUSINESS_ADDRESS", "Registered address to be confirmed"),
    taxId: v("RECEIPT_TAX_ID", "to be confirmed"),
    email: v("RECEIPT_SUPPORT_EMAIL", "support contact to be confirmed"),
  };
}

const SPRAY_STATUS_SQL = `case s.status when 'paid' then 'processing' when 'delivered' then 'delivered' when 'reversing' then 'pending'
  when 'reversed' then 'refunded' when 'disputed' then 'disputed' else 'failed' end`;

/** All four kinds of line for one payer, as one ordered set. $1 = viewer. */
const LINES_SQL = `
  select 'tk_' || t.id::text as item_id, 'ticket'::text as kind, null::text as refund_of, r.title::text as title,
         t.amount_kobo::int as amount, t.vat_kobo::int as vat,
         (extract(epoch from t.created_at) * 1000000)::bigint as at_us,
         round(extract(epoch from t.created_at) * 1000)::float8 as shown_ms,
         (case when t.status = 'paid' then 'paid' else 'refunded' end)::text as status, null::text as tier
    from room_tickets t join rooms r on r.id = t.room_id
   where t.user_id = $1
  union all
  select 'tr_' || t.id::text, 'refund'::text, 'ticket'::text, r.title::text,
         (-t.amount_kobo)::int, (-t.vat_kobo)::int,
         (extract(epoch from t.created_at) * 1000000)::bigint,
         round(extract(epoch from coalesce(t.refunded_at, t.created_at)) * 1000)::float8,
         (case when t.refunded_at is not null then 'refunded' else 'pending' end)::text, null::text
    from room_tickets t join rooms r on r.id = t.room_id
   where t.user_id = $1 and t.status = 'refunded'
  union all
  select 'sp_' || s.id::text, 'spray'::text, null::text, r.title::text,
         s.amount_kobo::int, s.vat_kobo::int,
         (extract(epoch from s.created_at) * 1000000)::bigint,
         round(extract(epoch from coalesce(s.paid_at, s.created_at)) * 1000)::float8,
         (${SPRAY_STATUS_SQL})::text, s.tier::text
    from spray_payments s join rooms r on r.id = s.room_id
   where s.payer_id = $1 and (s.paid_at is not null or s.status = 'disputed')
  union all
  select 'sr_' || s.id::text, 'refund'::text, 'spray'::text, r.title::text,
         (-s.amount_kobo)::int, (-s.vat_kobo)::int,
         (extract(epoch from s.created_at) * 1000000)::bigint,
         round(extract(epoch from coalesce(s.reversed_at, s.refund_requested_at, s.created_at)) * 1000)::float8,
         (case when s.status = 'reversed' then 'refunded' else 'pending' end)::text, s.tier::text
    from spray_payments s join rooms r on r.id = s.room_id
   where s.payer_id = $1 and s.status in ('reversing', 'reversed')`;

type LineRow = {
  item_id: string; kind: RoomPaymentKind; refund_of: "spray" | "ticket" | null; title: string | null; amount: number; vat: number;
  at_us: string; shown_ms: number; status: RoomPaymentStatus; tier: string | null;
};

const toItem = (r: LineRow): RoomPaymentItem => ({
  id: r.item_id,
  kind: r.kind,
  title: r.title ?? "",
  amountKobo: Number(r.amount),
  vatKobo: Number(r.vat),
  at: new Date(Number(r.shown_ms)).toISOString(),
  status: r.status,
  ...(r.tier && isSprayTier(r.tier) ? { tier: r.tier } : {}),
  ...(r.refund_of ? { refundOf: r.refund_of } : {}),
});

export class BadCursorError extends Error {
  constructor() { super("bad cursor"); this.name = "BadCursorError"; }
}

/** One page of the viewer's own payments. A cursor that is not one we made throws BadCursorError (400). */
export async function paymentsPage(viewerId: string, cursor: unknown): Promise<RoomPaymentsPage> {
  let after: { atUs: string; itemId: string } | null = null;
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    after = decodePaymentsCursor(cursor);
    if (!after) throw new BadCursorError();
  }
  const rows = (await pool.query(
    `select * from (${LINES_SQL}) x
      where ($2::bigint is null or (x.at_us, x.item_id collate "C") < ($2::bigint, $3::text collate "C"))
      order by x.at_us desc, x.item_id collate "C" desc
      limit $4`,
    [viewerId, after ? after.atUs : null, after ? after.itemId : null, PAYMENTS_PAGE_SIZE + 1],
  )).rows as LineRow[];
  const page = rows.slice(0, PAYMENTS_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map(toItem),
    next: rows.length > PAYMENTS_PAGE_SIZE && last ? encodePaymentsCursor(String(last.at_us), last.item_id) : null,
  };
}

const tierLabel = (tier: string | null) => (tier && isSprayTier(tier) ? SPRAY_CATALOGUE[tier].label : "Spray");

/**
 * The receipt data for one of the viewer's own lines, or null (the route answers 404 for null: not theirs, not a
 * receipt-bearing line, malformed id: all the same).
 */
export async function receiptFor(viewerId: string, itemId: unknown): Promise<ReceiptData | null> {
  const p = parseItemId(itemId);
  if (!p) return null;
  const business = receiptBusinessDetails();
  if (p.prefix === "tk" || p.prefix === "tr") {
    const t = (await pool.query(
      `select t.amount_kobo, t.vat_kobo, t.status, r.title,
              round(extract(epoch from t.created_at) * 1000)::float8 as created_ms,
              round(extract(epoch from coalesce(t.refunded_at, t.created_at)) * 1000)::float8 as refund_ms,
              (t.refunded_at is not null) as refund_done
         from room_tickets t join rooms r on r.id = t.room_id
        where t.id = $1::uuid and t.user_id = $2`,
      [p.rowId, viewerId],
    )).rows[0] as { amount_kobo: number; vat_kobo: number; status: string; title: string | null; created_ms: number; refund_ms: number; refund_done: boolean } | undefined;
    if (!t) return null;
    if (p.prefix === "tr") {
      if (t.status !== "refunded") return null;
      return {
        itemId: `tr_${p.rowId}`, kind: "refund", refundOf: "ticket", itemLabel: "Refund: room ticket", roomTitle: t.title ?? "",
        amountKobo: -Number(t.amount_kobo), vatKobo: -Number(t.vat_kobo), atMs: Number(t.refund_ms),
        status: t.refund_done ? "refunded" : "pending", cardLast4: null, business,
      };
    }
    return {
      itemId: `tk_${p.rowId}`, kind: "ticket", itemLabel: "Room ticket", roomTitle: t.title ?? "",
      amountKobo: Number(t.amount_kobo), vatKobo: Number(t.vat_kobo), atMs: Number(t.created_ms),
      status: t.status === "paid" ? "paid" : "refunded", cardLast4: null, business,
    };
  }
  let s: { amount_kobo: number; vat_kobo: number; status: string; tier: string; title: string | null; paid_ms: number; refund_ms: number; last4: string | null; charged: boolean } | undefined;
  try {
    s = (await pool.query(
      `select s.amount_kobo, s.vat_kobo, s.status, s.tier, r.title,
              round(extract(epoch from coalesce(s.paid_at, s.created_at)) * 1000)::float8 as paid_ms,
              round(extract(epoch from coalesce(s.reversed_at, s.refund_requested_at, s.created_at)) * 1000)::float8 as refund_ms,
              m.last4, (s.paid_at is not null or s.status = 'disputed') as charged
         from spray_payments s join rooms r on r.id = s.room_id
         left join user_payment_methods m on m.id = s.payment_method_id and m.user_id = s.payer_id
        where s.id = $1::uuid and s.payer_id = $2`,
      [p.rowId, viewerId],
    )).rows[0];
  } catch (e) {
    if ((e as { code?: string })?.code === "42P01") return null;
    throw e;
  }
  if (!s || !s.charged) return null;
  const last4 = typeof s.last4 === "string" && /^\d{4}$/.test(s.last4) ? s.last4 : null;
  const label = tierLabel(s.tier);
  if (p.prefix === "sr") {
    if (s.status !== "reversing" && s.status !== "reversed") return null;
    return {
      itemId: `sr_${p.rowId}`, kind: "refund", refundOf: "spray", itemLabel: `Refund: spray (${label})`, roomTitle: s.title ?? "",
      amountKobo: -Number(s.amount_kobo), vatKobo: -Number(s.vat_kobo), atMs: Number(s.refund_ms),
      status: s.status === "reversed" ? "refunded" : "pending", cardLast4: last4, business,
    };
  }
  const status: RoomPaymentStatus = s.status === "paid" ? "processing" : s.status === "delivered" ? "delivered"
    : s.status === "reversing" ? "pending" : s.status === "reversed" ? "refunded" : s.status === "disputed" ? "disputed" : "failed";
  return {
    itemId: `sp_${p.rowId}`, kind: "spray", itemLabel: `Spray: ${label}`, roomTitle: s.title ?? "",
    amountKobo: Number(s.amount_kobo), vatKobo: Number(s.vat_kobo), atMs: Number(s.paid_ms), status, cardLast4: last4, business,
  };
}

/** The receipt page for the viewer's own line, or null. */
export async function receiptHtmlFor(viewerId: string, itemId: unknown): Promise<string | null> {
  const data = await receiptFor(viewerId, itemId);
  return data ? renderReceiptHtml(data) : null;
}
