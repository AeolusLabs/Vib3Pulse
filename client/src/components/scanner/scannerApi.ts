import { ensureCsrfToken } from "@/lib/queryClient";
import { isCompleteShortCode, normalizeShortCode } from "@shared/ticketCode";

export type ScanKind = "event" | "venue";

/** Who is scanning and for what. `token` is a staff scanner token; without it the organiser's session is used. */
export interface ScannerIdentity {
  kind: ScanKind;
  /** events.id for "event", venue_entry_nights.id for "venue". */
  eventId: string;
  token?: string;
}

export type ScanOutcome =
  | { type: "admitted"; ticketId?: string; holderName: string; tierName?: string | null; checkedInAt?: string }
  | { type: "already_used"; holderName?: string; checkedInAt?: string; byName?: string | null }
  | { type: "wrong_event"; ticketLabel?: string; ticketDate?: string }
  | { type: "not_confirmed"; message: string }
  | { type: "not_found" }
  | { type: "ambiguous" }
  | { type: "auth"; message: string }
  | { type: "network" };

export interface DoorStats { admitted: number; total: number; capacity: number | null; mine: number | null }

export interface LogEntry {
  id: string;
  action: "admit" | "undo" | "reject";
  ticketId?: string;
  holderName: string;
  tierName?: string | null;
  actorName?: string | null;
  detail?: string;
  createdAt: string;
}

const base = (kind: ScanKind) => (kind === "event" ? "/api/tickets" : "/api/venue-tickets");

// POSTs are CSRF-protected for everyone, staff tokens included, so the CSRF header is always sent.
async function headers(id: ScannerIdentity, json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { "x-csrf-token": await ensureCsrfToken() };
  if (json) h["Content-Type"] = "application/json";
  if (id.token) h["X-Scanner-Token"] = id.token;
  return h;
}

const holderOf = (t: any): string =>
  t?.holderName || t?.user?.displayName || t?.user?.username || t?.guestName || "Guest";

/** Check one ticket in, from a scanned QR (full code) or a typed short code. */
export async function validateTicket(id: ScannerIdentity, input: { scanned: string } | { typed: string }): Promise<ScanOutcome> {
  const body: Record<string, string> = { eventId: id.eventId };
  if ("typed" in input) {
    const code = input.typed.trim();
    if (isCompleteShortCode(code)) body.shortCode = normalizeShortCode(code);
    else body.validationCode = code;
  } else {
    body.validationCode = input.scanned.trim();
  }

  let res: Response;
  try {
    res = await fetch(`${base(id.kind)}/validate`, { method: "POST", headers: await headers(id, true), credentials: "include", body: JSON.stringify(body) });
  } catch {
    return { type: "network" };
  }
  let data: any = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }

  if (res.status === 401) return { type: "auth", message: data.message || "This scanner session has ended." };
  if (res.status === 403 && /not authori[sz]ed/i.test(data.message ?? "") && !data.reason) return { type: "auth", message: data.message };

  const info = data.ticketInfo ?? data.ticket;
  if (data.valid === true) {
    return { type: "admitted", ticketId: info?.id, holderName: holderOf(info), tierName: info?.tierName ?? null, checkedInAt: info?.checkedInAt };
  }
  const reason: string | undefined = data.reason;
  if (data.alreadyCheckedIn || reason === "already_used") {
    return { type: "already_used", holderName: info ? holderOf(info) : undefined, checkedInAt: data.checkedInAt ?? info?.checkedInAt, byName: info?.checkedInByName ?? null };
  }
  if (reason === "wrong_event" || (res.status === 400 && /not for this/i.test(data.message ?? ""))) {
    return { type: "wrong_event", ticketLabel: data.ticketLabel, ticketDate: data.ticketDate };
  }
  if (reason === "ambiguous" || res.status === 409) return { type: "ambiguous" };
  if (reason === "not_confirmed" || /cannot be used/i.test(data.message ?? "")) {
    return { type: "not_confirmed", message: data.message || "This ticket cannot be used." };
  }
  if (reason === "not_found" || res.status === 404) return { type: "not_found" };
  return { type: "network" };
}

/** Reverse a wrong admit. Organisers any time; staff within 10 minutes (enforced by the server). */
export async function undoCheckIn(id: ScannerIdentity, ticketId: string): Promise<boolean> {
  try {
    const res = await fetch(`${base(id.kind)}/undo-check-in`, {
      method: "POST",
      headers: await headers(id, true),
      credentials: "include",
      body: JSON.stringify({ ticketId, eventId: id.eventId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchStats(id: ScannerIdentity): Promise<DoorStats | null> {
  try {
    if (id.token) {
      const res = await fetch("/api/scanner/stats", { headers: { "X-Scanner-Token": id.token } });
      if (!res.ok) return null;
      const d = await res.json();
      return { admitted: d.admitted, total: d.total, capacity: d.capacity ?? null, mine: d.mine ?? null };
    }
    // Organiser: derive from the attendee list.
    const path = id.kind === "event" ? `/api/events/${id.eventId}/check-ins` : `/api/venue-events/${id.eventId}/check-ins`;
    const res = await fetch(path, { credentials: "include" });
    if (!res.ok) return null;
    const list: Array<{ checkedInAt?: string | null }> = await res.json();
    return { admitted: list.filter((t) => t.checkedInAt).length, total: list.length, capacity: null, mine: null };
  } catch {
    return null;
  }
}

export async function fetchLog(id: ScannerIdentity, limit = 30): Promise<LogEntry[]> {
  try {
    const path = id.token
      ? `/api/scanner/log?limit=${limit}`
      : id.kind === "event"
        ? `/api/events/${id.eventId}/check-in-log`
        : `/api/venue-events/${id.eventId}/check-in-log`;
    const res = await fetch(path, { credentials: "include", headers: id.token ? { "X-Scanner-Token": id.token } : undefined });
    if (!res.ok) return [];
    const rows: any[] = await res.json();
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      ticketId: r.ticketId,
      holderName: r.holderName || "Guest",
      tierName: r.tierName ?? null,
      actorName: r.actorName ?? null,
      createdAt: r.createdAt,
    }));
  } catch {
    return [];
  }
}
