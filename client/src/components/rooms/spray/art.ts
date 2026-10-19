// Spray artwork, drawn once into offscreen canvases and reused as sprites by the engine.
// Ported from docs/design/rooms-2026-10/notes.html with the phase 5 revisions: one note design (no denomination,
// no currency sign, no serial number, no security thread, no "legal tender" text, no banknote frame). It is an
// abstract game token: a flat rounded ticket (NOTE_ASPECT, not a banknote's 2:1) with a flat "V3" disc and three pulse
// arcs. The banknote-style patterns of the prototype (guilloche rosette, wavy security lines) are REMOVED until the owner
// signs off on any pattern at all (fix round FC, ruling 8).
// Colours come from sprayTokens.ts, never from CSS variables. Nothing here runs at import time.
import { NOTE_PALETTES, SPRAY_TOKENS as K, type NoteVariant } from "@/lib/sprayTokens";

/** Width to height of one token: a game ticket, clearly not a banknote (about 2:1 or wider). */
export const NOTE_ASPECT = 1.6;

type Ctx = CanvasRenderingContext2D;

/** Device pixel ratio for artwork, capped at 2 (cheap to run). Safe outside a browser. */
export function artDpr(dpr?: number | null): number {
  const d = dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1);
  return Number.isFinite(d) && d > 0 ? Math.min(2, d) : 1;
}

function surface(w: number, h: number, dpr: number): { c: HTMLCanvasElement; g: Ctx } {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  g.scale(dpr, dpr);
  return { c, g };
}

function rr(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * One note (a game token). `variant` only changes the colourway; `back` draws the plain reverse used while a
 * note flips; `phase` (0 to 1) moves a soft sheen for showcase shimmer. Flat fills only: a disc with "V3" and, on
 * the front, three pulse arcs. No line patterns of any kind.
 */
export function noteArt(w: number, h: number, o: { back?: boolean; phase?: number; dpr?: number; variant?: NoteVariant } = {}): HTMLCanvasElement {
  const dpr = artDpr(o.dpr);
  const { c, g } = surface(w, h, dpr);
  const v = o.variant ?? 0;
  const P = NOTE_PALETTES[v] ?? NOTE_PALETTES[0];
  const r = h * 0.24;

  rr(g, 0, 0, w, h, r);
  g.save();
  try {
    g.clip();
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, P.a);
    gr.addColorStop(1, P.b);
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);

    // the flat "V3" disc
    const cx = o.back ? w / 2 : w * 0.62, cy = h / 2, R = h * 0.3;
    g.globalAlpha = 0.92;
    g.fillStyle = P.ink;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = P.tx;
    g.font = `700 ${R * 0.9}px ${K.font}`;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillText("V3", cx, cy + R * 0.32);

    if (!o.back) {
      // a pulse glyph (a dot and three sound arcs) on the left instead of any number
      const gx = w * 0.2, gy = h / 2;
      g.strokeStyle = P.line;
      g.lineCap = "round";
      g.lineWidth = Math.max(1, h * 0.06);
      g.globalAlpha = 0.85;
      g.beginPath();
      g.arc(gx - h * 0.08, gy, h * 0.06, 0, Math.PI * 2);
      g.stroke();
      for (let k = 1; k <= 3; k++) {
        g.globalAlpha = 0.85 - k * 0.18;
        g.beginPath();
        g.arc(gx - h * 0.08, gy, h * (0.06 + k * 0.11), -Math.PI / 4, Math.PI / 4);
        g.stroke();
      }
      g.globalAlpha = 1;
      // soft diagonal sheen, moved by `phase` for showcase shimmer
      const ph = Number.isFinite(o.phase) ? (o.phase as number) % 1 : 0;
      const sx = (ph * 2 - 0.5) * w;
      const sg = g.createLinearGradient(sx - w * 0.2, 0, sx + w * 0.2, h);
      sg.addColorStop(0, "rgba(255,255,255,0)");
      sg.addColorStop(0.5, K.sheenA);
      sg.addColorStop(1, "rgba(255,255,255,0)");
      g.globalAlpha = 0.16;
      g.fillStyle = sg;
      g.fillRect(0, 0, w, h);
      g.globalAlpha = 1;
    }
  } finally {
    g.restore();
  }
  g.strokeStyle = "rgba(255,255,255,.28)";
  g.lineWidth = 1;
  rr(g, 0.5, 0.5, w - 1, h - 1, r);
  g.stroke();
  return c;
}

