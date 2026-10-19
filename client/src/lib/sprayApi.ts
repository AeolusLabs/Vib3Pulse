// Network for spraying (task 5.7). The client never sends an amount, a split, a currency, a payer or a reference: only the
// tier, the recipient's user id and an idempotency key the client made once for this intent (retries reuse it).
// Every call keeps the status, the server's code and Retry-After, so the screens word every refusal themselves.
// Bodies are parsed by sprayUi.ts (parsePostResult, parseStatusBody, parseSprayMe, parseLimitBody); nothing here trusts them.
import { ensureCsrfToken, refreshCsrfToken } from "@/lib/queryClient";
import type { SprayTier } from "@shared/money";

export type SprayCall<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; code?: string; retryAfterSec?: number };

const roomBase = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
const withToken = (token?: string) => (token ? `?token=${encodeURIComponent(token)}` : "");

/** One JSON call with the CSRF retry (same rule as createRoomApi.call). A network failure is status 0: the outcome is unknown. */
export async function sprayCall<T>(method: string, url: string, data?: unknown): Promise<SprayCall<T>> {
  try {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {};
      if (method !== "GET") headers["x-csrf-token"] = attempt === 0 ? await ensureCsrfToken() : await refreshCsrfToken();
      if (data !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url, { method, headers, credentials: "include", cache: "no-store", body: data === undefined ? undefined : JSON.stringify(data) });
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* no body */ }
      if (res.ok) return { ok: true, status: res.status, body: body as T };
      const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const code = typeof b.code === "string" ? b.code : undefined;
      // A stale CSRF token answers 403 with no code: fetch a fresh one and try once more. SPRAY_UNAVAILABLE carries a code.
      if (method !== "GET" && res.status === 403 && attempt === 0 && (!code || text.includes("CSRF"))) continue;
      const ra = Number(res.headers.get("Retry-After"));
      return { ok: false, status: res.status, code, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterSec: Math.min(3600, Math.ceil(ra)) } : {}) };
    }
  } catch {
    return { ok: false, status: 0 };
  }
}

/** POST /api/rooms/:id/spray. `saveCard` is only sent when the save box was ticked (default off). */
export const postSpray = (roomId: string, p: { tier: SprayTier; targetId: string; idempotencyKey: string; saveCard: boolean }, token?: string) =>
  sprayCall<unknown>("POST", `${roomBase(roomId)}/spray${withToken(token)}`, {
    tier: p.tier, targetId: p.targetId, idempotencyKey: p.idempotencyKey, ...(p.saveCard ? { saveCard: true } : {}),
  });

/** GET /api/rooms/:id/spray/:sprayId (the payer's own spray only; anyone else gets 404). */
export const getSprayStatus = (roomId: string, sprayId: string, token?: string) =>
  sprayCall<unknown>("GET", `${roomBase(roomId)}/spray/${encodeURIComponent(sprayId)}${withToken(token)}`);

/** GET /api/users/me/spray: the saved card (last4 and brand only), the daily limit and today's rolling spend. */
export const getSprayMe = () => sprayCall<unknown>("GET", "/api/users/me/spray");

/** PUT /api/rooms/:id/spray/limit `{ kobo }`, one of ROOM_LIMIT_OPTIONS_KOBO. The server checks it again. */
export const putRoomLimit = (roomId: string, kobo: number, token?: string) =>
  sprayCall<unknown>("PUT", `${roomBase(roomId)}/spray/limit${withToken(token)}`, { kobo });

/** PUT /api/users/me/spray/daily-limit `{ kobo }`. The server checks it again (verified and maximum rules). */
export const putDailyLimit = (kobo: number) => sprayCall<unknown>("PUT", "/api/users/me/spray/daily-limit", { kobo });

/** DELETE /api/users/me/spray/method: forget the saved card. The next spray goes through the bank again. */
export const deleteMethod = () => sprayCall<unknown>("DELETE", "/api/users/me/spray/method");
