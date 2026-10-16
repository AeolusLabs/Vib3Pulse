// Where the map picture comes from, and how we notice it is not arriving. Pure so it can be tested; MapPage does the browser work.
//
// Primary: OpenFreeMap vector tiles (free, commercial use allowed, no key), drawn by MapLibre inside the Leaflet map. Backup:
// OpenStreetMap-style picture tiles, used when the phone cannot draw vector maps (no WebGL) or the vector source keeps failing.

export interface TileHealth { errors: number; loads: number }
export type TileVerdict = "ok" | "struggling" | "failed";
export type BaseKind = "vector" | "raster";

export const tileHealth = (s: TileHealth, event: "error" | "load"): TileHealth =>
  event === "error" ? { ...s, errors: s.errors + 1 } : { ...s, loads: s.loads + 1 };

/** Judged only after a handful of events: one slow tile on a weak link is normal. */
export function tileVerdict(s: TileHealth): TileVerdict {
  if (s.errors >= 6 && s.loads === 0) return "failed";
  if (s.errors + s.loads >= 6 && s.errors >= 2 * s.loads) return "struggling";
  return "ok";
}

/** The whole source failed (for a vector map: its style file would not load, so no tile is even asked for): judged failed at once. */
export const tileFatal = (s: TileHealth): TileHealth => ({ ...s, errors: Math.max(s.errors, 6) });

/**
 * A source that neither delivers nor errors (a connection that just hangs) must not leave a silent grey map. With no tile at all,
 * call it slow after 15 s and failed after 45 s; once anything has loaded the normal verdict takes over.
 */
export function tileWatchdog(s: TileHealth, elapsedMs: number): "struggling" | "failed" | null {
  if (s.loads > 0) return null;
  if (elapsedMs >= 45_000) return "failed";
  return elapsedMs >= 15_000 ? "struggling" : null;
}

/** Vector first (smaller downloads, real dark style) when the phone can draw it; otherwise the picture tiles only. */
export const baseOrder = (webgl: boolean): BaseKind[] => (webgl ? ["vector", "raster"] : ["raster"]);

export const DEFAULT_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

/** The style for the current theme; build-time env values (VITE_MAP_STYLE_LIGHT / _DARK) win. */
export function styleUrl(dark: boolean, env: { light?: string; dark?: string }): string {
  return (dark ? env.dark : env.light) || (dark ? DEFAULT_STYLES.dark : DEFAULT_STYLES.light);
}
