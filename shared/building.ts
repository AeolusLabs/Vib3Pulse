// Building avatars for venues and events: what an organizer may set, plus category-based defaults so every
// existing venue and event already has a sensible building before anyone customizes it.

export const BUILDING_STYLES = ["club", "bar", "stadium", "stage", "tent", "rooftop"] as const;
export type BuildingStyle = (typeof BUILDING_STYLES)[number];

/** Accent colours (index 0..7). Shared by the renderer and the picker. */
export const BUILDING_ACCENTS = ["#a07df2", "#e0567a", "#1f9a74", "#f2a31f", "#3a74e0", "#46c2e8", "#ef6c3a", "#ece5d6"] as const;

export interface BuildingConfig { v: 1; style: BuildingStyle; accent: number }
export type BuildingValidation = { ok: true; value: BuildingConfig } | { ok: false; field: string };

const isStyle = (v: unknown): v is BuildingStyle => typeof v === "string" && (BUILDING_STYLES as readonly string[]).includes(v);
const isAccent = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < BUILDING_ACCENTS.length;

/** Strict check for incoming API bodies; names the first failing field. Unknown keys are dropped, v is forced to 1. */
export function validateBuildingConfig(input: unknown): BuildingValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, field: "building" };
  const i = input as Record<string, unknown>;
  if (!isStyle(i.style)) return { ok: false, field: "style" };
  if (!isAccent(i.accent)) return { ok: false, field: "accent" };
  return { ok: true, value: { v: 1, style: i.style, accent: i.accent } };
}

const VENUE_DEFAULTS: Record<string, BuildingStyle> = { Club: "club", Nightclub: "club", Pub: "bar", Lounge: "bar", Bar: "bar", Rooftop: "rooftop" };
const EVENT_DEFAULTS: Record<string, BuildingStyle> = {
  Music: "stage", Theatre: "stage", Arts: "stage", Entertainment: "stage", Sports: "stadium",
  "Food & Drink": "tent", Community: "tent", Wellness: "tent", Tech: "rooftop", Business: "rooftop", Education: "rooftop",
};

export function defaultBuildingStyle(kind: "venue" | "event", category: string | null | undefined): BuildingStyle {
  const table = kind === "venue" ? VENUE_DEFAULTS : EVENT_DEFAULTS;
  return (category && Object.prototype.hasOwnProperty.call(table, category) ? table[category] : undefined) ?? (kind === "venue" ? "club" : "tent");
}

/** What to draw: the stored building when it is valid, otherwise the category default in the first accent. Never throws. */
export function resolveBuilding(kind: "venue" | "event", category: string | null | undefined, stored: unknown): BuildingConfig {
  const v = validateBuildingConfig(stored);
  return v.ok ? v.value : { v: 1, style: defaultBuildingStyle(kind, category), accent: 0 };
}
