// Network for the wizard and the quick start: create, start, switch voice and live video. Each call keeps the status, the
// server's code and the field (apiRequest only keeps the message text), so the screens can word every refusal themselves.
import { useQuery } from "@tanstack/react-query";
import { ensureCsrfToken, refreshCsrfToken } from "@/lib/queryClient";
import { fetchRoomsConfig, type RoomsConfig } from "@/lib/roomsApi";
import type { WizardHost, WizardState } from "@/lib/createRoomRules";
import { buildCreatePayload, type ApiFailure, type RoomLink, type WizardExtras } from "@/lib/createRoomWizardUi";

export type Call<T> = { ok: true; body: T } | ({ ok: false } & ApiFailure);

/** One JSON call with the CSRF retry. Exported for the ticket screens (tickets/ticketsApi.ts), which word refusals the same way. */
export async function call<T>(method: string, url: string, data?: unknown): Promise<Call<T>> {
  try {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { "x-csrf-token": attempt === 0 ? await ensureCsrfToken() : await refreshCsrfToken() };
      if (data !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url, { method, headers, credentials: "include", body: data === undefined ? undefined : JSON.stringify(data) });
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* no body */ }
      if (res.ok) return { ok: true, body: body as T };
      const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const code = typeof b.code === "string" ? b.code : undefined;
      const field = typeof b.field === "string" ? b.field : undefined;
      const reason = typeof b.reason === "string" ? b.reason : undefined;
      // A stale CSRF token answers 403 with no code: fetch a fresh one and try once more, like apiRequest does.
      if (res.status === 403 && attempt === 0 && (!code || text.includes("CSRF"))) continue;
      return { ok: false, status: res.status, code, field, reason };
    }
  } catch {
    return { ok: false, status: 0 };
  }
}

export interface CreatedRoom { room: { id: string }; inviteLink?: string }

export type CreateOutcome =
  | { ok: true; roomId: string; inviteLink: string | null; live: boolean; startFailure: ApiFailure | null; voiceFailed: boolean; videoFailed: boolean }
  | ({ ok: false } & ApiFailure);

/**
 * POST /api/rooms; for "Go live now" also POST /start, then voice and live video when picked. Only the create can fail the
 * whole thing: a failed start leaves a made room (the caller says so), a failed voice or video switch leaves a live room.
 */
export async function createRoom(s: WizardState, extras: WizardExtras, link: RoomLink): Promise<CreateOutcome> {
  const made = await call<CreatedRoom>("POST", "/api/rooms", buildCreatePayload(s, extras, link));
  if (!made.ok) return made;
  const id = made.body.room.id;
  const inviteLink = made.body.inviteLink ?? null;
  const base = { ok: true as const, roomId: id, inviteLink, voiceFailed: false, videoFailed: false };
  if (s.when !== "now") return { ...base, live: false, startFailure: null };

  const enc = encodeURIComponent(id);
  const started = await call<unknown>("POST", `/api/rooms/${enc}/start`);
  if (!started.ok) return { ...base, live: false, startFailure: { status: started.status, code: started.code, field: started.field, reason: started.reason } };
  let voiceFailed = false, videoFailed = false;
  if (s.voice) {
    const v = await call<unknown>("PUT", `/api/rooms/${enc}/voice`, { enabled: true });
    voiceFailed = !v.ok;
    if (v.ok && s.liveVideo) videoFailed = !(await call<unknown>("PUT", `/api/rooms/${enc}/live-video`, { enabled: true })).ok;
    else if (!v.ok && s.liveVideo) videoFailed = true;
  }
  return { ...base, live: true, startFailure: null, voiceFailed, videoFailed };
}

/** Used only while GET /api/rooms/config has not said how old the account is: assume old enough, the server decides. */
const ASSUMED_ACCOUNT_DAYS = 365;

/** The caller's own account age and the minimum for public rooms, from GET /api/rooms/config (optional until the server sends it). */
type HostConfig = { accountAgeDays: number; minAccountAgeDays: number };

/**
 * What the wizard knows about the host. accountAgeDays and minAccountAgeDays come from GET /api/rooms/config `host`, so
 * public is closed up front for a new account. Without them the account is assumed old enough; once the server has answered
 * ACCOUNT_TOO_NEW (the caller passes that in) accountAgeDays drops to 0 and public is never offered again.
 * Every request waits for `open`, so a closed wizard (StoriesBar mounts one on every feed) fetches nothing.
 */
export function useWizardHost(open: boolean, accountTooNew: boolean) {
  const me = useQuery<{ age: number | null }>({ queryKey: ["/api/users/me/room-privacy"], enabled: open });
  const verification = useQuery<{ verified: boolean; band: "adult" | "teen" | null }>({ queryKey: ["/api/users/me/age-verification"], enabled: open });
  // Same key and fetcher as useRoomsConfig in roomsApi, so it shares that cache; only the `enabled` gate is added.
  const config = useQuery({ queryKey: ["/api/rooms/config"], queryFn: fetchRoomsConfig, staleTime: 5 * 60 * 1000, enabled: open });
  const hostConfig = (config.data as (RoomsConfig & { host?: HostConfig }) | undefined)?.host;
  const knownDays = typeof hostConfig?.accountAgeDays === "number" ? hostConfig.accountAgeDays : ASSUMED_ACCOUNT_DAYS;
  const minAccountAgeDays = typeof hostConfig?.minAccountAgeDays === "number" ? hostConfig.minAccountAgeDays : 0;
  const host: WizardHost | null = me.data
    ? { age: me.data.age ?? null, accountAgeDays: accountTooNew ? 0 : knownDays, idVerifiedAdult: !!verification.data?.verified && verification.data.band === "adult" }
    : null;
  const flags = { paidRooms: config.data?.features.paidRooms === true, spray: config.data?.features.spray === true };
  // Gamers live: the game-format choice is offered only while the server says the flag is on (the key is absent when off).
  const gaming = config.data?.features.gaming === true;
  const gameLanes = gaming && config.data?.game?.lanes === true;
  const readiness = config.data?.hostMoneyReadiness;
  return { host, flags, readiness, gaming, gameLanes, minAccountAgeDays, loading: me.isLoading, failed: me.isError };
}
