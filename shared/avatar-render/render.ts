import { sanitizeAvatarConfig } from "../avatar";
import { OUTFIT_COLORS, OUTLINE, mix } from "./palette";
import { makeCtx, nextId } from "./shapes";
import { hairLayers } from "./hair";
import { clothing } from "./clothing";
import { blush, brows, ears, eyes, facialHair, faceShape, mouth, neck, nose } from "./face";
import { extras } from "./extras";

export type AvatarMode = "full" | "bust" | "head" | "face" | "outfit" | "lower";

const VIEWBOX: Record<AvatarMode, string> = {
  full: "10 -8 180 288", // starts above y=0: the mohawk tip reaches y=-2
  bust: "20 96 160 190",
  head: "40 -2 120 140", // whole hairstyle, for hair pickers
  face: "50 36 100 108",
  outfit: "20 110 160 150", // shoulders and torso, for outfit pickers
  lower: "50 56 100 118", // nose to full-beard tip, for facial-hair pickers
};

/**
 * Renders any avatar config to an svg string. Input is sanitized first, so garbage renders as "" (the caller
 * falls back to a photo or initial) and the output only ever contains values from fixed enums and numbers.
 */
export function avatarSvg(input: unknown, mode: AvatarMode = "full", opts: { decorative?: boolean } = {}): string {
  const config = sanitizeAvatarConfig(input);
  if (!config) return "";
  return buildSvg(config, VIEWBOX[mode], !!opts.decorative);
}

function body(config: NonNullable<ReturnType<typeof sanitizeAvatarConfig>>): string {
  const x = makeCtx(config);
  const hair = hairLayers(x);
  const dress = clothing(x);
  const ex = extras(x);
  return `<defs><clipPath id="${x.fid}"><path d="${x.facePath}"/></clipPath></defs>
  <g class="avatar-breathe">
   ${hair.back}${dress.hoodBack}${neck(x)}${dress.outfit}${hair.locks}${ears(x)}${ex.hoops}
   ${faceShape(x)}
   ${blush(x)}${eyes(x)}${brows(x)}${nose(x)}${facialHair(x)}${mouth(x)}
   ${hair.front}${ex.head}${ex.eyewear}
  </g>`;
}

function buildSvg(config: NonNullable<ReturnType<typeof sanitizeAvatarConfig>>, viewBox: string, decorative: boolean): string {
  // Decorative uses (picker tiles sitting next to a text label) are hidden from screen readers.
  const a11y = decorative ? `aria-hidden="true"` : `role="img" aria-label="${config.type} avatar"`;
  return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" ${a11y} overflow="hidden">${body(config)}</svg>`;
}

/** Round map-pin badge: head and shoulders in a circle on a soft colour, with a small tail. Callers label the marker (title) themselves. */
export function avatarPinSvg(input: unknown, aura?: string): string {
  const config = sanitizeAvatarConfig(input);
  if (!config) return "";
  const u = nextId("p");
  const bg = mix(aura ?? OUTFIT_COLORS[config.outfitColor], "#ffffff", 0.3);
  return `<svg viewBox="0 0 64 78" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><clipPath id="${u}c"><circle cx="32" cy="32" r="26.5"/></clipPath></defs>
  <path d="M23 56 L32 74 L41 56Z" fill="#fff" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="32" cy="32" r="30" fill="#fff" stroke="${OUTLINE}" stroke-width="2"/>
  <g clip-path="url(#${u}c)"><rect x="0" y="0" width="64" height="64" fill="${bg}"/>
  <svg x="4" y="2" width="56" height="63" viewBox="40 22 120 135" preserveAspectRatio="xMidYMid slice">${body(config)}</svg></g>
  <circle cx="32" cy="32" r="26.5" fill="none" stroke="${OUTLINE}" stroke-width="1.6"/></svg>`;
}

/**
 * Square head-and-shoulders picture for use as a profile image (an <img src> served by /api/avatar-img).
 * A solid background fills the square so a round crop never shows transparent corners.
 */
export function avatarPictureSvg(input: unknown): string {
  const config = sanitizeAvatarConfig(input);
  if (!config) return "";
  const bg = mix(OUTFIT_COLORS[config.outfitColor], "#ffffff", 0.3);
  return `<svg viewBox="32.5 22 135 135" xmlns="http://www.w3.org/2000/svg"><rect x="32.5" y="22" width="135" height="135" fill="${bg}"/>${body(config)}</svg>`;
}