/** A banded stack of notes. */
export function bundleArt(w: number, h: number, dpr?: number): HTMLCanvasElement {
  const d = artDpr(dpr);
  const { c, g } = surface(w, h, d);
  const nw = w * 0.7, nh = nw / NOTE_ASPECT;
  const vs: NoteVariant[] = [0, 1, 0, 1, 2, 1, 2];
  for (let i = 0; i < vs.length; i++) {
    const n = noteArt(nw, nh, { dpr: d, variant: vs[i] });
    g.save();
    g.translate(w / 2, h * 0.52 + (i - 3) * h * 0.025);
    g.rotate((i - 3) * 0.045);
    g.drawImage(n, -nw / 2, -nh / 2, nw, nh);
    g.restore();
  }
  const bw = w * 0.17;
  g.fillStyle = K.band;
  g.fillRect(w / 2 - bw / 2, h * 0.52 - nh * 0.62, bw, nh * 1.24);
  g.strokeStyle = K.amber;
  g.lineWidth = 1.5;
  g.strokeRect(w / 2 - bw / 2 + 0.75, h * 0.52 - nh * 0.62 + 0.75, bw - 1.5, nh * 1.24 - 1.5);
  g.fillStyle = K.amber;
  g.textAlign = "center";
  g.font = `700 ${bw * 0.4}px ${K.font}`;
  g.fillText("V3", w / 2, h * 0.52 + bw * 0.14);
  return c;
}

