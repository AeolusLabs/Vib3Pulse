// Now-playing sync maths. Pure: the server stamps `atServerMs`, clients turn that into a target position.
export type PlaybackState = "playing" | "paused" | "ended" | "cue";

export interface NowPlaying {
  v: 1;
  /** Which screen this belongs to: a new screen bumps the version, so a late message for the old one is ignored. */
  screenVersion: number;
  state: PlaybackState;
  positionMs: number;
  atServerMs: number;
  /** For `cue` (Spotify, Apple Music, SoundCloud cannot be driven remotely): when everyone should press play. */
  startAtServerMs?: number;
}

const STATES: readonly PlaybackState[] = ["playing", "paused", "ended", "cue"];
export const MAX_POSITION_MS = 86_400_000;
const CUE_MIN_MS = 1000, CUE_MAX_MS = 30_000, CUE_DEFAULT_MS = 5000;

export type PlaybackInput = { ok: true; state: PlaybackState; positionMs: number; inMs?: number } | { ok: false };

/** Everything arriving from a client is untrusted: only known states, finite clamped numbers, and the current screen. */
export function sanitizePlaybackInput(input: unknown, currentScreenVersion: number): PlaybackInput {
  if (!input || typeof input !== "object") return { ok: false };
  const i = input as Record<string, unknown>;
  if (!STATES.includes(i.state as PlaybackState)) return { ok: false };
  if (typeof i.positionMs !== "number" || !Number.isFinite(i.positionMs)) return { ok: false };
  if (i.screenVersion !== currentScreenVersion) return { ok: false };
  const positionMs = Math.floor(Math.min(Math.max(i.positionMs, 0), MAX_POSITION_MS));
  if (i.state !== "cue") return { ok: true, state: i.state as PlaybackState, positionMs };
  const raw = typeof i.inMs === "number" && Number.isFinite(i.inMs) ? i.inMs : CUE_DEFAULT_MS;
  return { ok: true, state: "cue", positionMs, inMs: Math.floor(Math.min(Math.max(raw, CUE_MIN_MS), CUE_MAX_MS)) };
}

export function targetPositionMs(np: NowPlaying, serverNowMs: number): number {
  if (np.state !== "playing") return np.positionMs;
  return np.positionMs + Math.max(0, serverNowMs - np.atServerMs);
}

export function needsCorrection(currentMs: number, targetMs: number, toleranceMs = 1500): boolean {
  return Math.abs(currentMs - targetMs) > toleranceMs;
}

export function cueCountdownMs(np: NowPlaying, serverNowMs: number): number | null {
  if (np.state !== "cue" || np.startAtServerMs === undefined) return null;
  return Math.max(0, np.startAtServerMs - serverNowMs);
}
