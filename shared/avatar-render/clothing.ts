import { P, cel, type Ctx } from "./shapes";
import { mix } from "./palette";

export interface ClothingLayers { hoodBack: string; outfit: string }

/** Torso silhouette: shoulders slope into a neck opening at y=152. Every outfit is cut from it. */
function torsoPath(x: Ctx): string {
  const { L, R, nw } = x;
  return `M${L} 296 V208 C${L} 184 ${L + 6} 172 ${L + 22} 166 L${100 - nw - 8} 157 Q${100 - nw - 3} 153 ${100 - nw} 152 H${100 + nw} Q${100 + nw + 3} 153 ${100 + nw + 8} 157 L${R - 22} 166 C${R - 6} 172 ${R} 184 ${R} 208 V296Z`;
}

export function clothing(x: Ctx): ClothingLayers {
  const { c, L, R, nw, sw, skin, skSh, skOut, oc, oSh, oOut, ow } = x;
  const torso = torsoPath(x);
  const skinTorso = cel([P(torso)], skin, skSh, skOut, ow, "", -3, -4);
  const crew = (depth: number) => `M${100 - nw - 7} 155 Q100 ${depth} ${100 + nw + 7} 155`;
  const rib = (d: string, w: number, col: string) =>
    `<path d="${d}" fill="none" stroke="${oOut}" stroke-width="${w + 3.4}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`;
  const seams = `<path d="M${L + 10} 176 C${L + 13} 224 ${L + 15} 262 ${L + 15} 296 M${R - 10} 176 C${R - 13} 224 ${R - 15} 262 ${R - 15} 296" stroke="${oOut}" stroke-width="1.5" stroke-opacity=".45" fill="none"/>`;
  const chest = (depth: number) => `<path d="M${100 - nw - 7} 155 Q100 ${depth} ${100 + nw + 7} 155Z" fill="${skin}"/>`;
  const hem = `<rect x="${L}" y="278" width="${sw * 2}" height="24" fill="${oSh}"/><path d="M${L} 278 H${R}" stroke="${oOut}" stroke-width="1.6" stroke-opacity=".55"/>`;
  let hoodBack = "", outfit = "";

  switch (c.outfit) {
    case "hoodie":
      hoodBack = cel([P(`M${100 - nw - 22} 184 C${100 - nw - 26} 142 ${100 - nw - 8} 130 100 130 C${100 + nw + 8} 130 ${100 + nw + 26} 142 ${100 + nw + 22} 184Z`)], oSh, mix(oSh, "#000", 0.25), oOut, ow, "", -2, -3);
      outfit = cel([P(torso)], oc, oSh, oOut, ow,
        `${seams}<path d="M${100 - sw * 0.6} 250 H${100 + sw * 0.6} L${100 + sw * 0.68} 296 H${100 - sw * 0.68}Z" fill="${oSh}" fill-opacity=".5" stroke="${oOut}" stroke-width="1.6" stroke-opacity=".55"/>`, -3, -4) +
        chest(176) + rib(`M${100 - nw - 12} 152 Q100 178 ${100 + nw + 12} 152`, 6, oSh) +
        `<path d="M92 172 C91 188 91 200 92 212 M108 172 C109 188 109 200 108 212" stroke="#f1ebdf" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="92" cy="213" r="2.2" fill="#f1ebdf"/><circle cx="108" cy="213" r="2.2" fill="#f1ebdf"/>`;
      break;
    case "bomber":
      outfit = cel([P(torso)], oc, oSh, oOut, ow,
        `${seams}${hem}<path d="M${100 - sw * 0.78} 240 L${100 - sw * 0.38} 244 M${100 + sw * 0.78} 240 L${100 + sw * 0.38} 244" stroke="${oOut}" stroke-width="2.2" stroke-linecap="round"/><path d="M100 170 V296" stroke="${oOut}" stroke-width="2.2"/>`, -3, -4) +
        chest(170) + rib(crew(170), 7, oSh) +
        `<rect x="97.4" y="172" width="5.2" height="11" rx="2.4" fill="#dcd6c8" stroke="#1d1220" stroke-width="1.2"/><circle cx="${100 - sw * 0.5}" cy="206" r="8" fill="#f1ebdf" stroke="#1d1220" stroke-width="1.4"/><path d="M${100 - sw * 0.5 - 3.4} 203 L${100 - sw * 0.5} 209.5 L${100 - sw * 0.5 + 3.4} 203" stroke="${oc}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case "tee": {
      // Sleeves end in a straight hem; the arms below are bare skin from the skin torso underneath.
      const tee = `M${L} 234 V208 C${L} 184 ${L + 6} 172 ${L + 22} 166 L${100 - nw - 8} 157 Q${100 - nw - 3} 153 ${100 - nw} 152 H${100 + nw} Q${100 + nw + 3} 153 ${100 + nw + 8} 157 L${R - 22} 166 C${R - 6} 172 ${R} 184 ${R} 208 V234 H${R - 19} V296 H${L + 19} V234Z`;
      outfit = skinTorso + cel([P(tee)], oc, oSh, oOut, ow, `<path d="M${L} 234 H${L + 19} M${R} 234 H${R - 19}" stroke="${oOut}" stroke-width="1.8" stroke-opacity=".55"/>`, -3, -3) + chest(172) + rib(crew(172), 5, oSh);
      break;
    }
    case "tank": {
      const xi = 100 - nw - 4, xo = 100 - nw - 20;
      const cloth = `M${xo} 160 L${xi} 154 Q${xi} 182 100 182 Q${200 - xi} 182 ${200 - xi} 154 L${200 - xo} 160 C${200 - xo + 2} 192 ${R - 14} 202 ${R - 14} 240 V296 H${L + 14} V240 C${L + 14} 202 ${xo - 2} 192 ${xo} 160Z`;
      outfit = skinTorso + cel([P(cloth)], oc, oSh, oOut, ow, `<path d="M${L + 14} 276 H${R - 14}" stroke="${oOut}" stroke-width="1.5" stroke-opacity=".4"/>`, -3, -3);
      break;
    }
    case "sweater": {
      const stripe = mix(oc, "#fff", 0.72);
      outfit = cel([P(torso)], oc, oSh, oOut, ow,
        `${seams}<rect x="${L}" y="216" width="${sw * 2}" height="6" fill="${stripe}" fill-opacity=".9"/><rect x="${L}" y="228" width="${sw * 2}" height="3" fill="${stripe}" fill-opacity=".9"/>${hem}`, -3, -4) +
        chest(172) + rib(crew(172), 7, oSh);
      break;
    }
  }
  return { hoodBack, outfit };
}
