import type { AvatarConfig, AvatarType } from "../avatar";

export const OUTLINE = "#1d1220";
export const SKINS = ["#fbdcc4", "#f3c39d", "#e4a877", "#cd8a58", "#a96a3f", "#85502e", "#63381f", "#42261a"] as const;
export const HAIR_COLORS = ["#1b1412", "#46291a", "#7a4a28", "#b07a3a", "#e0bb6c", "#c04a2c", "#6a45b8", "#d9d6de"] as const;
export const OUTFIT_COLORS = ["#7c46d6", "#f2a31f", "#1f9a74", "#e0567a", "#3a74e0", "#2e2e38", "#ece5d6", "#17171d"] as const;

/** Per body type proportions. jw/cw: jaw and chin half-widths. sw: shoulder half-width. nw: neck half-width. */
export interface Body { jw: number; cw: number; chin: number; nw: number; sw: number; th: number; arch: number; lash: boolean; blush: number; lip: boolean }
export const BODY: Record<AvatarType, Body> = {
  female: { jw: 25, cw: 10, chin: 139, nw: 10, sw: 50, th: 2.2, arch: 3.4, lash: true, blush: 0.38, lip: true },
  male: { jw: 33, cw: 21, chin: 136, nw: 16, sw: 68, th: 4.2, arch: 0.4, lash: false, blush: 0.14, lip: false },
  neutral: { jw: 29, cw: 14, chin: 138, nw: 13, sw: 58, th: 3, arch: 1.6, lash: false, blush: 0.24, lip: false },
};

/** Brow offsets: i = inner end, o = outer end, r = whole brow raise. ry = eye openness. */
interface Brow { r: number; i: number; o: number }
export interface Expr { ry: number; wink?: -1 | 1; bl: Brow; br: Brow; m: "smile" | "grin" | "smirk" | "frown" | "scowl" | "flat" | "o" }
export const EXPR: Record<AvatarConfig["expression"], Expr> = {
  smile: { ry: 6.2, bl: { r: 0, i: 0, o: 0 }, br: { r: 0, i: 0, o: 0 }, m: "smile" },
  grin: { ry: 5.4, bl: { r: -1, i: 0, o: 0 }, br: { r: -1, i: 0, o: 0 }, m: "grin" },
  smirk: { ry: 5.8, bl: { r: -3, i: 0, o: -1 }, br: { r: 0, i: 1, o: 1 }, m: "smirk" },
  wink: { ry: 6.2, wink: 1, bl: { r: 0, i: 0, o: 0 }, br: { r: -2, i: 0, o: 0 }, m: "smile" },
  neutral: { ry: 6.2, bl: { r: 0, i: 0, o: 0 }, br: { r: 0, i: 0, o: 0 }, m: "flat" },
  frown: { ry: 6.2, bl: { r: 0, i: -3.5, o: 1.5 }, br: { r: 0, i: -3.5, o: 1.5 }, m: "frown" },
  scowl: { ry: 4.4, bl: { r: 1, i: 4, o: -1.5 }, br: { r: 1, i: 4, o: -1.5 }, m: "scowl" },
  surprised: { ry: 7.2, bl: { r: -5, i: 0, o: 0 }, br: { r: -5, i: 0, o: 0 }, m: "o" },
};

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** Blend two #rrggbb colours: t=0 is a, t=1 is b. */
export function mix(a: string, b: string, t: number): string {
  const A = hex(a), B = hex(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
