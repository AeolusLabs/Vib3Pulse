// Decisions for weak connections, as pure functions so they can be tested. Many viewers and performers are on slow, lossy
// mobile data: the stream must degrade (smaller picture, then sound only) rather than stall or end.

/** What `navigator.connection` offers (Chromium browsers only: Safari and Firefox give nothing). */
export interface ConnInfo { effectiveType?: string; downlink?: number; saveData?: boolean }

export type VideoProfile = "saver" | "balanced" | "standard";

/** Our caps for each quality. Smaller means far fewer bytes; sound is never reduced below LiveKit's music preset (48 kbps, with redundancy). */
export function profileSettings(p: VideoProfile): { width: number; height: number; frameRate: number; maxBitrate: number } {
  switch (p) {
    case "saver": return { width: 640, height: 360, frameRate: 15, maxBitrate: 350_000 };
    case "balanced": return { width: 960, height: 540, frameRate: 24, maxBitrate: 800_000 };
    case "standard": return { width: 1280, height: 720, frameRate: 30, maxBitrate: 1_500_000 };
  }
}

const SLOW = new Set(["slow-2g", "2g", "3g"]);

/** The quality a performer starts on when they leave it on Auto. Unknown connections get the middle one: never assume fast. */
export function pickStartProfile(c: ConnInfo | undefined): VideoProfile {
  if (!c) return "balanced";
  if (c.saveData || (c.effectiveType !== undefined && SLOW.has(c.effectiveType)) || (c.downlink !== undefined && c.downlink < 1.5)) return "saver";
  if (c.effectiveType === "4g" && c.downlink !== undefined && c.downlink >= 5) return "standard";
  return "balanced";
}

/** A viewer on data saver or 2g starts with sound only and taps to watch. */
export function viewerStartsAudioOnly(c: ConnInfo | undefined): boolean {
  return !!c && (c.saveData === true || c.effectiveType === "slow-2g" || c.effectiveType === "2g");
}

export type LinkQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

/** After 8 s of a poor or lost link, offer to drop the picture and keep the sound. Never nags on a good link. */
export function weakLinkAdvice(quality: LinkQuality, poorForMs: number): "none" | "suggest-audio-only" {
  return (quality === "poor" || quality === "lost") && poorForMs >= 8_000 ? "suggest-audio-only" : "none";
}
/**
 * Microphone capture for going live. Voice processing (echo cancellation, noise suppression, auto gain) is made for speech and
 * flattens music, so music mode switches it off; without echo cancellation the room's sound can come back through the speakers.
 */
export function micCapture(micId: string | undefined, music: boolean): { deviceId?: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
  const on = !music;
  return { ...(micId ? { deviceId: micId } : {}), echoCancellation: on, noiseSuppression: on, autoGainControl: on };
}

/** Data saver sends a single 360p layer: simulcast's extra smaller copies add roughly a third more upload. */
export function cameraSimulcast(p: VideoProfile): boolean {
  return p !== "saver";
}

// ---------------------------------------------------------------- Gamers live: a player's own screen capture

/** What a player picks for their screen: Light 540p30, Smooth 720p60, Sharp 1080p30. */
export type GameProfile = "light" | "smooth" | "sharp";
export const GAME_PROFILES: readonly GameProfile[] = ["light", "smooth", "sharp"];
export const GAME_PROFILE_LABEL: Record<GameProfile, string> = { light: "Light", smooth: "Smooth", sharp: "Sharp" };
export const GAME_PROFILE_HINT: Record<GameProfile, string> = { light: "540p, 30 fps. Easiest on your connection.", smooth: "720p, 60 fps. Best for fast games.", sharp: "1080p, 30 fps. Needs a strong upload." };

export function gameProfileSettings(p: GameProfile): { width: number; height: number; frameRate: number; maxBitrate: number } {
  switch (p) {
    case "light": return { width: 960, height: 540, frameRate: 30, maxBitrate: 1_200_000 };
    case "smooth": return { width: 1280, height: 720, frameRate: 60, maxBitrate: 3_500_000 };
    case "sharp": return { width: 1920, height: 1080, frameRate: 30, maxBitrate: 4_500_000 };
  }
}

/** The start quality for a player who has not chosen: never assume a fast upload. */
export function pickGameProfile(c: ConnInfo | undefined): GameProfile {
  return pickStartProfile(c) === "standard" ? "smooth" : "light";
}

/** The simulcast layer a viewer's tile needs: 720p for a big tile, 360p for a medium one, 180p for a thumbnail. */
export function viewerLayer(tileWidthPx: number): 720 | 360 | 180 {
  if (tileWidthPx >= 560) return 720;
  if (tileWidthPx >= 250) return 360;
  return 180;
}
