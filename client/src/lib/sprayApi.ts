// Network for spraying (task 5.7). The client never sends an amount, a split, a currency, a payer or a reference: only the
// tier, the recipient's user id and an idempotency key the client made once for this intent (retries reuse it).
// Every call keeps the status, the server's code, the 402 reason and spray id, and Retry-After, so the screens word every
// refusal themselves. Every attempt gives up after SPRAY_REQUEST_TIMEOUT_MS (AbortController): a hung network becomes
// status 0, an unknown outcome, never a spinner forever.
// Bodies are parsed by sprayUi.ts (outcomeOfPost, outcomeOfStatus, parseSprayMe, parseLimitBody); nothing here trusts them.
import { ensureCsrfToken, refreshCsrfToken } from "@/lib/queryClient";
import type { SprayTier } from "@shared/money";
import { SPRAY_REQUEST_TIMEOUT_MS, parseRetryAfter } from "@/lib/sprayUi";

export type SprayCall<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; code?: string; reason?: string; sprayId?: string; retryAfterSec?: number };

const roomBase = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
const withToken = (token?: string) => (token ? `?token=${encodeURIComponent(token)}` : "");
const short = (x: unknown, max: number) => (typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined);

/** fetch with a hard time limit. A timeout rejects (AbortError), which the caller turns into status 0. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : undefined;
  try {
    return await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One JSON call with the CSRF retry (same rule as createRoomApi.call). A network failure or a timeout is status 0: the
 * outcome is unknown. The time limit covers each attempt, reading the body included.
 */
export async function sprayCall<T>(method: string, url: string, data?: unknown, timeoutMs: number = SPRAY_REQUEST_TIMEOUT_MS): Promise<SprayCall<T>> {
  try {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {};
      if (method !== "GET") headers["x-csrf-token"] = attempt === 0 ? await ensureCsrfToken() : await refreshCsrfToken();
      if (data !== undefined) headers["Content-Type"] = "application/json";
      const started = Date.now();
      const res = await fetchWithTimeout(url, { method, headers, credentials: "include", cache: "no-store", body: data === undefined ? undefined : JSON.stringify(data) }, timeoutMs);
      const left = Math.max(1, timeoutMs - (Date.now() - started));
      let bodyTimer: ReturnType<typeof setTimeout> | undefined;
      const text = await Promise.race([
        res.text().catch(() => ""),
        new Promise<null>((resolve) => { bodyTimer = setTimeout(() => resolve(null), left); }),
      ]).finally(() => clearTimeout(bodyTimer));
      // The headers came but the body hung: we can't read the answer, so it is unknown (status 0), even for a 200.
      if (text === null) return { ok: false, status: 0 };
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* no body */ }
      if (res.ok) return { ok: true, status: res.status, body: body as T };
      const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const code = short(b.code, 64);
      // A stale CSRF token answers 403 with no code: fetch a fresh one and try once more. SPRAY_UNAVAILABLE carries a code.
      if (method !== "GET" && res.status === 403 && attempt === 0 && (!code || text.includes("CSRF"))) continue;
      const reason = short(b.reason, 32);
      const sprayId = short(b.sprayId, 64) ?? short(b.batchId, 64); // a team charge's batch id plays the spray id
      const ra = parseRetryAfter(res.headers.get("Retry-After"), Date.now());
      return { ok: false, status: res.status, ...(code ? { code } : {}), ...(reason ? { reason } : {}), ...(sprayId ? { sprayId } : {}), ...(ra ? { retryAfterSec: ra } : {}) };
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

/**
 * POST /api/rooms/:id/spray/team (one charge paying a whole team). The server answers in the single spray's shape plus
 * `batchId`; the batch id is used as the spray id from here on, so the same pay machine, replay rule and poll serve both.
 * The client sends no amount and no share: only the tier, the side and the idempotency key.
 */
export const postSprayTeam = async (roomId: string, p: { tier: SprayTier; side: "A" | "B"; idempotencyKey: string; saveCard: boolean }, token?: string): Promise<SprayCall<unknown>> => {
  const r = await sprayCall<unknown>("POST", `${roomBase(roomId)}/spray/team${withToken(token)}`, {
    tier: p.tier, side: p.side, idempotencyKey: p.idempotencyKey, ...(p.saveCard ? { saveCard: true } : {}),
  });
  return r.ok ? { ...r, body: withSprayId(r.body) } : r;
};

/** GET /api/rooms/:id/spray/team/:batchId (the payer only; anyone else gets 404). */
export const getSprayTeamStatus = async (roomId: string, batchId: string, token?: string): Promise<SprayCall<unknown>> => {
  const r = await sprayCall<unknown>("GET", `${roomBase(roomId)}/spray/team/${encodeURIComponent(batchId)}${withToken(token)}`);
  return r.ok ? { ...r, body: withSprayId(r.body) } : r;
};

/** A team answer read as a spray answer: `sprayId` = `batchId`. Anything that isn't an object is passed on untouched. */
function withSprayId(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;
  return typeof b.batchId === "string" && b.sprayId === undefined ? { ...b, sprayId: b.batchId } : b;
}

/** GET /api/users/me/spray: the saved card (last4 and brand only), the daily limit and today's rolling spend. */
export const getSprayMe = () => sprayCall<unknown>("GET", "/api/users/me/spray");

/** PUT /api/rooms/:id/spray/limit `{ kobo }`, one of ROOM_LIMIT_OPTIONS_KOBO. The server checks it again. */
export const putRoomLimit = (roomId: string, kobo: number, token?: string) =>
  sprayCall<unknown>("PUT", `${roomBase(roomId)}/spray/limit${withToken(token)}`, { kobo });

/** PUT /api/users/me/spray/daily-limit `{ kobo }`. The server checks it again (verified and maximum rules). */
export const putDailyLimit = (kobo: number) => sprayCall<unknown>("PUT", "/api/users/me/spray/daily-limit", { kobo });

/** DELETE /api/users/me/spray/method: forget the saved card. The next spray goes through the bank again. */
export const deleteMethod = () => sprayCall<unknown>("DELETE", "/api/users/me/spray/method");
