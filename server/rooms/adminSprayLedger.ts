// Admin spray money ledger (finance roles): every spray and team-spray share, how the money was split, where each one ended,
// its timeline (spray_events), a read-only Paystack look-up and a CSV export. Registered from adminRoutes.ts.
// Read-only except the audit rows. Usernames and references only: never an email, phone, birth date, authorization code,
// card data or a full subaccount code (last 4 only). Parameterised SQL throughout.
import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { requireRole } from "../services/adminSecurity";
import { adminQuery, parseRange, type Range } from "./adminStats";
import { getSplitProvider } from "../payments/splitProvider";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import { isSprayStatus, SPRAY_STATUSES } from "@shared/spray";
import {
  CSV_COLUMNS, compareWithProvider, csvLine, endedAs, funnelBucket, ngn, syntheticTimeline,
  type AttentionItem, type AttentionKind, type FunnelBucket, type LedgerDetail, type LedgerRow, type OutcomesResponse, type ProviderCheckResult, type TimelineEntry,
} from "@shared/sprayLedger";

const FINANCE = ["super_admin", "finance_manager"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 100;
export const LEDGER_CSV_MAX_ROWS = 50_000;
/** Test seam: the live CSV cap (tests lower it; production always uses LEDGER_CSV_MAX_ROWS). */
export const ledgerTuning = { csvMaxRows: LEDGER_CSV_MAX_ROWS };
export const PROVIDER_CHECKS_PER_MINUTE = 20;
const ATTENTION_PER_KIND = 50;
const MIN_MS = 60_000;

// Timestamps as UTC ISO text straight from Postgres: no JS timezone round trip, and microseconds kept for the keyset cursor.
const iso = (col: string) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const SELECT_ROW = `
  s.id, s.batch_id, s.room_id, r.title as room_title, s.host_id, hu.username as host_username, s.payer_id, pu.username as payer_username,
  s.recipient_id, ru.username as recipient_username, s.tier, s.amount_kobo, s.status, s.reason,
  coalesce(b.provider_ref, s.provider_ref) as provider_ref,
  ${iso("s.created_at")} as created_at, ${iso("s.delivered_at")} as delivered_at, ${iso("s.reversed_at")} as reversed_at,
  to_char(s.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as ck`;
const FROM_ROW = `
  from spray_payments s
  join rooms r on r.id = s.room_id
  join users hu on hu.id = s.host_id
  join users pu on pu.id = s.payer_id
  join users ru on ru.id = s.recipient_id
  left join spray_batches b on b.id = s.batch_id`;

interface RawRow {
  id: string; batch_id: string | null; room_id: string; room_title: string; host_id: string; host_username: string; payer_id: string; payer_username: string;
  recipient_id: string; recipient_username: string; tier: string; amount_kobo: number; status: string; reason: string | null; provider_ref: string;
  created_at: string; delivered_at: string | null; reversed_at: string | null; ck: string;
}

export function toLedgerRow(r: RawRow): LedgerRow {
  return {
    id: r.id, kind: r.batch_id ? "team_share" : "single", batchId: r.batch_id, roomId: r.room_id, roomTitle: r.room_title,
    hostId: r.host_id, hostUsername: r.host_username, payerId: r.payer_id, payerUsername: r.payer_username,
    recipientId: r.recipient_id, recipientUsername: r.recipient_username, tier: r.tier, amountKobo: Number(r.amount_kobo),
    status: r.status as LedgerRow["status"], endedAs: endedAs({ status: r.status, reason: r.reason, recipientUsername: r.recipient_username }),
    providerRef: r.provider_ref, createdAt: r.created_at, deliveredAt: r.delivered_at, reversedAt: r.reversed_at,
  };
}

// ---------------------------------------------------------------- filters
interface Filters {
  range: Range; status?: string; roomId?: string; hostId?: string; payerId?: string; recipientId?: string; q?: string;
  /** Exact usernames (case-insensitive) and a room-title prefix. */
  host?: string; payer?: string; recipient?: string; room?: string;
}
type Parsed = { ok: true; f: Filters } | { ok: false; message: string; code: string };

function one(v: unknown): string | undefined | null { // undefined: absent; null: present but not a single string
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : null;
}

export function parseFilters(query: Request["query"]): Parsed {
  const range = parseRange({ from: query.from, to: query.to });
  if (!range) return { ok: false, message: "Pick a valid date range of at most 366 days.", code: "BAD_RANGE" };
  const f: Filters = { range };
  const status = one(query.status);
  if (status === null || (status !== undefined && status !== "" && !isSprayStatus(status))) return { ok: false, message: `status must be one of ${SPRAY_STATUSES.join(", ")}`, code: "BAD_FILTER" };
  if (status) f.status = status;
  for (const k of ["roomId", "hostId", "payerId", "recipientId"] as const) {
    const v = one(query[k]);
    if (v === null || (v !== undefined && v !== "" && !ID.test(v))) return { ok: false, message: `${k} must be an id of up to 64 letters, numbers, dashes or underscores.`, code: "BAD_FILTER" };
    if (v) f[k] = v;
  }
  for (const [k, max] of [["host", 64], ["payer", 64], ["recipient", 64], ["room", 100]] as const) {
    const v = one(query[k]);
    if (v === null) return { ok: false, message: `${k} must be a single piece of text.`, code: "BAD_FILTER" };
    const t = v?.trim();
    if (t && t.length > max) return { ok: false, message: `${k} must be at most ${max} characters.`, code: "BAD_FILTER" };
    if (t && /[\u0000-\u001f]/.test(t)) return { ok: false, message: `${k} must not contain control characters.`, code: "BAD_FILTER" };
    if (t) f[k] = t;
  }
  const q = one(query.q);
  if (q === null) return { ok: false, message: "q is not valid", code: "BAD_FILTER" };
  if (q && q.trim()) f.q = q.trim().slice(0, 64);
  return { ok: true, f };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The WHERE clause (after `where`) and its parameters. */
function whereFor(f: Filters, cursor?: { k: string; id: string }): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const conds = [`s.created_at >= ${p(f.range.from.toISOString())}::timestamp`, `s.created_at < ${p(f.range.to.toISOString())}::timestamp`];
  if (f.status) conds.push(`s.status = ${p(f.status)}`);
  if (f.roomId) conds.push(`s.room_id = ${p(f.roomId)}`);
  if (f.hostId) conds.push(`s.host_id = ${p(f.hostId)}`);
  if (f.payerId) conds.push(`s.payer_id = ${p(f.payerId)}`);
  if (f.recipientId) conds.push(`s.recipient_id = ${p(f.recipientId)}`);
  if (f.host) conds.push(`lower(hu.username) = lower(${p(f.host)})`);
  if (f.payer) conds.push(`lower(pu.username) = lower(${p(f.payer)})`);
  if (f.recipient) conds.push(`lower(ru.username) = lower(${p(f.recipient)})`);
  if (f.room) conds.push(`lower(r.title) like ${p(`${escapeLike(f.room.toLowerCase())}%`)} escape '\\'`);
  if (f.q) {
    const exact = p(f.q);
    const like = p(`${escapeLike(f.q.toLowerCase())}%`);
    conds.push(`(s.provider_ref = ${exact} or b.provider_ref = ${exact} or lower(pu.username) like ${like} escape '\\' or lower(ru.username) like ${like} escape '\\' or lower(hu.username) like ${like} escape '\\')`);
  }
  if (cursor) conds.push(`(s.created_at, s.id) < (${p(cursor.k)}::timestamp, ${p(cursor.id)}::uuid)`);
  return { sql: conds.join(" and "), params };
}

export const encodeCursor = (k: string, id: string) => Buffer.from(JSON.stringify({ k, id }), "utf8").toString("base64url");
export function decodeCursor(raw: unknown): { k: string; id: string } | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 200) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { k?: unknown; id?: unknown };
    return typeof o.k === "string" && KEY.test(o.k) && typeof o.id === "string" && UUID.test(o.id) ? { k: o.k, id: o.id } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- audit and rate limit
