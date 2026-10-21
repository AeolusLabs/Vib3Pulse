// Rooms admin read models (rooms admin plan, task 4): live rooms, usage overview, spray breakdown. Read-only, parameterised SQL.
// Sales are delivered sprays by delivered_at; refunds are reversed sprays by reversed_at. Days are UTC. A range is [from, to):
// `to` is exclusive, so a plain date `to` means "up to the end of that day".
import { pool } from "../storage";
import { roomHub } from "./RoomHub";

export type Range = { from: Date; to: Date };
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function parseEdge(v: unknown): { d: Date; dateOnly: boolean } | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 40) return null;
  const d = new Date(DATE_ONLY.test(v) ? `${v}T00:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? null : { d, dateOnly: DATE_ONLY.test(v) };
}

/** Defaults to the last 30 days. Null when a date is junk, from is not before to, or the range is over 366 days. */
export function parseRange(query: { from?: unknown; to?: unknown }, now: Date = new Date()): Range | null {
  const f = query.from === undefined ? { d: new Date(now.getTime() - 30 * DAY_MS), dateOnly: false } : parseEdge(query.from);
  const t = query.to === undefined ? { d: now, dateOnly: false } : parseEdge(query.to);
  if (!f || !t) return null;
  const to = t.dateOnly ? new Date(t.d.getTime() + DAY_MS) : t.d;
  if (f.d.getTime() >= to.getTime() || to.getTime() - f.d.getTime() > MAX_RANGE_DAYS * DAY_MS) return null;
  return { from: f.d, to };
}

export interface LiveRoomRow {
  id: string; title: string; hostId: string; hostUsername: string; ageLimit: string; members: number;
  startedAt: string | null; ticketed: boolean; hostFrozen: boolean;
}

export async function listLiveRooms(): Promise<LiveRoomRow[]> {
  const rows = (await pool.query(
    `select r.id, r.title, r.host_id, u.username, r.age_limit, r.started_at, (r.ticket_price_kobo is not null) as ticketed,
            exists (select 1 from room_host_freezes f where f.host_id = r.host_id) as frozen
       from rooms r join users u on u.id = r.host_id
      where r.status = 'live' order by r.started_at desc nulls last limit 200`,
  )).rows as { id: string; title: string; host_id: string; username: string; age_limit: string; started_at: Date | null; ticketed: boolean; frozen: boolean }[];
  return rows.map((r) => ({
    id: r.id, title: r.title, hostId: r.host_id, hostUsername: r.username, ageLimit: r.age_limit, members: roomHub.count(r.id),
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null, ticketed: r.ticketed, hostFrozen: r.frozen,
  }));
}

export interface Overview { roomsCreated: number; roomsStarted: number; uniqueHosts: number; peakConcurrent: number; ticketsSold: number }

export async function roomsOverview(range: Range): Promise<Overview> {
  const p = [range.from, range.to];
  const [rooms, tickets] = await Promise.all([
    pool.query(
      `select (count(*) filter (where created_at >= $1 and created_at < $2))::int as created,
              (count(*) filter (where started_at >= $1 and started_at < $2))::int as started,
              (count(distinct host_id) filter (where started_at >= $1 and started_at < $2))::int as hosts,
              coalesce(max(peak_members) filter (where started_at >= $1 and started_at < $2), 0)::int as peak
         from rooms`, p),
    pool.query(`select count(*)::int as n from room_tickets where status = 'paid' and created_at >= $1 and created_at < $2`, p),
  ]);
  const r = rooms.rows[0] as { created: number; started: number; hosts: number; peak: number };
  return { roomsCreated: r.created, roomsStarted: r.started, uniqueHosts: r.hosts, peakConcurrent: r.peak, ticketsSold: (tickets.rows[0] as { n: number }).n };
}

export interface SprayBreakdown {
  totals: { count: number; grossKobo: number; vatKobo: number; feeKobo: number; reserveKobo: number; platformKobo: number; hostKobo: number; refundedKobo: number };
  byTier: { tier: string; count: number; grossKobo: number }[];
  byDay: { day: string; count: number; grossKobo: number }[];
  topRooms: { roomId: string; title: string; count: number; grossKobo: number }[];
  topHosts: { hostId: string; username: string; count: number; grossKobo: number }[];
}

export async function sprayBreakdown(range: Range): Promise<SprayBreakdown> {
  const p = [range.from, range.to];
  const sold = `status = 'delivered' and delivered_at >= $1 and delivered_at < $2`;
  const n = (v: unknown) => Number(v ?? 0);
  const [tot, refunded, tier, day, rooms, hosts] = await Promise.all([
    pool.query(
      `select count(*)::int as c, coalesce(sum(amount_kobo),0)::bigint as gross, coalesce(sum(vat_kobo),0)::bigint as vat, coalesce(sum(fee_kobo),0)::bigint as fee,
              coalesce(sum(reserve_kobo),0)::bigint as reserve, coalesce(sum(platform_kobo),0)::bigint as platform, coalesce(sum(host_kobo),0)::bigint as host
         from spray_payments where ${sold}`, p),
    pool.query(`select coalesce(sum(amount_kobo),0)::bigint as k from spray_payments where status = 'reversed' and reversed_at >= $1 and reversed_at < $2`, p),
    pool.query(`select tier, count(*)::int as c, sum(amount_kobo)::bigint as gross from spray_payments where ${sold} group by tier order by gross desc`, p),
    pool.query(
      `select to_char(delivered_at at time zone 'UTC', 'YYYY-MM-DD') as d, count(*)::int as c, sum(amount_kobo)::bigint as gross
         from spray_payments where ${sold} group by 1 order by 1`, p),
    pool.query(
      `select s.room_id, r.title, count(*)::int as c, sum(s.amount_kobo)::bigint as gross
         from spray_payments s join rooms r on r.id = s.room_id
        where s.status = 'delivered' and s.delivered_at >= $1 and s.delivered_at < $2 group by s.room_id, r.title order by gross desc limit 10`, p),
    pool.query(
      `select s.host_id, u.username, count(*)::int as c, sum(s.amount_kobo)::bigint as gross
         from spray_payments s join users u on u.id = s.host_id
        where s.status = 'delivered' and s.delivered_at >= $1 and s.delivered_at < $2 group by s.host_id, u.username order by gross desc limit 10`, p),
  ]);
  const t = tot.rows[0] as Record<string, unknown>;
  return {
    totals: {
      count: n(t.c), grossKobo: n(t.gross), vatKobo: n(t.vat), feeKobo: n(t.fee), reserveKobo: n(t.reserve), platformKobo: n(t.platform), hostKobo: n(t.host),
      refundedKobo: n((refunded.rows[0] as { k: unknown }).k),
    },
    byTier: (tier.rows as any[]).map((r) => ({ tier: r.tier, count: r.c, grossKobo: n(r.gross) })),
    byDay: (day.rows as any[]).map((r) => ({ day: r.d, count: r.c, grossKobo: n(r.gross) })),
    topRooms: (rooms.rows as any[]).map((r) => ({ roomId: r.room_id, title: r.title, count: r.c, grossKobo: n(r.gross) })),
    topHosts: (hosts.rows as any[]).map((r) => ({ hostId: r.host_id, username: r.username, count: r.c, grossKobo: n(r.gross) })),
  };
}
