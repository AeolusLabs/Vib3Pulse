// Spray artwork colours. These are brand artwork, identical in light and dark themes, so they live here and
// not in CSS variables (the canvas draws them directly). Ported from the notes.html prototype palette.
// The art is an abstract game token: no currency sign, no denomination, no banknote features.

export interface NotePalette {
  /** gradient start */ a: string;
  /** gradient end */ b: string;
  /** wave and rosette lines */ line: string;
  /** "V3" mark on the centre disc */ tx: string;
  /** centre disc fill */ ink: string;
}

/** Three colourways of the one note design, used for variety in pours and rain. Index is the note "variant". */
export const NOTE_PALETTES: readonly NotePalette[] = [
  { a: "#5b2fb8", b: "#8a5ce6", line: "#e3d6ff", tx: "#efe6ff", ink: "#1b0f3a" }, // pulse (violet)
  { a: "#0f0c1a", b: "#2c2257", line: "#9b78f0", tx: "#1b1530", ink: "#f4f2f7" }, // midnight
  { a: "#a8480a", b: "#f5b83d", line: "#3a2204", tx: "#f5b83d", ink: "#2a1802" }, // gold (amber is for money moments)
] as const;

export type NoteVariant = 0 | 1 | 2;

export const SPRAY_TOKENS = {
  amber: "#f5b83d",
  violet: "#8a5ce6",
  violetDeep: "#5b2fb8",
  violetLine: "#e3d6ff",
  midnight: "#0f0c1a",
  midnight2: "#2c2257",
  midnightLine: "#9b78f0",
  band: "#1b1530",
  sheenA: "#fbefc4",
  sheenB: "#c4b4ff",
  outline: "#0d0a1a",
  bagShadow: "#0a0716",
  bagMouth: "#07050d",
  white: "#ffffff",
  /** light beams during rain, as an rgb triple so alpha can vary */
  beamRgb: "245,184,61",
  font: "Jost, system-ui, sans-serif",
} as const;
