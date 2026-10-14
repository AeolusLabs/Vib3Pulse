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
