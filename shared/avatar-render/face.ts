import { P, PE, cel, type Ctx } from "./shapes";
import { OUTLINE, mix } from "./palette";

const EX = 16; // eye x offset from the centre line
export const EY = 99; // eye y
const BY = 88; // brow y

export function eyes(x: Ctx): string {
  const { B, E, fid } = x;
  const eye = (s: -1 | 1) => {
    const cx = 100 + s * EX, id = `${fid}e${s < 0 ? "l" : "r"}`;
    const flick = B.lash ? `<path d="M${cx + s * 6.6} ${EY - 1.2} l${s * 3} -2.4" stroke="${OUTLINE}" stroke-width="1.8" stroke-linecap="round"/>` : "";
    if (E.wink === s) return `<path d="M${cx - 6.4} ${EY + 0.4} Q${cx} ${EY - 5} ${cx + 6.4} ${EY + 0.4}" stroke="${OUTLINE}" stroke-width="2.8" fill="none" stroke-linecap="round"/>${flick}`;
    const ry = E.ry;
    return `<clipPath id="${id}"><ellipse cx="${cx}" cy="${EY}" rx="5.8" ry="${ry}"/></clipPath>
    <ellipse cx="${cx}" cy="${EY}" rx="5.8" ry="${ry}" fill="#fff"/>
    <g clip-path="url(#${id})"><circle cx="${cx}" cy="${EY + 0.6}" r="4" fill="#3a2418"/><circle cx="${cx}" cy="${EY + 0.6}" r="1.9" fill="#120a08"/><circle cx="${cx + 1.5}" cy="${EY - 1}" r="1.3" fill="#fff"/></g>
    <ellipse cx="${cx}" cy="${EY}" rx="5.8" ry="${ry}" fill="none" stroke="${OUTLINE}" stroke-width="1.5"/>
    <path d="M${cx - 6.4} ${EY - 1.2} Q${cx} ${EY - ry - 0.9} ${cx + 6.4} ${EY - 1.2}" stroke="${OUTLINE}" stroke-width="${B.lash ? 2.6 : 2}" fill="none" stroke-linecap="round"/>${flick}`;
  };
  return `<g class="avatar-blink">${eye(-1)}${eye(1)}</g>`;
}

export function brows(x: Ctx): string {
  const { B, E, hc } = x;
  const brow = (s: -1 | 1) => {
    const cx = 100 + s * EX, b = s < 0 ? E.bl : E.br;
    return `<path d="M${cx - s * 10} ${BY + 2.4 + b.r + b.i} Q${cx - s} ${BY - B.arch + b.r} ${cx + s * 9} ${BY + 1.4 + b.r + b.o}" stroke="${mix(hc, "#000", 0.2)}" stroke-width="${B.th}" fill="none" stroke-linecap="round"/>`;
  };
  return brow(-1) + brow(1);
}

export function nose(x: Ctx): string {
  return `<path d="M97 108 Q99.5 113 104 111.4" stroke="${x.skOut}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
}

export function blush(x: Ctx): string {
  return `<ellipse cx="74" cy="113" rx="8" ry="4.6" fill="#e5546f" fill-opacity="${x.B.blush}"/><ellipse cx="126" cy="113" rx="8" ry="4.6" fill="#e5546f" fill-opacity="${x.B.blush}"/>`;
}

export function mouth(x: Ctx): string {
  const { B, E, skin } = x;
  const lipC = mix(skin, "#b0334e", 0.55);
  const ln = (d: string, w = 2.2) => `<path d="${d}" stroke="${OUTLINE}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  const tint = (d: string) => (B.lip ? `<path d="${d}" stroke="${lipC}" stroke-width="4.2" fill="none" stroke-linecap="round"/>` : "");
  switch (E.m) {
    case "smile": return tint("M91 123.5 Q100 131 109 123.5") + ln("M91 123.5 Q100 131 109 123.5") + ln("M89.6 122.6 l-1.2 -1.6 M110.4 122.6 l1.2 -1.6", 1.4);
    case "grin": return `<path d="M88 121.5 Q100 126 112 121.5 Q111 135.5 100 135.5 Q89 135.5 88 121.5Z" fill="#5a1f2c" stroke="${OUTLINE}" stroke-width="1.8" stroke-linejoin="round"/><path d="M89.8 123 Q100 127 110.2 123 Q109.6 128 100 128.8 Q90.4 128 89.8 123Z" fill="#fff"/><ellipse cx="100" cy="133.4" rx="5.4" ry="2.2" fill="#e0647a"/>${B.lip ? `<path d="M88 121.5 Q100 126 112 121.5" stroke="${lipC}" stroke-width="2.4" fill="none" stroke-linecap="round"/>` : ""}`;
    case "smirk": return tint("M92 126 Q101 128.4 110.6 120.6") + ln("M92 126 Q101 128.4 110.6 120.6") + ln("M111.8 119.4 l1.4 -1.4", 1.4);
    case "frown": return tint("M91 129.5 Q100 121.5 109 129.5") + ln("M91 129.5 Q100 121.5 109 129.5");
    case "scowl": return `<rect x="90.5" y="122.6" width="19" height="8" rx="3" fill="#fff" stroke="${OUTLINE}" stroke-width="1.8"/><path d="M96.8 122.6 V130.6 M103.2 122.6 V130.6 M90.5 126.6 H109.5" stroke="${OUTLINE}" stroke-width="1.1"/>${ln("M89 131.4 l-1.6 1.6 M111 131.4 l1.6 1.6", 1.4)}`;
    case "flat": return tint("M93 126 H107") + ln("M93 126 H107");
    case "o": return `<ellipse cx="100" cy="128" rx="5.2" ry="6.6" fill="#5a1f2c" stroke="${OUTLINE}" stroke-width="1.8"/><ellipse cx="100" cy="131.6" rx="3" ry="1.8" fill="#e0647a"/>`;
  }
}