/** An export or provider look-up that cannot be audited does not happen: these are the only reads that leave the system. */
async function auditStrict(req: Request, action: string, targetId: string, details: unknown): Promise<boolean> {
  try {
    await storage.logAdminActivity({
      adminId: req.session.adminId!, action, targetType: "room_spray", targetId, details: JSON.stringify(details).slice(0, 1000),
      reason: action === "room_spray.export" ? "Spray ledger CSV export" : "Paystack read-only look-up", ipAddress: req.ip,
    });
    return true;
  } catch (e) {
    console.error(`[ADMIN] ALERT ${action} refused: the audit row failed:`, (e as Error)?.message);
    return false;
  }
}

const checkHits = new Map<string, number[]>();
/** 20 provider look-ups per minute per admin (a sliding window, in memory per process). */
export function providerCheckAllowed(adminId: string, now: number = Date.now()): boolean {
  const hits = (checkHits.get(adminId) ?? []).filter((t) => now - t < MIN_MS);
  if (hits.length >= PROVIDER_CHECKS_PER_MINUTE) { checkHits.set(adminId, hits); return false; }
  hits.push(now);
  checkHits.set(adminId, hits);
  if (checkHits.size > 1000) for (const [k, v] of checkHits) if (v.every((t) => now - t >= MIN_MS)) checkHits.delete(k);
  return true;
}
export const resetProviderCheckLimit = () => checkHits.clear();

