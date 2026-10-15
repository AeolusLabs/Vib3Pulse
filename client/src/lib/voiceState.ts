// Pure helpers for the room's voice UI.
export type VoiceStatus = "off" | "needs-tap" | "connecting" | "listening" | "speaking" | "error";

export function voiceStatus(i: { voiceEnabled: boolean; unlocked: boolean; connected: boolean; failed: boolean; canPublish: boolean; micOn: boolean }): VoiceStatus {
  if (!i.voiceEnabled) return "off";
  if (!i.unlocked) return "needs-tap";
  if (i.failed) return "error";
  if (!i.connected) return "connecting";
  return i.canPublish && i.micOn ? "speaking" : "listening";
}

/** Who gets a speaking ring: only people on the stage (host, co-hosts, stage guests), lit while they are the active speaker. */
export function speakingRings(speakers: string[], active: string[]): Record<string, boolean> {
  return Object.fromEntries(speakers.map((id) => [id, active.includes(id)]));
}

/** Host and co-hosts are always speakers; guests only while on the stage. Only people present are listed, once each. */
export function speakerIds(members: Array<{ userId: string; role: "host" | "cohost" | "guest" }>, stage: string[]): string[] {
  const onStage = new Set(stage);
  return members.filter((m) => m.role !== "guest" || onStage.has(m.userId)).map((m) => m.userId);
}

/** Milliseconds until a held screen spot is given up, on the server's clock. null when the holder is present. Never negative. */
export function awayRemainingMs(awayUntil: number | null, serverOffsetMs: number, clientNowMs: number): number | null {
  return awayUntil === null ? null : Math.max(0, awayUntil - (clientNowMs + serverOffsetMs));
}

/** 72000 -> "1:12". Rounds up so the countdown never shows 0:00 while time is left. */
export function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
/**
 * Why Go live failed. "not-allowed-yet": LiveKit refused to publish because the camera permission the host just granted has not
 * reached us yet (it can arrive about a second after the grant). "blocked": the browser or the person said no to the camera or mic.
 */
export type StartErrorKind = "not-allowed-yet" | "blocked" | "other";
export function startErrorKind(e: unknown): StartErrorKind {
  const err = (typeof e === "object" && e !== null ? e : {}) as { name?: unknown; message?: unknown };
  const text = `${String(err.name ?? "")} ${String(err.message ?? "")}`;
  if (/insufficient permissions/i.test(text)) return "not-allowed-yet";
  return /denied|permission|NotAllowed/i.test(text) ? "blocked" : "other";
}

/** Try Go live once more (after a short wait) only when the permission may still be on its way. A browser "no" will not change by waiting. */
export function shouldRetryStart(kind: StartErrorKind, attempt: number): boolean {
  return kind === "not-allowed-yet" && attempt === 0;
}

/**
 * Show the holder "your spot is being held" only for a real drop: the app connection is down, or the media connection has been
 * down for 3 s. LiveKit's signal blips last well under a second and must not flash the countdown.
 */
export function shouldShowHold(i: { isHolder: boolean; socketReconnecting: boolean; mediaDownSince: number | null; now: number }): boolean {
  if (!i.isHolder) return false;
  return i.socketReconnecting || (i.mediaDownSince !== null && i.now - i.mediaDownSince >= 3_000);
}

/** When a drop started: kept while it lasts (so a countdown does not restart), null once it is over. */
export function downSince(prev: number | null, down: boolean, now: number): number | null {
  return down ? prev ?? now : null;
}
