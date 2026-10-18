// The room screen's width rule. Pure: no window, no React. Task 1.5 (live video views) imports VideoView and defaultVideoView.

/** At this width and wider the room uses the desktop layout: picture on the left, chat rail on the right, never immersive. */
export const RAIL_MIN_WIDTH = 1024;

/** How live video is shown: compact (picture on top, chat below or beside) or immersive (picture fills the frame). */
export type VideoView = "compact" | "immersive";

/** Phones and tablets (under 1024 px) open live video immersive; desktop opens it compact. */
export function defaultVideoView(width: number): VideoView {
  return width < RAIL_MIN_WIDTH ? "immersive" : "compact";
}

/** The frame layout for a viewport width and the room's scene. A voice room has no picture, so it is never immersive. */
export function layoutFor(width: number, scene: "voice" | "live"): { layout: "stack" | "rail"; immersiveDefault: boolean } {
  const layout = width < RAIL_MIN_WIDTH ? "stack" : "rail";
  return { layout, immersiveDefault: scene === "live" && defaultVideoView(width) === "immersive" };
}