/** Facial hair is only drawn for male and neutral bodies; the sanitizer already forces female to "none". */
export function facialHair(x: Ctx): string {
  const { c, hc, hSh, hOut, ow, fid } = x;
  if (c.type === "female" || c.facial === "none") return "";
  const must = "M86 117 Q93 112 100 116 Q107 112 114 117 Q108 123 100 119 Q92 123 86 117Z";
  const hole = "M86 125 a14 9 0 1 0 28 0 a14 9 0 1 0 -28 0Z";
  const mustache = () => cel([P(must)], hc, hSh, hOut, 1.6, "", -2, -2);
  switch (c.facial) {
    case "stubble": return `<g clip-path="url(#${fid})"><path d="M60 100 C58 130 72 156 100 156 C128 156 142 130 140 100 C134 114 124 114 118 116 C112 118 88 118 82 116 C76 114 66 114 60 100Z" fill="${hc}" fill-opacity=".3"/></g>`;
    case "mustache": return mustache();
    case "goatee": return cel([P("M89 133 Q100 129 111 133 Q110 150 100 152 Q90 150 89 133Z")], hc, hSh, hOut, 1.8, "", -2, -3) + mustache();
    case "beard": return cel([PE(`M63 106 C61 130 72 154 100 154 C128 154 139 130 137 106 C132 114 124 114 118 116 C112 118 88 118 82 116 C76 114 68 114 63 106Z ${hole}`)], hc, hSh, hOut, ow, "", -3, -4);
    case "full": return cel([PE(`M61 104 C56 134 70 168 100 170 C130 168 144 134 139 104 C132 114 124 114 118 116 C112 118 88 118 82 116 C76 114 68 114 61 104Z ${hole}`)], hc, hSh, hOut, ow,
      `<path d="M76 140 C84 158 94 162 100 162 M124 140 C116 158 106 162 100 162" fill="none" stroke="${hOut}" stroke-width="1.5" stroke-opacity=".5" stroke-linecap="round"/>`, -3, -4) + mustache();
    default: return "";
  }
}

export function ears(x: Ctx): string {
  const { skin, skSh, skOut, ow } = x;
  return cel([`<ellipse cx="64" cy="98" rx="6.4" ry="9.6"/>`, `<ellipse cx="136" cy="98" rx="6.4" ry="9.6"/>`], skin, skSh, skOut, ow, "", -1, -2) +
    `<path d="M64.5 93 Q62 98 64.5 103 M135.5 93 Q138 98 135.5 103" stroke="${skOut}" stroke-width="1.4" fill="none" stroke-opacity=".6"/>`;
}

export function neck(x: Ctx): string {
  const { nw, skin, skSh, skOut, ow } = x;
  const d = `M${100 - nw} 112 V156 Q100 166 ${100 + nw} 156 V112Z`;
  return cel([P(d)], skin, skSh, skOut, ow, `<ellipse cx="100" cy="128" rx="${nw + 8}" ry="13" fill="${mix(skSh, "#3a1208", 0.28)}"/>`, 0, 0);
}

export function faceShape(x: Ctx): string {
  return cel([P(x.facePath)], x.skin, x.skSh, x.skOut, x.ow, "", -4, -5);
}
