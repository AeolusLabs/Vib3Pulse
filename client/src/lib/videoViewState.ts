// Pure rules for the live video views (compact and immersive). No React, no DOM: tested in scripts/test-rooms-unit-videoview.ts.
import { RAIL_MIN_WIDTH, defaultVideoView, type VideoView } from "@/lib/roomLayout";
import type { VideoProfile } from "@/lib/bandwidth";

export type { VideoView };

/** True when the two widths sit on different sides of the 1024 px line (phone/tablet vs desktop). */
export function crossesRailLine(widthBefore: number, widthAfter: number): boolean {
  return (widthBefore < RAIL_MIN_WIDTH) !== (widthAfter < RAIL_MIN_WIDTH);
}

/** Crossing the 1024 line resets to that width's default; otherwise a user's choice is kept, and without one the default follows the width. */
export function viewAfterResize(current: VideoView, userChose: boolean, widthBefore: number, widthAfter: number): VideoView {
  if (!userChose || crossesRailLine(widthBefore, widthAfter)) return defaultVideoView(widthAfter);
  return current;
}

/** Desktop (1024 px and up) always shows compact with the chat rail, whatever was chosen. */
export function effectiveView(view: VideoView, width: number): VideoView {
  return width >= RAIL_MIN_WIDTH ? "compact" : view;
}

/** Hidden chrome only means something in immersive while someone is live; anywhere else the controls show. */
export function chromeHiddenFor(view: VideoView, isLive: boolean, hidden: boolean): boolean {
  return hidden && isLive && view === "immersive";
}

export const IMMERSIVE_HINT_KEY = "rooms.immersiveHint";
type HintStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** First time per browser: true, and remembers it. Storage that is missing or blocked never throws (the caller limits it to once per visit). */
export function shouldShowImmersiveHint(store: HintStore | null): boolean {
  try {
    if (!store) return true;
    if (store.getItem(IMMERSIVE_HINT_KEY)) return false;
  } catch { return true; }
  try { store.setItem(IMMERSIVE_HINT_KEY, "1"); } catch { /* private window or full storage: show it anyway */ }
  return true;
}

export interface NoticeInput {
  isHolder: boolean;
  holderLeftMs: number | null;
  videoPaused: boolean;
  weakLink: boolean;
  cameraOn: boolean;
  audioOnly: boolean;
}
export type ImmersiveNotice = "holder-reconnecting" | "video-paused" | "weak-link-holder" | "weak-link-viewer" | null;

/** Immersive has room for one banner over the picture: the most urgent one wins. Same conditions as the compact view. */
export function immersiveNotice(i: NoticeInput): ImmersiveNotice {
  if (i.isHolder) {
    if (i.holderLeftMs !== null) return "holder-reconnecting";
    if (i.videoPaused) return "video-paused";
    if (i.weakLink && i.cameraOn) return "weak-link-holder";
    return null;
  }
  return i.weakLink && !i.audioOnly ? "weak-link-viewer" : null;
}

const QUALITY_NAMES: Record<VideoProfile | "auto", string> = { auto: "Auto", saver: "Data saver", balanced: "Balanced", standard: "High" };

/** Short label for the quality button. Sound only wins because there is no picture to rate. */
export function qualityLabel(quality: VideoProfile | "auto", audioOnly: boolean): string {
  return audioOnly ? "Sound only" : QUALITY_NAMES[quality];
}

/** The immersive top bar's second line: "Dayo is live, 19 watching". */
export function liveMeta(holderName: string | null, watching: number): string {
  return `${holderName ? `${holderName} is live` : "Live"}, ${watching} watching`;
}

/** Who sits in the speaker strip: host, then co-hosts, then stage guests in the order they joined the stage. */
export function stripOrder<M extends { userId: string; role: string }>(members: M[], stage: string[]): M[] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const out: M[] = [...members.filter((m) => m.role === "host"), ...members.filter((m) => m.role === "cohost")];
  const seen = new Set(out.map((m) => m.userId));
  for (const id of stage) {
    const m = byId.get(id);
    if (m && !seen.has(id)) { out.push(m); seen.add(id); }
  }
  return out;
}
