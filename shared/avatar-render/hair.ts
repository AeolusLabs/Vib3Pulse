import { C, P, R, Rm, cel, mir, type Ctx } from "./shapes";
import { mix } from "./palette";

export interface HairLayers { back: string; locks: string; front: string }

// Hairline caps that sit on the forehead, one per family of styles.
const FR: Record<string, string> = {
  crop: "M60 98 C54 50 78 32 100 32 C124 32 146 50 140 98 C138 84 134 76 128 72 L118 78 L110 68 L100 76 L90 66 L82 76 L72 74 C66 80 62 90 60 98Z",
  quiff: "M60 98 C46 56 60 26 88 20 C110 12 142 22 148 54 C150 72 144 86 140 98 C138 82 132 72 124 68 C112 58 96 62 84 68 C72 74 64 86 60 98Z",
  pixie: "M60 102 C52 52 76 32 100 32 C126 32 148 52 140 106 C138 92 134 84 128 80 C116 72 98 74 84 62 C76 70 66 82 60 102Z",
  bob: "M60 100 C54 50 78 32 100 32 C124 32 146 50 140 100 C138 88 134 80 128 76 C118 70 106 74 98 62 C94 74 80 86 66 88 C62 92 61 96 60 100Z",
  long: "M60 100 C54 50 78 32 100 32 C124 32 146 50 140 100 C136 80 124 66 100 64 C76 66 64 80 60 100Z",
  bangs: "M60 100 C54 50 78 32 100 32 C124 32 146 50 140 100 L138 86 C124 79 112 83 100 77 C88 83 76 79 62 86Z",
  slick: "M62 94 C58 52 80 36 100 36 C120 36 142 52 138 94 C135 76 126 66 112 63 C104 61 94 61 86 64 C74 68 65 80 62 94Z",
  curls: "M62 92 C56 54 80 40 100 40 C120 40 144 54 138 92 C134 76 126 66 112 63 C104 61 94 61 86 64 C74 68 66 78 62 92Z",
  afro: "M60 96 C56 56 80 40 100 40 C120 40 144 56 140 96 C136 78 126 66 112 63 C104 61 94 61 86 64 C74 68 64 80 60 96Z",
  buzz: "M64 90 C60 56 80 44 100 44 C120 44 140 56 136 90 C134 74 126 64 112 62 C104 60 96 60 88 63 C74 68 66 78 64 90Z",
  fade: "M66 80 C60 52 80 32 100 32 C120 32 140 52 134 80 C132 68 122 60 100 60 C78 60 68 68 66 80Z",
  dread: "M60 98 C54 50 78 34 100 34 C124 34 146 50 140 98 C138 84 132 72 122 66 C110 60 90 60 78 66 C68 72 62 84 60 98Z",
};
const LOCK = "M62 88 C54 124 50 170 54 218 Q69 228 86 216 Q84 172 80 132 Q76 108 74 92Z";
const WAVY_LOCK = "M62 88 C46 114 66 138 50 164 C40 186 58 202 52 224 Q68 234 88 220 C80 198 94 180 84 156 C78 134 82 112 74 92Z";

// Styles that still show behind a cap or beanie (they hang below it).
const SHOWS_UNDER_CAP = new Set(["long", "wavy", "bangs", "bob", "braids", "dreads", "ponytail"]);

