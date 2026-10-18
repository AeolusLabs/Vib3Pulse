// Calls for minors' rooms. They return the status and the server's code (apiRequest only keeps the message text), so the screens can word each refusal.
import { ensureCsrfToken, refreshCsrfToken } from "@/lib/queryClient";
import type { RoomHostSummary } from "@/lib/roomsApi";

export interface AdultInvite { user: RoomHostSummary; invitedAt: string; acknowledged: boolean }
export type CallResult<T = unknown> = { ok: true; body: T } | { ok: false; status: number; code?: string };

async function call<T>(method: string, url: string): Promise<CallResult<T>> {
  try {
    // A stale CSRF token answers 403 with no code (or a CSRF message): fetch a fresh token and try once more, like apiRequest does.
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {};
      if (method !== "GET") headers["x-csrf-token"] = attempt === 0 ? await ensureCsrfToken() : await refreshCsrfToken();
      const res = await fetch(url, { method, headers, credentials: "include" });
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* no body */ }
      if (res.ok) return { ok: true, body: body as T };
      const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : undefined;
      if (res.status === 403 && method !== "GET" && attempt === 0 && (!code || text.includes("CSRF"))) continue;
      return { ok: false, status: res.status, code };
    }
  } catch {
    return { ok: false, status: 0 };
  }
}

export const listAdultInvites = (roomId: string) => call<{ invites: AdultInvite[] }>("GET", `/api/rooms/${encodeURIComponent(roomId)}/adult-invites`);
export const inviteAdult = (roomId: string, userId: string) => call<{ ok: true }>("POST", `/api/rooms/${encodeURIComponent(roomId)}/adult-invites/${encodeURIComponent(userId)}`);
export const revokeAdult = (roomId: string, userId: string) => call<{ ok: true }>("DELETE", `/api/rooms/${encodeURIComponent(roomId)}/adult-invites/${encodeURIComponent(userId)}`);
/** The invited adult recording that they read the warning. Calling it is the acknowledgement. */
export const acknowledgeMinorsRoom = (roomId: string) => call<{ ok: true }>("POST", `/api/rooms/${encodeURIComponent(roomId)}/adult-invites/acknowledge`);
