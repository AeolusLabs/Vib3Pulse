// Pure helpers behind the admin spray screens (Transactions tab, spray block). No DOM, no network.
import { SPRAY_STATUSES } from "@shared/spray";
import type { OutcomesResponse, ProviderCheckResult } from "@shared/sprayLedger";

export interface TxFilters {
  from?: string; // yyyy-MM-dd (UTC day)
  to?: string;
  status?: string;
  roomId?: string;
  hostId?: string;
  payerId?: string;
  recipientId?: string;
  q?: string;
}

const FILTER_KEYS = ["from", "to", "status", "roomId", "hostId", "payerId", "recipientId", "q"] as const;

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

export function mismatchBanner(r: Pick<ProviderCheckResult, "match" | "mismatches"> | null | undefined): { verdict: "MATCH" | "MISMATCH"; lines: string[] } {
  if (!r) return { verdict: "MISMATCH", lines: ["No result"] };
  if (r.match && r.mismatches.length === 0) return { verdict: "MATCH", lines: ["Our record and Paystack agree."] };
  return { verdict: "MISMATCH", lines: r.mismatches.length ? [...r.mismatches] : ["The records differ."] };
}

/** "Applied to N live rooms" when the API reports a count, else "Applied". */
export function appliedText(json: { liveRooms?: unknown; appliedTo?: unknown } | null | undefined): string {
  const n = typeof json?.appliedTo === "number" ? json.appliedTo : typeof json?.liveRooms === "number" ? json.liveRooms : null;
  return n === null ? "Applied" : `Applied to ${n} live ${n === 1 ? "room" : "rooms"}`;
}
