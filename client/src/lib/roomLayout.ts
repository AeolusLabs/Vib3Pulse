// Owned by task 1.2; identical interface. This stub exists only so task 1.5 builds on its own branch.
// At merge, take task 1.2's file.

export const RAIL_MIN_WIDTH = 1024;

export type VideoView = "compact" | "immersive";

/** Phones and tablets (under 1024 px) open live video immersive; desktop uses compact with a chat rail. */
export function defaultVideoView(width: number): VideoView {
  return width < RAIL_MIN_WIDTH ? "immersive" : "compact";
}

export function layoutFor(width: number, scene: "voice" | "live"): { layout: "stack" | "rail"; immersiveDefault: boolean } {
  const rail = width >= RAIL_MIN_WIDTH;
  return { layout: rail ? "rail" : "stack", immersiveDefault: scene === "live" && !rail };
}