const last4 = (code: string | null | undefined): string | null => (typeof code === "string" && code.length >= 4 ? code.slice(-4) : null);

export function registerSprayLedgerRoutes(app: Express): void {
  const fail = (res: Response, what: string, e: unknown) => {
    console.error(`[ADMIN] spray ledger ${what} failed:`, (e as Error)?.message);
    res.status(500).json({ message: `Failed to load the ${what}` });
  };
  const noStore = (res: Response) => { res.setHeader("Cache-Control", "no-store"); };

  // ------------------------------------------------------------ list
  app.get("/api/admin/rooms/sprays/transactions", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const parsed = parseFilters(req.query);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message, code: parsed.code });
    const cursor = decodeCursor(req.query.cursor);
    if (cursor === null) return res.status(400).json({ message: "That page marker is not valid.", code: "BAD_CURSOR" });
    const limitRaw = req.query.limit === undefined ? LEDGER_PAGE_DEFAULT : Number(req.query.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1) return res.status(400).json({ message: "limit must be a whole number from 1 to 100", code: "BAD_FILTER" });
    const limit = Math.min(limitRaw, LEDGER_PAGE_MAX);
    try {
      const w = whereFor(parsed.f, cursor);
      const rows = (await adminQuery(
        `select ${SELECT_ROW} ${FROM_ROW} where ${w.sql} order by s.created_at desc, s.id desc limit ${limit + 1}`, w.params,
      )).rows as RawRow[];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      noStore(res);
      res.json({ rows: page.map(toLedgerRow), nextCursor: rows.length > limit && last ? encodeCursor(last.ck, last.id) : null });
    } catch (e) { fail(res, "transactions", e); }
  });

  // ------------------------------------------------------------ CSV (declared before /:id)
  app.get("/api/admin/rooms/sprays/transactions.csv", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const parsed = parseFilters(req.query);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message, code: parsed.code });
    try {
      const w = whereFor(parsed.f);
      const n = Number(((await adminQuery(`select count(*)::int as n ${FROM_ROW} where ${w.sql}`, w.params)).rows[0] as { n: number }).n);
      if (n > ledgerTuning.csvMaxRows) {
        return res.status(413).json({ message: `That is ${n} rows; an export holds at most ${ledgerTuning.csvMaxRows}. Narrow the dates or add a filter.`, code: "TOO_MANY_ROWS" });
      }
      const rows = (await adminQuery(
        `select ${SELECT_ROW}, s.vat_kobo, s.fee_kobo, s.reserve_kobo, s.platform_kobo, s.host_kobo, s.guest_kobo ${FROM_ROW}
          where ${w.sql} order by s.created_at desc, s.id desc limit ${ledgerTuning.csvMaxRows}`, w.params,
      )).rows as (RawRow & { vat_kobo: number; fee_kobo: number; reserve_kobo: number; platform_kobo: number; host_kobo: number; guest_kobo: number | null })[];
      const filters = { from: parsed.f.range.from.toISOString(), to: parsed.f.range.to.toISOString(), status: parsed.f.status, roomId: parsed.f.roomId, hostId: parsed.f.hostId, payerId: parsed.f.payerId, recipientId: parsed.f.recipientId, host: parsed.f.host, payer: parsed.f.payer, recipient: parsed.f.recipient, room: parsed.f.room, q: parsed.f.q, rows: rows.length };
      if (!(await auditStrict(req, "room_spray.export", "csv", filters))) return res.status(500).json({ message: "The export could not be recorded, so it was not produced. Try again." });
      const lines = [csvLine(CSV_COLUMNS)];
      for (const r of rows) {
        const l = toLedgerRow(r);
        lines.push(csvLine([
          l.id, l.createdAt, l.status, l.endedAs, l.roomTitle, l.hostUsername, l.payerUsername, l.recipientUsername, l.tier, ngn(l.amountKobo),
          ngn(r.vat_kobo), ngn(r.fee_kobo), ngn(r.reserve_kobo), ngn(r.platform_kobo), ngn(r.host_kobo),
          // what the recipient received: a stage guest's cut, else (the host is the recipient) the host share
          ngn(r.guest_kobo ?? r.host_kobo), l.providerRef, l.batchId ?? "",
        ]));
      }
      const day = (d: Date) => d.toISOString().slice(0, 10);
      noStore(res);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="spray-transactions-${day(parsed.f.range.from)}-to-${day(parsed.f.range.to)}.csv"`);
      res.send(`${lines.join("\r\n")}\r\n`);
    } catch (e) { fail(res, "export", e); }
  });

  // ------------------------------------------------------------ outcomes (funnel)
  app.get("/api/admin/rooms/sprays/outcomes", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const range = parseRange({ from: req.query.from, to: req.query.to });
    if (!range) return res.status(400).json({ message: "Pick a valid date range of at most 366 days.", code: "BAD_RANGE" });
    try {
      const rows = (await adminQuery(
        `select to_char(s.created_at, 'YYYY-MM-DD') as day, s.status, count(*)::int as n, coalesce(sum(s.amount_kobo), 0)::bigint as kobo
           from spray_payments s where s.created_at >= $1::timestamp and s.created_at < $2::timestamp group by 1, 2 order by 1`,
        [range.from.toISOString(), range.to.toISOString()],
      )).rows as { day: string; status: string; n: number; kobo: string }[];
      const empty = (): Record<string, FunnelBucket> => ({ initiated: { count: 0, kobo: 0 }, paid: { count: 0, kobo: 0 }, delivered: { count: 0, kobo: 0 }, failed: { count: 0, kobo: 0 }, reversed: { count: 0, kobo: 0 }, disputed: { count: 0, kobo: 0 }, pending: { count: 0, kobo: 0 } });
      const total = empty();
      const days = new Map<string, Record<string, FunnelBucket>>();
      for (const r of rows) {
        const d = days.get(r.day) ?? empty();
        days.set(r.day, d);
        for (const t of [total, d]) {
          for (const key of ["initiated", funnelBucket(r.status)]) { t[key].count += r.n; t[key].kobo += Number(r.kobo); }
        }
      }
      const out = { funnel: total, byDay: Array.from(days, ([day, v]) => ({ day, ...v })) } as unknown as OutcomesResponse;
      noStore(res);
      res.json(out);
    } catch (e) { fail(res, "outcomes", e); }
  });

  // ------------------------------------------------------------ attention
  // Capped and ordered PER KIND, newest problem first, so a pile of old disputes can never hide a fresh stuck payment.
  app.get("/api/admin/rooms/sprays/attention", requireRole(...FINANCE), async (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      const p15 = new Date(now - 15 * MIN_MS).toISOString();
      const p5 = new Date(now - 5 * MIN_MS).toISOString();
      const kinds: Record<AttentionKind, { cond: string; params: unknown[]; why: string; since: string }> = {
        pending: { cond: `s.status in ('created', 'pending') and s.created_at < $1::timestamp`, params: [p15], why: "Still pending after 15 minutes", since: "s.created_at" },
        reversing: { cond: `s.status = 'reversing' and coalesce(s.refund_requested_at, s.created_at) < $1::timestamp`, params: [p15], why: "Refund still reversing after 15 minutes", since: "coalesce(s.refund_requested_at, s.created_at)" },
        paid_not_delivered: { cond: `s.status = 'paid' and coalesce(s.paid_at, s.created_at) < $1::timestamp`, params: [p5], why: "Paid but not delivered after 5 minutes", since: "coalesce(s.paid_at, s.created_at)" },
        disputed: { cond: `s.status = 'disputed'`, params: [], why: "Disputed: answer it in Paystack", since: "s.created_at" },
      };
      const items: AttentionItem[] = [];
      const capped = {} as Record<AttentionKind, boolean>;
      await Promise.all((Object.keys(kinds) as AttentionKind[]).map(async (kind) => {
        const k = kinds[kind];
        const rows = (await adminQuery(
          `select ${SELECT_ROW}, ${iso(k.since)} as since_iso ${FROM_ROW}
            where ${k.cond} and (s.batch_id is null or not exists (select 1 from spray_payments o where o.batch_id = s.batch_id and o.id < s.id))
            order by ${k.since} desc, s.id desc limit ${ATTENTION_PER_KIND + 1}`, k.params,
        )).rows as (RawRow & { since_iso: string })[];
        capped[kind] = rows.length > ATTENTION_PER_KIND;
        for (const r of rows.slice(0, ATTENTION_PER_KIND)) {
          items.push({ kind, why: k.why, ageMinutes: Math.max(0, Math.floor((now - new Date(r.since_iso).getTime()) / MIN_MS)), tx: toLedgerRow(r) });
        }
      }));
      noStore(res);
      res.json({ items, capped });
    } catch (e) { fail(res, "attention list", e); }
  });

  // ------------------------------------------------------------ detail
  async function loadDetail(id: string) {
    const rows = (await adminQuery(
      `select ${SELECT_ROW}, s.vat_kobo, s.fee_kobo, s.reserve_kobo, s.platform_kobo, s.host_kobo, s.guest_kobo, s.provider, s.recipient_subaccount,
              b.host_subaccount as batch_host_subaccount, b.amount_kobo as batch_amount_kobo, b.status as batch_status,
              ${iso("s.paid_at")} as paid_at, ${iso("s.refund_requested_at")} as refund_requested_at,
              (select o.room_verified_subaccount_code from organizer_payment_accounts o where o.user_id = s.host_id and o.provider = 'paystack' limit 1) as host_account_code
         ${FROM_ROW} where s.id = $1::uuid`, [id],
    )).rows as (RawRow & {
      vat_kobo: number; fee_kobo: number; reserve_kobo: number; platform_kobo: number; host_kobo: number; guest_kobo: number | null; provider: string;
      recipient_subaccount: string | null; batch_host_subaccount: string | null; batch_amount_kobo: number | null; batch_status: string | null;
      paid_at: string | null; refund_requested_at: string | null; host_account_code: string | null;
    })[];
    return rows[0] ?? null;
  }

  app.get("/api/admin/rooms/sprays/transactions/:id", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return res.status(404).json({ message: "Transaction not found" });
    try {
      const r = await loadDetail(id);
      if (!r) return res.status(404).json({ message: "Transaction not found" });
      const events = (await adminQuery(
        `select ${iso("spray_events.at")} as at, from_status, to_status, source, detail from spray_events where spray_id = $1::uuid order by spray_events.at asc, spray_events.seq asc limit 200`, [id],
      )).rows as { at: string; from_status: string | null; to_status: string; source: string; detail: string | null }[];
      const base = toLedgerRow(r);
      const synthetic = events.length === 0;
      const timeline: TimelineEntry[] = synthetic
        ? syntheticTimeline({ status: r.status, reason: r.reason, createdAt: r.created_at, paidAt: r.paid_at, deliveredAt: r.delivered_at, reversedAt: r.reversed_at, refundRequestedAt: r.refund_requested_at })
        : events.map((e) => ({ at: e.at, fromStatus: e.from_status, toStatus: e.to_status, source: e.source, detail: e.detail }));
      let siblings: LedgerRow[] = [];
      if (r.batch_id) {
        const sib = (await adminQuery(`select ${SELECT_ROW} ${FROM_ROW} where s.batch_id = $1::uuid and s.id <> $2::uuid order by s.created_at asc, s.id asc limit 100`, [r.batch_id, id])).rows as RawRow[];
        siblings = sib.map(toLedgerRow);
      }
      const body: LedgerDetail = {
        tx: {
          ...base, vatKobo: r.vat_kobo, feeKobo: r.fee_kobo, reserveKobo: r.reserve_kobo, platformKobo: r.platform_kobo, hostKobo: r.host_kobo,
          guestKobo: r.guest_kobo, provider: r.provider, reason: r.reason, paidAt: r.paid_at, refundRequestedAt: r.refund_requested_at,
          hostSubaccountLast4: last4(r.batch_id ? r.batch_host_subaccount : r.host_account_code),
          recipientSubaccountLast4: last4(r.recipient_subaccount),
        },
        timeline, synthetic, siblings,
      };
      noStore(res);
      res.json(body);
    } catch (e) { fail(res, "transaction", e); }
  });

  // ------------------------------------------------------------ Paystack look-up (read-only)
  app.post("/api/admin/rooms/sprays/transactions/:id/paystack-check", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return res.status(404).json({ message: "Transaction not found" });
    if (!providerCheckAllowed(req.session.adminId!)) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ message: "Too many look-ups. Wait a minute and try again.", code: "RATE_LIMITED" });
    }
    try {
      const r = await loadDetail(id);
      if (!r) return res.status(404).json({ message: "Transaction not found" });
      // A team share is one slice of ONE charge: compare the batch's charge, not the slice.
      const ours = r.batch_id
        ? { status: r.batch_status ?? r.status, amountKobo: Number(r.batch_amount_kobo ?? r.amount_kobo) }
        : { status: r.status, amountKobo: Number(r.amount_kobo) };
      let d: Awaited<ReturnType<ReturnType<typeof getSplitProvider>["verifyCharge"]>>;
      try { d = await getSplitProvider().verifyCharge(r.provider_ref); }
      catch (e) {
        console.error(`[ADMIN] paystack look-up unavailable for spray ${id}:`, sanitizeMoneyError(e));
        await auditStrict(req, "room_spray.provider_check", id, { id, result: "provider_unavailable" });
        return res.status(502).json({ message: "Paystack could not be reached. Try again shortly.", code: "PROVIDER_UNAVAILABLE" });
      }
      const provider = d ? { status: d.status, amountKobo: d.amountKobo, paidAt: d.paidAt, feeKobo: d.feeKobo, refunded: d.refunded, refundedKobo: d.refundedKobo, split: d.split } : null;
      const mismatches = compareWithProvider(ours, provider && { ...provider, currency: d?.currency });
      const out: ProviderCheckResult = { ours, provider, match: mismatches.length === 0, mismatches, checkedAt: new Date().toISOString() };
      await auditStrict(req, "room_spray.provider_check", id, { id, result: out.match ? "match" : "mismatch" });
      noStore(res);
      res.json(out);
    } catch (e) { fail(res, "Paystack check", e); }
  });
}
