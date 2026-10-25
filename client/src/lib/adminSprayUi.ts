// Pure helpers behind the admin spray screens (Transactions tab, spray block). No DOM, no network.
import { SPRAY_STATUSES } from "@shared/spray";
import type { OutcomesResponse, ProviderCheckResult } from "@shared/sprayLedger";
import { naira } from "../components/admin/charts/tokens";

export interface TxFilters {
  from?: string; // yyyy-MM-dd (UTC day)
  to?: string;
  status?: string;
  roomId?: string;
  hostId?: string;
  payerId?: string;
  recipientId?: string;
  /** Exact usernames (case-insensitive) and a room-title prefix. */
  host?: string;
  payer?: string;
  recipient?: string;
  room?: string;
  q?: string;
}

const FILTER_KEYS = ["from", "to", "status", "roomId", "hostId", "payerId", "recipientId", "room", "host", "payer", "recipient", "q"] as const;

/** Query string (no leading "?") holding only the filters that are set. cursor/limit are paging, not filters. */
export function buildTxQuery(filters: TxFilters, paging: { cursor?: string | null; limit?: number } = {}): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = filters[k]?.trim();
    if (v) p.set(k, v);
  }
  if (paging.cursor) p.set("cursor", paging.cursor);
  if (paging.limit) p.set("limit", String(paging.limit));
  return p.toString();
}

export const CSV_PATH = "/api/admin/rooms/sprays/transactions.csv";
export function csvUrl(filters: TxFilters): string {
  const qs = buildTxQuery(filters);
  return qs ? `${CSV_PATH}?${qs}` : CSV_PATH;
}

export const CSV_MAX_ROWS = 50_000;
export const TOO_MANY_ROWS_MESSAGE = `Narrow the date range: exports are limited to ${CSV_MAX_ROWS.toLocaleString("en-US")} rows`;

/** What to show when the CSV request failed. The server answers 413 + code TOO_MANY_ROWS when the cap is hit. */
export function csvErrorMessage(status: number, body: { code?: string } | null): string {
  if (status === 413 || body?.code === "TOO_MANY_ROWS") return TOO_MANY_ROWS_MESSAGE;
  if (status === 403) return "Your role cannot export transactions.";
  return "The export did not work. Try again.";
}

/** The ledger and the copy count days in UTC, so a day string is always the UTC calendar day. */
export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const DAY_MS = 864e5;

/**
 * A day string for a date from the range picker. A calendar click is local midnight (take the day the admin clicked);
 * any other instant (a "last N days" preset, now) is read in UTC.
 */
