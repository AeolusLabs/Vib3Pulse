import type { AvatarConfig } from "../avatar";
import { BODY, EXPR, HAIR_COLORS, OUTFIT_COLORS, OUTLINE, SKINS, mix, type Body, type Expr } from "./palette";

// Every id in an svg is document-global, so each render takes a fresh prefix. 30 pins on one map never collide.
let uid = 0;
// The vpav- prefix keeps these from ever clashing with ids elsewhere on the page.
export const nextId = (prefix: string) => `vpav-${prefix}${++uid}`;

/** Everything the layer builders need, computed once per render from a sanitized config. */
export interface Ctx {
  c: AvatarConfig;
  B: Body;
  E: Expr;
  fid: string; // id of the face clipPath
  skin: string; skSh: string; skOut: string;
  hc: string; hSh: string; hOut: string;
  oc: string; oSh: string; oOut: string; oLt: string;
  ow: number; // outline width
  jw: number; cw: number; chin: number; nw: number; sw: number;
  L: number; R: number; // torso left / right x
  capOn: boolean; // cap or beanie: hides the front hair
  facePath: string;
}

export function makeCtx(c: AvatarConfig): Ctx {
  const B = BODY[c.type];
  const skin = SKINS[c.skin], hc = HAIR_COLORS[c.hairColor], oc = OUTFIT_COLORS[c.outfitColor];
  const { jw, cw, chin, nw, sw } = B;
  const facePath = `M64 86 C64 62 80 50 100 50 C120 50 136 62 136 86 C136 102 ${100 + jw + 6} 112 ${100 + jw} 122 C${100 + jw - 3} ${chin - 8} ${100 + cw + 4} ${chin} 100 ${chin} C${100 - cw - 4} ${chin} ${100 - jw + 3} ${chin - 8} ${100 - jw} 122 C${100 - jw - 6} 112 64 102 64 86Z`;
  return {
    c, B, E: EXPR[c.expression], fid: nextId("f"),
    skin, skSh: mix(skin, "#6a2a1a", 0.2), skOut: mix(skin, OUTLINE, 0.6),
    hc, hSh: mix(hc, "#1a0a24", 0.3), hOut: mix(hc, OUTLINE, 0.65),
    oc, oSh: mix(oc, "#1a0a30", 0.3), oOut: mix(oc, OUTLINE, 0.65), oLt: mix(oc, "#fff", 0.22),
    ow: 2.2, jw, cw, chin, nw, sw, L: 100 - sw, R: 100 + sw,
    capOn: c.headwear === "cap" || c.headwear === "beanie",
    facePath,
  };
}

/** Add attributes to a self-closing shape string. */
const withAttrs = (s: string, a: string) => s.replace(/\/>$/, " " + a + "/>");

/**
 * Flat cel-shaded shape set: an outline pass, a shade tone, the light tone offset up-left, then optional
 * `extra` details clipped to the shape. Shapes are self-closing svg strings (see P, C, R below).
 */
export function cel(shapes: string[], fill: string, shade: string, stroke: string, sw: number, extra = "", dx = -4, dy = -5): string {
  const id = nextId("k");
  const clip = `<clipPath id="${id}">${shapes.join("")}</clipPath>`;
  const outline = sw ? shapes.map((s) => withAttrs(s, `fill="${stroke}" stroke="${stroke}" stroke-width="${sw * 2}" stroke-linejoin="round" stroke-linecap="round"`)).join("") : "";
  const base = shapes.map((s) => withAttrs(s, `fill="${shade}"`)).join("");
  const light = shapes.map((s) => withAttrs(s, `fill="${fill}"`)).join("");
  return `${clip}${outline}${base}<g clip-path="url(#${id})"><g transform="translate(${dx} ${dy})">${light}</g>${extra}</g>`;
}

export const P = (d: string) => `<path d="${d}"/>`;
export const PE = (d: string) => `<path d="${d}" fill-rule="evenodd" clip-rule="evenodd"/>`;
export const C = (x: number, y: number, r: number) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
export const R = (x: number, y: number, w: number, h: number, r = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
/** Rect mirrored across x=100. */
export const Rm = (x: number, y: number, w: number, h: number, r = 0) => R(200 - x - w, y, w, h, r);
/** Mirror an absolute "x y" pair path across x=100 (no H/V/arc commands). */
export const mir = (d: string) => d.replace(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g, (_m, x, y) => `${+(200 - Number(x)).toFixed(2)} ${y}`);