export function hairLayers(x: Ctx): HairLayers {
  const { c, hc, hSh, hOut, skin, ow, capOn, oLt, oOut } = x;
  const hs = c.hair;
  const hl = (d: string, o = 0.5) => `<path d="${d}" fill="none" stroke="${hOut}" stroke-width="1.5" stroke-opacity="${o}" stroke-linecap="round"/>`;
  const strands: Record<string, string> = {
    crop: hl("M78 44 C86 40 94 40 102 42") + hl("M112 42 C122 42 130 46 134 52"),
    quiff: hl("M66 40 C80 26 104 22 124 30") + hl("M100 40 C112 34 126 38 132 50"),
    pixie: hl("M72 50 C84 40 100 38 116 42") + hl("M92 66 C102 70 114 70 124 76"),
    bob: hl("M72 48 C84 40 100 38 114 42"), long: hl("M72 48 C84 40 100 38 114 42"), bangs: hl("M70 60 C84 70 116 70 130 60"),
    slick: hl("M74 52 C86 44 100 42 112 46"), curls: hl("M76 52 C88 46 100 46 110 50"), afro: hl("M76 52 C88 46 100 46 110 50"),
    fade: hl("M76 46 C88 40 112 40 124 46"), dread: hl("M74 50 C86 42 114 42 126 50"),
  };
  const front = (key: string) => cel([P(FR[key])], hc, hSh, hOut, ow, strands[key] ?? "", -3, -4);
  const fadeSides = `<path d="M62 102 C57 84 60 70 66 62 L70 78 C69 90 67 97 65 104Z M138 102 C143 84 140 70 134 62 L130 78 C131 90 133 97 135 104Z" fill="${mix(hc, skin, 0.55)}" fill-opacity=".85"/>`;
  const longBack = cel([P("M58 98 C50 44 76 26 100 26 C124 26 150 44 142 98 L146 158 L54 158Z")], hc, hSh, hOut, ow);
  const lockPair = (d: string, extra = "") => cel([P(d), P(mir(d))], hc, hSh, hOut, ow, extra);
  let back = "", locks = "", fr = "";

  switch (hs) {
    case "long":
      back = longBack;
      locks = lockPair(LOCK, hl("M62 140 C60 170 62 196 66 214") + hl(mir("M62 140 C60 170 62 196 66 214")));
      fr = front("long"); break;
    case "bangs":
      back = longBack; locks = lockPair(LOCK); fr = front("bangs"); break;
    case "wavy":
      back = cel([P("M56 98 C46 44 76 24 100 24 C124 24 154 44 144 98 L152 178 L48 178Z")], hc, hSh, hOut, ow);
      locks = lockPair(WAVY_LOCK, hl("M58 150 C50 170 62 184 56 208") + hl(mir("M58 150 C50 170 62 184 56 208")));
      fr = front("long"); break;
    case "bob":
      back = cel([P("M58 96 C52 46 78 28 100 28 C124 28 148 46 142 96 L146 146 Q122 158 116 138 L84 138 Q78 158 54 146Z")], hc, hSh, hOut, ow);
      fr = front("bob"); break;
    case "pixie": fr = front("pixie"); break;
    case "ponytail":
      if (!capOn) back = cel([P("M126 54 C168 50 182 100 164 156 C156 184 140 192 140 168 C146 134 140 100 128 84Z")], hc, hSh, hOut, ow, hl("M150 76 C162 106 156 140 148 168")) +
        `<rect x="122" y="56" width="10" height="16" rx="4" fill="${oLt}" stroke="${oOut}" stroke-width="1.6" transform="rotate(-20 127 64)"/>`;
      fr = front("slick"); break;
    case "buns":
      if (!capOn) back = cel([C(66, 32, 15), C(134, 32, 15)], hc, hSh, hOut, ow, hl("M58 28 Q66 22 74 28") + hl("M126 28 Q134 22 142 28"));
      fr = front("slick"); break;
    case "puffs":
      if (!capOn) back = cel([C(56, 40, 19), C(144, 40, 19)], hc, hSh, hOut, ow, hl("M46 34 Q54 26 64 30") + hl("M136 30 Q146 26 154 34"));
      fr = front("slick"); break;
    case "braids": {
      const chain = (x0: number) => Array.from({ length: 8 }, (_, i) => `<ellipse cx="${x0 + (i % 2 ? 3 : -3) - i * 0.6}" cy="${130 + i * 12}" rx="7.6" ry="8.6"/>`);
      const left = chain(68);
      const right = left.map((s) => s.replace(/cx="([\d.]+)"/, (_m, v) => `cx="${(200 - Number(v)).toFixed(1)}"`));
      back = cel([P("M58 98 C50 44 76 28 100 28 C124 28 150 44 142 98 L142 134 L58 134Z")], hc, hSh, hOut, ow);
      locks = cel([...left, ...right], hc, hSh, hOut, ow) +
        `<circle cx="63" cy="228" r="4.2" fill="${oLt}" stroke="${oOut}" stroke-width="1.6"/><circle cx="137" cy="228" r="4.2" fill="${oLt}" stroke="${oOut}" stroke-width="1.6"/>`;
      fr = front("long"); break;
    }
    case "curls":
      if (!capOn) back = cel([C(62, 70, 15), C(66, 50, 15), C(82, 38, 15), C(100, 33, 15), C(118, 38, 15), C(134, 50, 15), C(138, 70, 15), C(56, 92, 12), C(144, 92, 12), C(54, 112, 13), C(146, 112, 13)], hc, hSh, hOut, ow, hl("M72 54 Q78 48 86 50") + hl("M110 46 Q118 42 124 48"));
      fr = front("curls"); break;
    case "afro":
      if (!capOn) back = cel([C(50, 86, 20), C(54, 58, 22), C(74, 38, 22), C(100, 30, 24), C(126, 38, 22), C(146, 58, 22), C(150, 86, 20), C(60, 108, 12), C(140, 108, 12)], hc, hSh, hOut, ow, hl("M70 54 Q78 46 88 48") + hl("M112 44 Q122 42 130 50") + hl("M52 76 Q54 88 60 94") + hl("M148 76 Q146 88 140 94"));
      fr = front("afro"); break;
    case "crop": fr = front("crop"); break;
    case "quiff": fr = front("quiff"); break;
    case "buzz": fr = `<path d="${FR.buzz}" fill="${mix(hc, skin, 0.5)}"/>`; break;
    case "fade": fr = fadeSides + front("fade"); break;
    case "mohawk":
      fr = `<path d="${FR.buzz}" fill="${mix(hc, skin, 0.62)}"/>` +
        cel([P("M88 68 C86 54 88 42 90 34 L94 24 L97 8 L100 -2 L103 8 L106 24 L110 34 C112 42 114 54 112 68 C106 62 94 62 88 68Z")], hc, hSh, hOut, ow, hl("M98 20 L98 56") + hl("M102 20 L102 56"), -3, -3);
      break;
    case "punk":
      fr = cel([P("M60 96 C52 64 62 44 68 30 L76 46 L82 20 L90 42 L100 8 L110 42 L118 20 L124 46 L132 30 C138 44 148 64 140 96 C136 80 126 68 112 64 C104 62 94 62 86 64 C74 68 64 82 60 96Z")], hc, hSh, hOut, ow, hl("M82 28 L84 46") + hl("M100 18 L100 44") + hl("M118 28 L116 46"), -3, -4);
      break;
    case "topknot":
      back = cel([C(100, 22, 14)], hc, hSh, hOut, ow, hl("M92 18 C98 12 106 12 110 18"));
      fr = fadeSides + front("slick"); break;
    case "cornrows": {
      const rows = [-18, -9, 0, 9, 18].map((o) => `<path d="M${100 + o} 64 C${100 + o * 1.15} 52 ${100 + o * 0.95} 44 ${100 + o * 0.6} 38" fill="none" stroke="${hOut}" stroke-width="2" stroke-opacity=".75" stroke-linecap="round"/>`).join("");
      fr = cel([P(`M62 92 C58 54 80 40 100 40 C120 40 142 54 138 92 C134 76 126 66 112 63 C104 61 94 61 86 64 C74 68 66 78 62 92Z`)], hc, hSh, hOut, ow, rows, -3, -4);
      break;
    }
    case "dreads": {
      const lens = [100, 146, 96];
      const starts: Array<[number, number]> = [[44, 86], [53, 84], [62, 84]];
      const shapes: string[] = [];
      let ticks = "";
      starts.forEach(([lx, ly], i) => {
        const h = lens[i];
        shapes.push(R(lx, ly, 9, h, 4.5), Rm(lx, ly, 9, h, 4.5));
        for (let t = ly + 12; t < ly + h - 4; t += 11) ticks += `<path d="M${lx + 1.5} ${t} H${lx + 7.5} M${200 - lx - 7.5} ${t} H${200 - lx - 1.5}" stroke="${hOut}" stroke-width="1.2" stroke-opacity=".55"/>`;
      });
      back = cel([P("M58 96 C52 46 78 28 100 28 C124 28 148 46 142 96Z")], hc, hSh, hOut, ow);
      locks = cel(shapes, hc, hSh, hOut, ow, ticks, -2, -2);
      fr = front("dread"); break;
    }
    default: break; // bald
  }

  // A cap or beanie hides the front hair; only styles that hang below it stay visible.
  if (capOn) {
    if (!SHOWS_UNDER_CAP.has(hs)) { back = ""; locks = ""; }
    fr = "";
  }
  return { back, locks, front: fr };
}