export function pickedYmd(d: Date): string {
  const localMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  if (!localMidnight) return ymd(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Default range: the last `days` UTC days ending today. Call it per fetch so a long-open tab never freezes `to`. */
export function defaultRange(now: Date = new Date(), days = 7): { from: string; to: string } {
  return { from: ymd(new Date(now.getTime() - days * DAY_MS)), to: ymd(now) };
}

/**
 * What the range picker must show: the range actually applied to the query (the default when none was picked), never "All time".
 * The ledger API needs from and to and caps a range at 366 days, so there is no unbounded state on the Transactions tab.
 */
export function pickerRange(range: { from: string; to: string } | null, defaults: { from: string; to: string } = defaultRange()): { from: Date; to: Date } {
  const r = range ?? defaults;
  return { from: new Date(`${r.from}T00:00:00`), to: new Date(`${r.to}T00:00:00`) };
}
export const TX_PRESET_DAYS = [7, 30, 90, 366];

/** icon names are resolved by the component; the text label is always shown beside it, so status never relies on colour. */
export type StatusIcon = "clock" | "check" | "check-check" | "undo" | "x" | "alert";
export interface StatusMeta { label: string; icon: StatusIcon; tone: "neutral" | "good" | "warn" | "bad" }

const STATUS_META: Record<(typeof SPRAY_STATUSES)[number], StatusMeta> = {
  created: { label: "Started", icon: "clock", tone: "neutral" },
  pending: { label: "Pending", icon: "clock", tone: "neutral" },
  paid: { label: "Paid", icon: "check", tone: "warn" },
  delivered: { label: "Delivered", icon: "check-check", tone: "good" },
  reversing: { label: "Reversing", icon: "undo", tone: "warn" },
  reversed: { label: "Reversed", icon: "undo", tone: "neutral" },
  failed: { label: "Failed", icon: "x", tone: "bad" },
  disputed: { label: "Disputed", icon: "alert", tone: "bad" },
};

export function statusLabel(status: string): StatusMeta {
  return (STATUS_META as Record<string, StatusMeta>)[status] ?? { label: status || "Unknown", icon: "alert", tone: "neutral" };
}

export const STATUS_CHOICES = SPRAY_STATUSES.map((s) => ({ value: s as string, ...statusLabel(s) }));

export interface FunnelEntry { key: string; label: string; count: number; kobo: number }
/**
 * The funnel as two groups: the happy path (initiated, paid, delivered) and where the rest ended.
 * paid..pending partition initiated, so `parts` always sums to `total` (`reconciles` says whether the server data did).
 */
export function funnelBuckets(o: OutcomesResponse | null | undefined) {
  const f = o?.funnel;
  const get = (k: keyof OutcomesResponse["funnel"], label: string): FunnelEntry => ({ key: k, label, count: f?.[k].count ?? 0, kobo: f?.[k].kobo ?? 0 });
  const total = get("initiated", "Started");
  const parts = [
    get("delivered", "Delivered"),
    get("paid", "Paid, awaiting delivery"),
    get("pending", "Pending"),
    get("failed", "Failed"),
    get("reversed", "Reversed"),
    get("disputed", "Disputed"),
  ];
  const sumCount = parts.reduce((a, p) => a + p.count, 0);
  const sumKobo = parts.reduce((a, p) => a + p.kobo, 0);
  return { total, parts, sumCount, sumKobo, reconciles: sumCount === total.count && sumKobo === total.kobo };
}

// Whatever an admin turns off, only an admin can turn on: resume and unblock are super_admin only.
export const canResume = (role: string | null | undefined): boolean => role === "super_admin";
export const canBlock = (role: string | null | undefined): boolean => role === "super_admin" || role === "finance_manager";
export const canSeeTransactions = canBlock;

export const BLOCK_CONFIRM = "Hosts and guests are told at once. Only an admin can turn it back on.";
export const RESUME_DISABLED_REASON = "Only a super-admin can turn this back on.";

/** The server words amounts as "1000 kobo"; admins read naira. */
export const koboToNairaText = (line: string): string => line.replace(/(\d+) kobo/g, (_, k) => naira(Number(k)));

export function mismatchBanner(r: Pick<ProviderCheckResult, "match" | "mismatches"> | null | undefined): { verdict: "MATCH" | "MISMATCH"; lines: string[] } {
  if (!r) return { verdict: "MISMATCH", lines: ["No result"] };
  if (r.match && r.mismatches.length === 0) return { verdict: "MATCH", lines: ["Our record and Paystack agree."] };
  return { verdict: "MISMATCH", lines: r.mismatches.length ? r.mismatches.map(koboToNairaText) : ["The records differ."] };
}

export const ATTENTION_KINDS = ["pending", "reversing", "paid_not_delivered", "disputed"] as const;
export const ATTENTION_PER_KIND = 50;
const ATTENTION_LABEL: Record<string, string> = { pending: "pending", reversing: "reversing", paid_not_delivered: "paid, not delivered", disputed: "disputed" };
/** One note per kind that hit the 50 cap. Reads the per-kind record; an old boolean `true` means "some list was cut". */
export function attentionCapNotes(capped: Record<string, boolean> | boolean | null | undefined): string[] {
  if (capped === true) return [`Showing the newest ${ATTENTION_PER_KIND} of each kind`];
  if (!capped) return [];
  return ATTENTION_KINDS.filter((k) => capped[k]).map((k) => `Showing the newest ${ATTENTION_PER_KIND} ${ATTENTION_LABEL[k]}`);
}

/** "Applied to N live rooms" when the API reports a count, else "Applied". */
export function appliedText(json: { liveRooms?: unknown; appliedTo?: unknown } | null | undefined): string {
  const n = typeof json?.appliedTo === "number" ? json.appliedTo : typeof json?.liveRooms === "number" ? json.liveRooms : null;
  return n === null ? "Applied" : `Applied to ${n} live ${n === 1 ? "room" : "rooms"}`;
}
