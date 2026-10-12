import { P, R, cel, type Ctx } from "./shapes";
import { OUTLINE, mix } from "./palette";
import { EY } from "./face";

export interface ExtraLayers { head: string; eyewear: string; hoops: string }

const EX = 16;

export function extras(x: Ctx): ExtraLayers {
  const { c, oc, oSh, oOut, oLt, ow } = x;
  let head = "", eyewear = "", hoops = "";

  if (c.headwear === "cap") {
    head = cel([P("M60 84 C56 44 80 28 100 28 C120 28 144 44 140 84 C128 76 72 76 60 84Z")], oc, oSh, oOut, ow, `<path d="M100 28 V80" stroke="${oOut}" stroke-width="1.5" stroke-opacity=".5"/>`, -3, -4) +
      cel([P("M50 80 C78 70 122 70 150 80 C152 85 128 87 100 87 C72 87 48 85 50 80Z")], oSh, mix(oSh, "#000", 0.25), oOut, ow, "", -1, -2);
  }
  if (c.headwear === "beanie") {
    head = cel([P("M60 76 C54 36 80 20 100 20 C120 20 146 36 140 76Z")], oc, oSh, oOut, ow, `<path d="M80 24 V70 M100 20 V70 M120 24 V70" stroke="${oOut}" stroke-width="1.4" stroke-opacity=".28"/>`, -3, -4) +
      cel([P("M58 66 Q100 58 142 66 V82 Q100 74 58 82Z")], oLt, oSh, oOut, ow, "", -2, -3) +
      `<circle cx="100" cy="17" r="6" fill="${oc}" stroke="${oOut}" stroke-width="2"/>`;
  }
  if (c.headwear === "headphones") {
    head = `<path d="M57 100 C50 34 150 34 143 100" stroke="${OUTLINE}" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M57 100 C50 34 150 34 143 100" stroke="#3a3946" stroke-width="5" fill="none" stroke-linecap="round"/>` +
      cel([R(47, 88, 19, 36, 9.5), R(134, 88, 19, 36, 9.5)], "#3a3946", "#26252f", OUTLINE, ow) +
      `<rect x="52" y="97" width="9" height="18" rx="4.5" fill="${oc}"/><rect x="139" y="97" width="9" height="18" rx="4.5" fill="${oc}"/>`;
  }

  if (c.eyewear === "round") {
    eyewear = `<g fill="#bcd4ff" fill-opacity=".14" stroke="${OUTLINE}" stroke-width="2.6"><circle cx="${100 - EX}" cy="${EY}" r="11.6"/><circle cx="${100 + EX}" cy="${EY}" r="11.6"/></g>` +
      `<path d="M${100 - EX + 11.6} ${EY - 1} Q100 ${EY - 5} ${100 + EX - 11.6} ${EY - 1} M${100 - EX - 11.6} ${EY - 1} L65 ${EY - 3} M${100 + EX + 11.6} ${EY - 1} L135 ${EY - 3}" stroke="${OUTLINE}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
  }
  if (c.eyewear === "shades") {
    const lens = (cx: number) => `<path d="M${cx - 14} ${EY - 8} H${cx + 14} Q${cx + 15} ${EY - 8} ${cx + 15} ${EY - 6} V${EY + 4} Q${cx + 15} ${EY + 11} ${cx + 7} ${EY + 11} H${cx - 7} Q${cx - 15} ${EY + 11} ${cx - 15} ${EY + 4} V${EY - 6} Q${cx - 15} ${EY - 8} ${cx - 14} ${EY - 8}Z" fill="#23222c" stroke="${OUTLINE}" stroke-width="2"/><path d="M${cx - 9} ${EY - 4} L${cx - 1} ${EY - 4} L${cx - 9} ${EY + 5}Z" fill="#fff" fill-opacity=".2"/>`;
    eyewear = lens(100 - EX) + lens(100 + EX) +
      `<path d="M${100 - EX + 15} ${EY - 4} H${100 + EX - 15} M${100 - EX - 15} ${EY - 4} L63 ${EY - 6} M${100 + EX + 15} ${EY - 4} L137 ${EY - 6}" stroke="${OUTLINE}" stroke-width="2.6" stroke-linecap="round"/>`;
  }

  if (c.hoops) {
    const ring = (cx: number) => `<circle cx="${cx}" cy="110" r="5.4" fill="none" stroke="${OUTLINE}" stroke-width="4.4"/><circle cx="${cx}" cy="110" r="5.4" fill="none" stroke="#f0b13a" stroke-width="2"/>`;
    hoops = ring(64) + ring(136);
  }
  return { head, eyewear, hoops };
}
