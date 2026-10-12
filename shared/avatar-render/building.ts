import { BUILDING_ACCENTS, validateBuildingConfig, type BuildingStyle } from "../building";
import { nextId } from "./shapes";

export interface BuildingOptions {
  /** Soft halo behind the building: verified venues (violet) and promoted listings (amber). */
  glow?: "verified" | "promoted";
  /** Hide from assistive tech when a text label sits next to it. */
  decorative?: boolean;
}

const O = "#1d1a26", W = "#5b5973", WS = "#47455c", LT = "#ffd98a", GRASS = "#46b080";

/** Flat, matte, outlined art for each style; `a` is the accent colour. Coordinates live in a 100x100 box. */
function art(style: BuildingStyle, a: string): string {
  const S = `stroke="${O}" stroke-width="2" stroke-linejoin="round"`;
  const win = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.2" fill="${LT}" ${S} stroke-width="1.2"/>`;
  switch (style) {
    case "club":
      return `<rect x="18" y="34" width="64" height="52" rx="3" fill="${W}" ${S}/><path d="M64 34 H82 V86 H64Z" fill="${WS}"/><rect x="18" y="34" width="64" height="9" rx="3" fill="${a}" ${S}/>
   <circle cx="50" cy="22" r="10" fill="${O}" stroke="${a}" stroke-width="2.6"/><path d="M45.5 18 L50 27 L54.5 18" stroke="${a}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
   ${win(24, 50, 10, 8)}${win(40, 50, 10, 8)}${win(56, 50, 10, 8)}${win(72, 50, 6, 8)}
   <path d="M40 86 V68 Q50 58 60 68 V86Z" fill="${O}"/><path d="M44 86 V70 Q50 63 56 70 V86Z" fill="${LT}" fill-opacity=".6"/>
   <path d="M78 34 L98 4 L102 14Z" fill="#fff" fill-opacity=".16"/>`;
    case "stadium":
      return `<ellipse cx="50" cy="62" rx="44" ry="20" fill="${WS}" ${S}/><ellipse cx="50" cy="56" rx="44" ry="20" fill="${W}" ${S}/>
   <ellipse cx="50" cy="56" rx="35" ry="14.5" fill="${a}" ${S} stroke-width="1.6"/><ellipse cx="50" cy="56" rx="29" ry="11" fill="${WS}" ${S} stroke-width="1.4"/>
   <ellipse cx="50" cy="56" rx="24" ry="8.5" fill="${GRASS}" ${S} stroke-width="1.4"/><path d="M50 47.5 V64.5 M38 56 H62" stroke="#fff" stroke-opacity=".6" stroke-width="1"/>
   ${[[10, 40], [90, 40], [22, 28], [78, 28]].map((p) => `<rect x="${p[0] - 1.2}" y="${p[1] - 14}" width="2.4" height="22" fill="#7c7a8e" stroke="${O}" stroke-width="1"/><rect x="${p[0] - 5}" y="${p[1] - 19}" width="10" height="6" rx="1.5" fill="${LT}" ${S} stroke-width="1.4"/>`).join("")}`;
    case "stage":
      return `<rect x="10" y="68" width="80" height="18" rx="2" fill="${W}" ${S}/><rect x="10" y="68" width="80" height="4" fill="${a}" ${S} stroke-width="1.4"/>
   <path d="M16 68 V22 Q50 6 84 22 V68" fill="none" stroke="${O}" stroke-width="7"/><path d="M16 68 V22 Q50 6 84 22 V68" fill="none" stroke="${a}" stroke-width="3.4"/>
   <rect x="26" y="30" width="48" height="30" rx="2" fill="${O}"/><rect x="28" y="32" width="44" height="26" rx="1.5" fill="${a}"/>
   <path d="M32 50 L40 42 L48 48 L58 36 L68 46" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
   <path d="M30 18 L22 66 L38 66Z M70 18 L62 66 L78 66Z" fill="#fff" fill-opacity=".14"/>
   ${[28, 50, 72].map((x) => `<circle cx="${x}" cy="16" r="3.4" fill="#fff" ${S} stroke-width="1.4"/>`).join("")}<rect x="12" y="55" width="9" height="13" rx="1.5" fill="${O}"/><rect x="79" y="55" width="9" height="13" rx="1.5" fill="${O}"/>`;
    case "bar":
      return `<rect x="20" y="36" width="60" height="50" rx="2" fill="${W}" ${S}/><path d="M66 36 H80 V86 H66Z" fill="${WS}"/>
   ${[0, 1, 2, 3, 4, 5].map((i) => `<path d="M${14 + i * 12} 38 L${22 + i * 9.33} 20 H${22 + (i + 1) * 9.33} L${14 + (i + 1) * 12} 38Z" fill="${i % 2 ? "#efe8da" : a}" ${S} stroke-width="1.4"/>`).join("")}
   <rect x="26" y="48" width="26" height="20" rx="2" fill="${LT}" ${S}/><path d="M39 48 V68 M26 58 H52" stroke="${O}" stroke-width="1.6"/>
   <rect x="58" y="50" width="16" height="36" rx="2" fill="${O}"/><circle cx="70" cy="68" r="1.4" fill="${LT}"/>
   <rect x="64" y="10" width="14" height="7" rx="1.5" fill="${a}" ${S} stroke-width="1.6"/>`;
    case "tent":
      return `<path d="M50 6 L12 52 H88Z" fill="#efe8da" ${S}/>
   ${[0, 2, 4].map((i) => `<path d="M50 6 L${12 + i * 15.2} 52 H${12 + (i + 1) * 15.2}Z" fill="${a}"/>`).join("")}<path d="M50 6 L12 52 H88Z" fill="none" ${S}/>
   <rect x="16" y="52" width="68" height="32" fill="${W}" ${S}/><path d="M12 52 Q20 58 28 52 Q36 58 44 52 Q52 58 60 52 Q68 58 76 52 Q82 58 88 52 V56 H12Z" fill="${a}" ${S} stroke-width="1.6"/>
   <path d="M40 84 V64 Q50 54 60 64 V84Z" fill="${O}"/><path d="M44 84 V66 Q50 59 56 66 V84Z" fill="${LT}" fill-opacity=".6"/>
   <path d="M50 6 V-6 L62 -2 L50 2Z" fill="${LT}" ${S} stroke-width="1.4"/>`;
    case "rooftop":
      return `<rect x="20" y="42" width="60" height="44" rx="2" fill="${W}" ${S}/><path d="M68 42 H80 V86 H68Z" fill="${WS}"/><rect x="16" y="38" width="68" height="7" rx="2" fill="#7c7a8e" ${S}/>
   <path d="M20 38 V22 M80 38 V22 M20 24 H80" stroke="${O}" stroke-width="3.4" fill="none"/><path d="M20 38 V22 M80 38 V22 M20 24 H80" stroke="#a8a6ba" stroke-width="1.4" fill="none"/>
   ${[24, 34, 44, 54, 64, 74].map((x) => `<circle cx="${x}" cy="28" r="2.4" fill="${LT}" ${S} stroke-width="1"/>`).join("")}
   <path d="M52 26 Q62 12 72 26Z" fill="${a}" ${S} stroke-width="1.6"/><rect x="61.2" y="26" width="1.8" height="12" fill="${O}"/>
   <rect x="28" y="33" width="18" height="5" rx="2.5" fill="#4cc3ea" ${S} stroke-width="1.2"/>
   ${win(26, 52, 9, 8)}${win(40, 52, 9, 8)}${win(54, 52, 9, 8)}${win(26, 66, 9, 8)}${win(54, 66, 9, 8)}<rect x="40" y="64" width="9" height="22" rx="1.5" fill="${O}"/>`;
  }
}

/**
 * Renders a building config to an svg string. Input is validated first, so junk renders "" (callers fall back to a
 * plain marker) and the output only contains fixed enums, palette colours and numbers.
 */
export function buildingSvg(input: unknown, opts: BuildingOptions = {}): string {
  const v = validateBuildingConfig(input);
  if (!v.ok) return "";
  const { style, accent } = v.value;
  const a = BUILDING_ACCENTS[accent];
  const id = nextId("g");
  const glowColor = opts.glow === "promoted" ? "#f59e0b" : "#9b6fef";
  const halo = opts.glow
    ? `<defs><radialGradient id="${id}"><stop offset="0" stop-color="${glowColor}" stop-opacity=".75"/><stop offset=".6" stop-color="${glowColor}" stop-opacity=".25"/><stop offset="1" stop-color="${glowColor}" stop-opacity="0"/></radialGradient></defs><circle cx="50" cy="46" r="58" fill="url(#${id})"/>`
    : "";
  const a11y = opts.decorative ? `aria-hidden="true"` : `role="img" aria-label="${style} building"`;
  // Wider viewBox than the 100x100 art so the halo and the club's searchlight are not clipped.
  return `<svg viewBox="-10 -14 120 112" xmlns="http://www.w3.org/2000/svg" ${a11y}>${halo}<ellipse cx="50" cy="86" rx="40" ry="6" fill="#000" fill-opacity=".28"/>${art(style, a)}</svg>`;
}