/** The duffle bag. `open` 0 is zipped, 1 is fully open with notes showing in the mouth. */
export function bagArt(w: number, h: number, dpr?: number, open = 0): HTMLCanvasElement {
  const d = artDpr(dpr);
  const { c, g } = surface(w, h, d);
  const op = Number.isFinite(open) ? Math.max(0, Math.min(1, open)) : 0;
  const ink = K.midnight, ink2 = K.midnight2, line = K.midnightLine, gold = K.amber, vio = K.violetDeep;
  const bx = w * 0.09, bw = w * 0.82, by = h * 0.4, bh = h * 0.48, r = bh * 0.46, cx = w / 2;
  const handle = (x0: number, x1: number, ytop: number, lw: number, col: string) => {
    g.lineCap = "round";
    g.strokeStyle = K.outline;
    g.lineWidth = lw + 2;
    g.beginPath();
    g.moveTo(x0, by + 3);
    g.bezierCurveTo(x0, ytop, x1, ytop, x1, by + 3);
    g.stroke();
    g.strokeStyle = col;
    g.lineWidth = lw;
    g.stroke();
    g.strokeStyle = line;
    g.globalAlpha = 0.45;
    g.lineWidth = 0.7;
    g.stroke();
    g.globalAlpha = 1;
  };
  handle(w * 0.31, w * 0.6, h * 0.02, h * 0.07, ink2);
  handle(w * 0.4, w * 0.69, h * 0.06, h * 0.07, ink);
  g.fillStyle = gold;
  for (const x of [w * 0.31, w * 0.6, w * 0.4, w * 0.69]) {
    g.beginPath();
    g.arc(x, by + h * 0.01, h * 0.035, 0, Math.PI * 2);
    g.fill();
  }
  rr(g, bx, by, bw, bh, r);
  const gr = g.createLinearGradient(0, by, 0, by + bh);
  gr.addColorStop(0, ink2);
  gr.addColorStop(0.55, ink);
  gr.addColorStop(1, K.bagShadow);
  g.fillStyle = gr;
  g.fill();
  g.save();
  rr(g, bx, by, bw, bh, r);
  g.clip();
  g.fillStyle = vio;
  g.globalAlpha = 0.9;
  g.fillRect(bx, by, bw * 0.13, bh);
  g.fillRect(bx + bw * 0.87, by, bw * 0.13, bh);
  g.globalAlpha = 1;
  g.strokeStyle = gold;
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(bx + bw * 0.13, by);
  g.lineTo(bx + bw * 0.13, by + bh);
  g.moveTo(bx + bw * 0.87, by);
  g.lineTo(bx + bw * 0.87, by + bh);
  g.stroke();
  g.strokeStyle = line;
  g.globalAlpha = 0.3;
  g.lineWidth = 0.9;
  for (let i = 1; i <= 4; i++) {
    g.beginPath();
    g.arc(cx, by + bh * 0.72, bh * 0.3 + i * bh * 0.1, Math.PI * 1.1, Math.PI * 1.9);
    g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = "rgba(255,255,255,.12)";
  g.fillRect(bx, by, bw, bh * 0.08);
  g.restore();
  g.strokeStyle = "rgba(255,255,255,.3)";
  g.lineWidth = 1;
  rr(g, bx + 0.5, by + 0.5, bw - 1, bh - 1, r);
  g.stroke();

  const zy = by + bh * 0.17, zx0 = bx + bw * 0.15, zx1 = bx + bw * 0.85;
  const hw = ((zx1 - zx0) / 2) * Math.min(1, 0.15 + op * 0.85);
  if (op > 0) {
    const oy = bh * 0.2 * op + bh * 0.02;
    g.fillStyle = K.bagMouth;
    g.beginPath();
    g.ellipse(cx, zy, hw, oy, 0, 0, Math.PI * 2);
    g.fill();
    g.save();
    g.beginPath();
    g.rect(0, 0, w, zy);
    g.clip();
    const peek: [NoteVariant, number, number, number][] = [[2, -0.62, -0.12, 0.9], [1, 0.02, -0.2, 1], [2, 0.55, -0.1, 0.86], [0, -0.28, -0.3, 0.78], [1, 0.3, -0.26, 0.8]];
    const pw = w * 0.3, ph = pw / NOTE_ASPECT;
    for (const [vv, dx, dy, sc] of peek) {
      const a2 = noteArt(pw, ph, { dpr: d, variant: vv });
      g.save();
      g.translate(cx + dx * hw, zy + dy * h * op * 0.9);
      g.rotate(dx * 0.55);
      g.scale(sc, sc);
      g.drawImage(a2, -pw / 2, -ph / 2, pw, ph);
      g.restore();
    }
    g.restore();
    g.strokeStyle = ink2;
    g.lineWidth = h * 0.035;
    g.beginPath();
    g.ellipse(cx, zy, hw, oy, 0, 0.05, Math.PI - 0.05);
    g.stroke();
    g.strokeStyle = gold;
    g.lineWidth = 1.6;
    g.setLineDash([1.5, 1.5]);
    g.beginPath();
    g.ellipse(cx, zy, hw, oy, 0, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = K.outline;
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(zx0, zy);
    g.lineTo(cx - hw, zy);
    g.moveTo(cx + hw, zy);
    g.lineTo(zx1, zy);
    g.stroke();
    g.strokeStyle = gold;
    g.lineWidth = 1.8;
    g.setLineDash([1.4, 1.4]);
    g.beginPath();
    g.moveTo(zx0, zy);
    g.lineTo(cx - hw, zy);
    g.moveTo(cx + hw, zy);
    g.lineTo(zx1, zy);
    g.stroke();
    g.setLineDash([]);
  } else {
    g.strokeStyle = K.outline;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(zx0, zy);
    g.lineTo(zx1, zy);
    g.stroke();
    g.strokeStyle = gold;
    g.lineWidth = 2;
    g.setLineDash([1.4, 1.4]);
    g.beginPath();
    g.moveTo(zx0, zy);
    g.lineTo(zx1, zy);
    g.stroke();
    g.setLineDash([]);
  }
  // zip pull
  const px = op > 0 ? cx + hw + h * 0.02 : cx + bw * 0.18;
  g.fillStyle = gold;
  g.beginPath();
  g.moveTo(px, zy - h * 0.02);
  g.lineTo(px + h * 0.05, zy + h * 0.02);
  g.lineTo(px + h * 0.03, zy + h * 0.12);
  g.lineTo(px - h * 0.03, zy + h * 0.12);
  g.lineTo(px - h * 0.05, zy + h * 0.02);
  g.closePath();
  g.fill();
  g.fillStyle = K.midnight;
  g.beginPath();
  g.arc(px, zy + h * 0.08, h * 0.012, 0, Math.PI * 2);
  g.fill();
  // medallion
  const py = by + bh * 0.66, pr = bh * 0.27;
  g.fillStyle = gold;
  g.beginPath();
  g.arc(cx, py, pr, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = K.outline;
  g.lineWidth = 0.9;
  g.globalAlpha = 0.6;
  g.beginPath();
  g.arc(cx, py, pr * 0.8, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;
  g.fillStyle = K.midnight;
  g.textAlign = "center";
  g.font = `700 ${pr * 0.95}px ${K.font}`;
  g.fillText("V3", cx, py + pr * 0.33);
  return c;
}

/** The Make it Rain tray icon: a cloud with notes and amber drops falling. */
export function rainArt(w: number, h: number, dpr?: number): HTMLCanvasElement {
  const d = artDpr(dpr);
  const { c, g } = surface(w, h, d);
  const nw = w * 0.34, nh = nw / NOTE_ASPECT;
  const items: [NoteVariant, number, number, number][] = [[2, w * 0.24, h * 0.66, -0.35], [1, w * 0.5, h * 0.8, 0.12], [0, w * 0.76, h * 0.66, 0.4], [2, w * 0.38, h * 0.9, 0.25], [0, w * 0.64, h * 0.92, -0.3]];
  for (const [vv, x, y, rot] of items) {
    const n = noteArt(nw, nh, { dpr: d, variant: vv });
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.drawImage(n, -nw / 2, -nh / 2, nw, nh);
    g.restore();
  }
  const cl: [number, number, number][] = [[0.34, 0.24, 0.14], [0.5, 0.18, 0.18], [0.66, 0.24, 0.14], [0.42, 0.3, 0.13], [0.58, 0.3, 0.13]];
  g.fillStyle = K.violetLine;
  for (const q of cl) { g.beginPath(); g.arc(w * q[0], h * q[1], w * q[2] + 2.5, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = K.midnight2;
  for (const q of cl) { g.beginPath(); g.arc(w * q[0], h * q[1], w * q[2], 0, Math.PI * 2); g.fill(); }
  g.fillStyle = K.amber;
  for (let i = 0; i < 9; i++) g.fillRect(w * (0.2 + i * 0.075), h * (0.44 + (i % 3) * 0.04), 2, 8);
  return c;
}
