// Spray effects engine: one canvas, pre-drawn sprites, particles. Ported from docs/design/rooms-2026-10/notes.html
// (particle types note, spark, ring, fly, bigfly, rig; hit-stop freeze; rain with wind and light beams).
//
// Safety rules this file keeps (phase 5 review focus):
// - dt is never negative and never above 33 ms (`clampDt`), so a clock jump can't run physics backwards.
// - every particle steps and paints inside its own try/catch; a throwing particle is dropped, never the loop.
// - the next frame is scheduled in `finally`, so an exception can't strand the loop; a loop that keeps failing
//   clears itself after 3 frames instead of spinning forever.
// - the loop stops by itself when nothing is alive (no idle rAF), stops and drops everything when the tab is hidden,
//   and `destroy()` cancels the frame, removes every listener and releases the sprites.
// - at most 200 live notes (120 while a live video is on screen) and 600 particles in total; rain spawns less
//   when frames slip and never builds a backlog.
// - quiet mode, reduced motion and a hidden tab skip the animation and call `onLand` at once, so the UI can show
//   its chip and the server's chat line still says what happened.
// - `onLand` is called exactly once per spray (also when its particle errors or the tab hides), never after destroy().
//
// The pure helpers (`clampDt`, `rainRate`, `windAt`, `beamAt`, `bezierAt`, `noteCap`, `easeOutQuart`) have no DOM and
// are unit tested in scripts/test-rooms-unit-spray-engine.ts. Nothing touches the DOM at import time.
import { NOTE_ASPECT, artDpr, bagArt, bundleArt, noteArt } from "./art";
import { snd } from "./sound";
import { SPRAY_TOKENS as K, type NoteVariant } from "@/lib/sprayTokens";

export type SprayKind = "note" | "bundle" | "bag" | "rain";
export const SPRAY_KINDS: readonly SprayKind[] = ["note", "bundle", "bag", "rain"];
export interface Point { x: number; y: number }
export interface SprayHooks { onLand?: () => void }
export interface SprayEngineOptions { maxNotes?: number; videoActive?: () => boolean }

export const MAX_NOTES = 200;
export const MAX_NOTES_VIDEO = 120;
export const MAX_PARTICLES = 600;
export const MAX_DT = 0.033;
export const FIRST_DT = 0.016;
export const RAIN_SECONDS = 5;
/** When rain "lands" for the onLand hook: the end of the ramp, when the room is full of notes. */
export const RAIN_LAND_AT = 0.9;
const NW = 58, NH = NW / NOTE_ASPECT, BIG_W = 110;

// ---------- pure helpers (tested without a DOM) ----------

/** Seconds since the last frame, clamped to [0, MAX_DT]. The first frame (no last) is FIRST_DT. Never negative, never NaN. */
export function clampDt(ts: number, last: number): number {
  if (!Number.isFinite(ts) || !Number.isFinite(last) || last <= 0) return FIRST_DT;
  const d = (ts - last) / 1000;
  if (!(d > 0)) return 0;
  return Math.min(MAX_DT, d);
}

/** Rain spawn rate in notes per second at time t: ramps 0 to 150 over 0.9 s, holds to 3.7 s, tapers to 0 at 5 s. */
export function rainRate(t: number): number {
  if (!(t > 0) || t >= RAIN_SECONDS) return 0;
  if (t < 0.9) return 150 * (t / 0.9);
  if (t < 3.7) return 150;
  return Math.max(0, 150 * (1 - (t - 3.7) / 1.3));
}

/** Sideways wind in px/s during rain. */
export function windAt(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.sin(t * 0.8) * 55 + Math.sin(t * 2.1) * 18;
}

/** Light beam strength 0 to 1 during rain. */
export function beamAt(t: number): number {
  if (!(t > 0)) return 0;
  if (t < 0.9) return t / 0.9;
  if (t < 4.2) return 1;
  return Math.max(0, 1 - (t - 4.2) / 1.2);
}

/** Quadratic bezier on one axis: start a, control c, end b, at u in [0, 1] (clamped). */
export function bezierAt(a: number, c: number, b: number, u: number): number {
  const t = Number.isFinite(u) ? Math.max(0, Math.min(1, u)) : 0;
  const m = 1 - t;
  return m * m * a + 2 * m * t * c + t * t * b;
}

export function easeOutQuart(u: number): number {
  const t = Number.isFinite(u) ? Math.max(0, Math.min(1, u)) : 0;
  return 1 - Math.pow(1 - t, 4);
}

/** Live note cap: the caller's maxNotes, never above 200, and never above 120 while a live video is on screen. */
export function noteCap(maxNotes: number | undefined, videoActive: boolean): number {
  const hard = videoActive ? MAX_NOTES_VIDEO : MAX_NOTES;
  if (maxNotes === undefined || !Number.isFinite(maxNotes)) return hard;
  return Math.max(0, Math.min(hard, Math.floor(maxNotes)));
}

export function isSprayKind(x: unknown): x is SprayKind {
  return typeof x === "string" && (SPRAY_KINDS as readonly string[]).includes(x);
}

const pickVariant = (r: number): NoteVariant => (r < 0.45 ? 0 : r < 0.8 ? 1 : 2);
const finitePoint = (p: Point | null | undefined, fb: Point): Point =>
  p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : fb;

/** Wraps a caller hook so it runs at most once and can never throw into the engine. */
function once(fn?: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (!fn) return;
    try { fn(); } catch { /* a UI hook can never break the effects loop */ }
  };
}

// ---------- particles ----------

interface Base { delay: number; dead?: boolean }
interface NoteP extends Base {
  type: "note"; x: number; y: number; vx: number; vy: number; v: NoteVariant; s: number; z: number; al: number; sh: boolean;
  fp: number; fs: number; tp: number; ts: number; rz: number; rzv: number; ph: number; sw: number; swF: number;
  age: number; life: number; grav: number; term: number; wd: number; gl: number;
}
interface SparkP extends Base {
  type: "spark"; x: number; y: number; vx: number; vy: number; age: number; life: number; col: string; size: number;
  ph: number; tw: boolean; rot?: number; rotv?: number;
}
interface RingP extends Base { type: "ring"; x: number; y: number; r1: number; col: string; age: number; life: number; lw: number }
interface Trail { x: number; y: number; rz: number; fp: number }
interface FlyP extends Base {
  type: "fly" | "bigfly"; kind: "note" | "bundle" | "bag"; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number;
  t: number; dur: number; v: NoteVariant; fp: number; fs: number; tp: number; ts: number; x: number; y: number; rz: number; s: number;
  sh: boolean; tr: Trail[]; fx?: () => void; hook: () => void;
}
interface RigP extends Base { type: "rig"; x: number; y: number; t: number; fired: [boolean, boolean, boolean] }
type Part = NoteP | SparkP | RingP | FlyP | RigP;
interface SpriteLike { x: number; y: number; rz: number; fp: number; s: number; v: NoteVariant; tp: number; sh: boolean; gl?: number }

export class SprayEngine {
  /** Quiet effects: no animation and no sound; onLand fires at once so the UI shows its chip. */
  quiet = false;
  /** Sound off. */
  muted = false;

  private readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private readonly maxNotes: number | undefined;
  private readonly videoActive: (() => boolean) | undefined;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private sprites: { f: HTMLCanvasElement; b: HTMLCanvasElement }[] = [];
  private bundleS: HTMLCanvasElement | null = null;
  private bagS: HTMLCanvasElement | null = null;
  private bagO: HTMLCanvasElement | null = null;
  private spritesDpr = 0;
  private parts: Part[] = [];
  private notes = 0;
  private rain = { on: false, t: 0, acc: 0, beam: 0, onLand: undefined as (() => void) | undefined };
  private wind = 0;
  private slow = 0;
  private freeze = 0;
  private raf = 0;
  private running = false;
  private lastTs = 0;
  private failures = 0;
  private destroyed = false;
  private reduce = false;
  private video = false;
  private mq: MediaQueryList | null = null;

  constructor(canvas: HTMLCanvasElement, opts: SprayEngineOptions = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.maxNotes = opts.maxNotes;
    this.videoActive = opts.videoActive;
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVis);
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      this.mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.reduce = this.mq.matches;
      if (typeof this.mq.addEventListener === "function") this.mq.addEventListener("change", this.onMq);
      else this.mq.addListener(this.onMq);
    }
  }

  /** Particles alive right now (fixture counter, leak checks). */
  get liveCount(): number { return this.parts.length; }
  /** Notes alive right now. */
  get noteCount(): number { return this.notes; }
  /** True while a frame is scheduled. False when idle: no rAF is left behind. */
  get isRunning(): boolean { return this.running; }

  setSize(w: number, h: number, dpr: number): void {
    if (this.destroyed) return;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) return;
    this.dpr = artDpr(dpr);
    this.W = w;
    this.H = h;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    if (this.spritesDpr && this.spritesDpr !== this.dpr) this.buildSprites();
  }

  spray(kind: SprayKind, from: Point, to: Point, hooks?: SprayHooks): void {
    if (this.destroyed || !isSprayKind(kind)) return;
    const land = once(hooks?.onLand);
    const hidden = typeof document !== "undefined" && document.hidden;
    if (!this.muted && !this.quiet && !hidden) snd[kind]();
    if (this.quiet || this.reduce || hidden || !this.g || this.W <= 0 || this.H <= 0) { land(); return; }
    try {
      if (this.spritesDpr !== this.dpr) this.buildSprites();
      const center = { x: this.W / 2, y: this.H / 3 };
      const a = finitePoint(from, { x: this.W - 60, y: this.H - 40 });
      const b = finitePoint(to, center);
      if (kind === "note") this.sprayNote(a, b, land);
      else if (kind === "bundle") this.sprayBundle(a, b, land);
      else if (kind === "bag") this.sprayBag(a, b, land);
      else this.startRain(b, land);
    } catch {
      land();
    }
  }

  /** Stops everything and releases the canvas, sprites and listeners. Hooks of unfinished sprays are not called. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
    this.parts.length = 0;
    this.notes = 0;
    this.rain = { on: false, t: 0, acc: 0, beam: 0, onLand: undefined };
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVis);
    if (this.mq) {
      if (typeof this.mq.removeEventListener === "function") this.mq.removeEventListener("change", this.onMq);
      else this.mq.removeListener(this.onMq);
      this.mq = null;
    }
    try { this.g?.setTransform(1, 0, 0, 1, 0, 0); this.g?.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch { /* ignore */ }
    this.sprites = [];
    this.bundleS = this.bagS = this.bagO = null;
    this.spritesDpr = 0;
    this.g = null;
  }

  // ---------- lifecycle ----------

  private readonly onVis = () => {
    if (typeof document !== "undefined" && document.hidden) this.clear();
  };

  private readonly onMq = (e: MediaQueryListEvent) => {
    this.reduce = e.matches;
    if (e.matches) this.clear();
  };

  /** Drop every particle and stop the loop. Pending onLand hooks fire now, so the UI never waits on a dropped effect. */
  private clear(): void {
    const hooks: (() => void)[] = [];
    for (const p of this.parts) if (p.type === "fly" || p.type === "bigfly") hooks.push(p.hook);
    if (this.rain.onLand) hooks.push(this.rain.onLand);
    this.parts.length = 0;
    this.notes = 0;
    this.rain = { on: false, t: 0, acc: 0, beam: 0, onLand: undefined };
    this.wind = 0;
    this.freeze = 0;
    if (this.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
    try { this.g?.setTransform(1, 0, 0, 1, 0, 0); this.g?.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch { /* ignore */ }
    for (const h of hooks) h();
  }

  private kick(): void {
    if (this.running || this.destroyed || !this.g) return;
    if (typeof document !== "undefined" && document.hidden) return;
    this.running = true;
    this.lastTs = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (ts: number) => {
    this.raf = 0;
    if (this.destroyed) { this.running = false; return; }
    let again = false;
    try {
      const g = this.g;
      if (!g) throw new Error("no canvas");
      let dt = clampDt(ts, this.lastTs);
      this.lastTs = ts;
      if (dt > 0.026) this.slow++; else this.slow = Math.max(0, this.slow - 1);
      if (this.freeze > 0) { this.freeze -= dt; dt = 0; }
      let video = false;
      try { video = !!this.videoActive?.(); } catch { video = false; }
      this.video = video;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.canvas.width, this.canvas.height);
      try { this.rainStep(dt); this.beams(); } catch { this.stopRain(); }
      const n = this.parts.length;
      for (let i = 0; i < n; i++) {
        const p = this.parts[i];
        if (p.dead) continue;
        if (p.delay > 0) { p.delay -= dt; continue; }
        try {
          if (!this.step(p, dt)) { this.kill(p); continue; }
          this.paint(p);
        } catch {
          this.kill(p);
        }
      }
      this.compact();
      this.failures = 0;
      again = this.parts.length > 0 || this.rain.on || this.rain.beam > 0;
    } catch {
      // Something outside a particle failed. Keep going a few frames, then give up cleanly instead of spinning.
      this.failures++;
      again = this.failures < 3 && (this.parts.length > 0 || this.rain.on);
      if (!again) this.clear();
    } finally {
      const hidden = typeof document !== "undefined" && document.hidden;
      if (!this.destroyed && again && !hidden) this.raf = requestAnimationFrame(this.tick);
      else this.running = false;
    }
  };

  private kill(p: Part): void {
    p.dead = true;
    if (p.type === "fly" || p.type === "bigfly") p.hook();
  }

  /** In-place removal of dead particles (no new array per frame) and a fresh note count. */
  private compact(): void {
    let j = 0, notes = 0;
    const a = this.parts;
    for (let i = 0; i < a.length; i++) {
      const p = a[i];
      if (p.dead) continue;
      if (p.type === "note") notes++;
      a[j++] = p;
    }
    a.length = j;
    this.notes = notes;
  }

  // ---------- spawning ----------

  private cap(): number { return noteCap(this.maxNotes, this.video); }

  private add(p: Part): boolean {
    if (p.type !== "fly" && p.type !== "bigfly" && this.parts.length >= MAX_PARTICLES) return false;
    if (p.type === "note") {
      if (this.notes >= this.cap()) return false;
      this.notes++;
    }
    this.parts.push(p);
    return true;
  }

  private mkNote(x: number, y: number, v: NoteVariant, o: Partial<Pick<NoteP, "vx" | "vy" | "s" | "z" | "al" | "sh" | "fs" | "sw" | "life" | "grav" | "term" | "delay" | "wd">> = {}): NoteP {
    const z = o.z || 1;
    return {
      type: "note", x, y, vx: o.vx || 0, vy: o.vy || 0, v, s: (o.s || 1) * z, z, al: o.al || 1, sh: z >= 1 && o.sh !== false,
      fp: Math.random() * 6.28, fs: o.fs || 5 + Math.random() * 7, tp: Math.random() * 6.28, ts: 2 + Math.random() * 4,
      rz: (Math.random() - 0.5) * 0.8, rzv: (Math.random() - 0.5) * 1.4, ph: Math.random() * 6.28, sw: o.sw || 26 + Math.random() * 34,
      swF: 1.6 + Math.random() * 1.6, age: 0, life: o.life || 2.4 + Math.random(), grav: o.grav == null ? 520 : o.grav,
      term: o.term || 170 + Math.random() * 60, delay: o.delay || 0, wd: o.wd || 0, gl: 0,
    };
  }

  private spark(x: number, y: number, col: string, n: number, sp: number, life: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, v = sp * (0.4 + Math.random() * 0.8);
      if (!this.add({ type: "spark", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - sp * 0.3, age: 0, life: life * (0.7 + Math.random() * 0.5), col, size: 2 + Math.random() * 2.5, ph: Math.random() * 6.28, tw: true, delay: 0 })) return;
    }
  }

  private ring(x: number, y: number, r1: number, col: string, life: number, lw = 2): void {
    this.add({ type: "ring", x, y, r1, col, age: 0, life, lw, delay: 0 });
    this.kick();
  }

  private pourNotes(x: number, y: number, n: number, spread: number, vmin: number, vmax: number, d0: number, grav: number): void {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() * 2 - 1) * spread, v = vmin + Math.random() * (vmax - vmin);
      const nt = this.mkNote(x + (Math.random() - 0.5) * 34, y, pickVariant(Math.random()), {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v, delay: d0 + i * 0.004, life: 2.6 + Math.random() * 1.4, s: 0.85 + Math.random() * 0.35, grav,
      });
      nt.rz = (a + Math.PI / 2) * 0.9;
      if (!this.add(nt)) return; // at the cap: the rest of this pour is skipped
    }
  }

  private fly(from: Point, to: Point, v: NoteVariant, kind: "note" | "bundle" | "bag", fx: () => void, hook: () => void): void {
    const big = kind !== "note", bag = kind === "bag";
    const dur = bag ? 0.74 : big ? 0.54 : 0.6 + Math.random() * 0.12, side = Math.random() < 0.5 ? -1 : 1;
    this.add({
      type: big ? "bigfly" : "fly", kind, x0: from.x, y0: from.y, x1: to.x, y1: to.y,
      cx: (from.x + to.x) / 2 + (Math.random() * 80 - 40) + (bag ? side * 34 : 0),
      cy: Math.min(from.y, to.y) - 110 - Math.random() * 60 - (bag ? 44 : 0),
      t: 0, dur, v, fp: 0, fs: 16 + Math.random() * 8, tp: 0, ts: 9, delay: 0, x: from.x, y: from.y, rz: 0, s: 1, sh: true, tr: [], fx, hook,
    });
    this.kick();
  }

  private sprayNote(from: Point, to: Point, land: () => void): void {
    const v = pickVariant(Math.random());
    this.fly(from, to, v, "note", () => {
      this.ring(to.x, to.y, 34, K.violet, 0.42, 2);
      this.spark(to.x, to.y, K.violet, 7, 130, 0.55);
      this.add(this.mkNote(to.x, to.y, v, { vx: (Math.random() - 0.5) * 90, vy: -50, life: 1, grav: 320, s: 1 }));
    }, land);
  }

  private sprayBundle(from: Point, to: Point, land: () => void): void {
    const d = { x: to.x, y: to.y - 30 };
    this.fly(from, d, 1, "bundle", () => {
      this.freeze = 0.07;
      this.ring(d.x, d.y, 70, K.amber, 0.5, 3);
      this.ring(d.x, d.y, 112, K.violet, 0.7, 2);
      this.spark(d.x, d.y, K.amber, 16, 240, 0.7);
      this.add({ type: "spark", x: d.x, y: d.y, vx: -140, vy: -190, age: 0, life: 0.9, col: K.band, size: 6, rot: 0, rotv: 16, ph: 0, tw: false, delay: 0.07 });
      this.pourNotes(d.x, d.y, 100, 1.35, 140, 370, 0.07, 560);
    }, land);
  }

  private sprayBag(from: Point, to: Point, land: () => void): void {
    const d = { x: to.x, y: Math.max(to.y - 52, 40) };
    this.fly(from, d, 2, "bag", () => {
      this.freeze = 0.08;
      this.ring(d.x, d.y + 8, 60, K.amber, 0.45, 3);
      this.ring(d.x, d.y + 8, 98, K.violet, 0.65, 2);
      this.add({ type: "rig", x: d.x, y: d.y, t: -0.08, fired: [false, false, false], delay: 0 });
    }, land);
  }

  private startRain(to: Point, land: () => void): void {
    const prev = this.rain.onLand;
    this.ring(to.x, to.y, 130, K.amber, 0.9, 3);
    this.ring(to.x, to.y, 70, K.violet, 0.6, 2);
    this.rain = { on: true, t: 0, acc: 0, beam: this.rain.beam, onLand: land };
    if (prev) prev(); // a rain already running hands over; its hook still fires once
    this.kick();
  }

  private stopRain(): void {
    const h = this.rain.onLand;
    this.rain.on = false;
    this.rain.onLand = undefined;
    if (h) h();
  }

  // ---------- simulation ----------

  private step(p: Part, dt: number): boolean {
    switch (p.type) {
      case "fly":
      case "bigfly": {
        if (p.kind === "note") {
          const tr = p.tr.length >= 3 ? (p.tr.pop() as Trail) : { x: 0, y: 0, rz: 0, fp: 0 };
          tr.x = p.x; tr.y = p.y; tr.rz = p.rz; tr.fp = p.fp;
          p.tr.unshift(tr);
        }
        p.t += dt;
        const u = Math.min(1, p.t / p.dur), e = easeOutQuart(u);
        p.x = bezierAt(p.x0, p.cx, p.x1, e);
        p.y = bezierAt(p.y0, p.cy, p.y1, e);
        p.y += Math.sin(Math.min(1, u / 0.16) * Math.PI) * (p.kind === "note" ? 6 : 11) * (1 - u);
        p.fp += p.fs * dt;
        p.tp += p.ts * dt;
        p.rz = Math.sin(p.t * 14) * 0.25;
        if (u >= 1) {
          const fx = p.fx;
          p.fx = undefined;
          if (fx) fx();
          return false; // kill() fires the caller's onLand
        }
        return true;
      }
      case "note": {
        p.age += dt;
        p.vy += p.grav * dt;
        if (p.vy > p.term) p.vy -= (p.vy - p.term) * Math.min(1, 5 * dt);
        p.vx *= 1 - Math.min(1, 1.1 * dt);
        p.x += p.vx * dt + Math.sin(p.age * p.swF + p.ph) * p.sw * dt + this.wind * p.wd * dt;
        p.y += p.vy * dt;
        p.fp += p.fs * dt;
        p.tp += p.ts * dt;
        p.rz += p.rzv * dt;
        if (p.z >= 1 && p.gl <= 0 && Math.random() < 0.004 && Math.abs(Math.cos(p.fp)) > 0.8) p.gl = 0.16;
        if (p.gl > 0) p.gl -= dt;
        return p.age < p.life && p.y < this.H + 50 && p.x > -200 && p.x < this.W + 200;
      }
      case "ring":
        p.age += dt;
        return p.age < p.life;
      case "rig": {
        p.t += dt;
        const q = p.t;
        if (q >= 0.5 && !p.fired[0]) {
          p.fired[0] = true;
          this.pourNotes(p.x, p.y - 8, 130, 1.2, 170, 430, 0, 540);
          this.spark(p.x, p.y, K.amber, 22, 280, 0.9);
          this.ring(p.x, p.y - 10, 54, K.amber, 0.4, 2);
        }
        if (q >= 0.98 && !p.fired[1]) {
          p.fired[1] = true;
          this.pourNotes(p.x, p.y - 8, 100, 1.45, 150, 460, 0, 540);
          this.spark(p.x, p.y, K.amber, 18, 260, 0.9);
        }
        if (q >= 1.42 && !p.fired[2]) {
          p.fired[2] = true;
          this.pourNotes(p.x, p.y - 8, 80, 1.5, 150, 480, 0, 540);
          this.spark(p.x, p.y, K.amber, 16, 240, 0.9);
        }
        if (q > 0.5 && q < 1.8 && Math.random() < 0.7) this.spark(p.x + (Math.random() - 0.5) * 40, p.y - 6, K.amber, 1, 140, 0.7);
        return q < 2.7;
      }
      case "spark":
        p.age += dt;
        p.vy += 260 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.rot != null && p.rotv != null) p.rot += p.rotv * dt;
        return p.age < p.life;
    }
  }

  private rainStep(dt: number): void {
    const r = this.rain;
    if (!r.on) {
      r.beam = Math.max(0, r.beam - dt * 1.2);
      this.wind *= Math.max(0, 1 - dt * 1.5);
      return;
    }
    r.t += dt;
    const t = r.t;
    if (r.onLand && t >= RAIN_LAND_AT) { const h = r.onLand; r.onLand = undefined; h(); }
    this.wind = windAt(t);
    r.beam = beamAt(t);
    if (t >= RAIN_SECONDS) { this.stopRain(); return; }
    r.acc += rainRate(t) * dt * (this.slow > 10 ? 0.6 : 1) * (this.video ? 0.65 : 1);
    const cap = this.cap();
    let guard = 0;
    while (r.acc >= 1 && guard++ < 20) {
      r.acc--;
      if (this.notes >= cap) continue;
      const rz = Math.random(), z = rz < 0.3 ? 0.55 : rz < 0.7 ? 0.85 : 1.25, far = z < 1;
      const n = this.mkNote(Math.random() * this.W, -28 * z, pickVariant(Math.random()), {
        vy: (90 + Math.random() * 90) * (far ? 0.7 : z), vx: (Math.random() - 0.5) * 36, z, sw: (20 + Math.random() * 26) * z, life: 6.5, grav: 55,
        term: (130 + Math.random() * 80) * (far ? 0.7 : 1.15), wd: far ? 0.5 : 1.1,
      });
      n.al = far ? 0.5 + z * 0.3 : 1;
      if (!this.add(n)) continue;
      if (Math.random() < 0.4) {
        this.add({ type: "spark", x: Math.random() * this.W, y: -10, vx: (Math.random() - 0.5) * 30, vy: 60 + Math.random() * 80, age: 0, life: 3.5, col: Math.random() < 0.5 ? K.amber : K.violet, size: 2.4, rot: 0, rotv: (Math.random() - 0.5) * 8, ph: Math.random() * 6, tw: true, delay: 0 });
      }
    }
    if (r.acc >= 1) r.acc = 0; // never carry a backlog into the next frame (no jank spiral)
  }

  // ---------- drawing ----------

  private buildSprites(): void {
    const d = this.dpr;
    this.sprites = ([0, 1, 2] as NoteVariant[]).map((v) => ({ f: noteArt(NW, NH, { dpr: d, variant: v }), b: noteArt(NW, NH, { dpr: d, variant: v, back: true }) }));
    const bh = (BIG_W * 140) / 240;
    this.bundleS = bundleArt(BIG_W, bh, d);
    this.bagS = bagArt(BIG_W, bh, d, 0);
    this.bagO = bagArt(BIG_W, bh, d, 1);
    this.spritesDpr = d;
  }

  private sprite(p: SpriteLike, alpha: number): void {
    const g = this.g, set = this.sprites[p.v];
    if (!g || !set) return;
    const d = this.dpr, cs = Math.cos(p.fp), spr = cs >= 0 ? set.f : set.b, ax = Math.max(0.14, Math.abs(cs)), tm = 0.9 + 0.1 * Math.cos(p.tp || 0);
    // Every save() has its restore() in a finally: a throw in drawImage can never leave the state stack unbalanced.
    g.save();
    try {
      g.setTransform(d, 0, 0, d, 0, 0);
      if (p.sh) {
        g.globalAlpha = alpha * 0.2 * ax;
        g.fillStyle = "#000";
        g.translate(p.x + 5 * p.s, p.y + 9 * p.s);
        g.rotate(p.rz);
        g.scale(ax * p.s, p.s * tm);
        g.fillRect(-NW / 2, -NH / 2, NW, NH);
        g.setTransform(d, 0, 0, d, 0, 0);
      }
      g.translate(p.x, p.y);
      g.rotate(p.rz);
      g.scale(ax * p.s, p.s * tm);
      g.globalAlpha = alpha * (0.72 + 0.28 * Math.abs(cs));
      g.drawImage(spr, -NW / 2, -NH / 2, NW, NH);
      if (ax < 0.34) {
        g.globalAlpha = alpha * (0.34 - ax) * 2.2;
        g.fillStyle = K.white;
        g.fillRect(-NW / 2, -NH / 2, NW, NH);
      }
    } finally {
      g.restore();
    }
    if (p.gl && p.gl > 0) {
      g.save();
      try {
        g.setTransform(d, 0, 0, d, 0, 0);
        const gx = p.x + NW * 0.32 * p.s, gy = p.y - NH * 0.3 * p.s, gs = 7 * p.s * (p.gl / 0.16);
        g.globalAlpha = alpha * Math.min(1, p.gl * 9);
        g.fillStyle = K.white;
        g.fillRect(gx - gs, gy - 0.7, gs * 2, 1.4);
        g.fillRect(gx - 0.7, gy - gs, 1.4, gs * 2);
      } finally {
        g.restore();
      }
    }
  }

  /** Paint one particle. Every case that saves the context restores it in a finally (balanced even when a draw throws). */
  private paint(p: Part): void {
    const g = this.g;
    if (!g) return;
    if (p.type === "fly") {
      for (let k = p.tr.length - 1; k >= 0; k--) {
        const t0 = p.tr[k];
        this.sprite({ x: t0.x, y: t0.y, rz: t0.rz, fp: t0.fp, s: 1, v: p.v, tp: p.tp, sh: false }, 0.16 - 0.045 * k);
      }
      this.sprite(p, 1);
      return;
    }
    if (p.type === "note") {
      this.sprite(p, Math.max(0, Math.min(1, (p.life - p.age) / 0.5)) * p.al);
      return;
    }
    g.save();
    try {
      this.paintSaved(g, p);
    } finally {
      g.restore();
    }
  }

  /** The cases that draw straight on the context; the caller (paint) holds save() and restores in a finally. */
  private paintSaved(g: CanvasRenderingContext2D, p: Part): void {
    const d = this.dpr;
    switch (p.type) {
      case "bigfly": {
        const u = Math.min(1, p.t / p.dur), bag = p.kind === "bag", sp = bag ? this.bagS : this.bundleS;
        if (!sp) return;
        g.setTransform(d, 0, 0, d, 0, 0);
        g.globalAlpha = 0.25 * u;
        g.fillStyle = "#000";
        g.beginPath();
        g.ellipse(p.x + 4, p.y + 34, 34, 8, 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        g.translate(p.x, p.y);
        g.rotate(bag ? Math.sin(p.t * 9) * 0.35 * (1 - u) + 0.08 : Math.sin(p.t * 10) * 0.12);
        const pu = 1 + 0.07 * Math.sin(u * Math.PI);
        g.scale(pu, pu);
        const sh = sp.height / d;
        g.drawImage(sp, -BIG_W / 2, -sh / 2, BIG_W, sh);
        return;
      }
      case "ring": {
        const u = Math.max(0, Math.min(1, p.age / p.life)), e = easeOutQuart(u);
        g.setTransform(d, 0, 0, d, 0, 0);
        g.globalAlpha = Math.max(0, 1 - u) * 0.85;
        g.strokeStyle = p.col;
        g.lineWidth = p.lw * (1 - u) + 0.5;
        g.beginPath();
        g.arc(p.x, p.y, Math.max(1, 6 + (p.r1 - 6) * e), 0, Math.PI * 2);
        g.stroke();
        return;
      }
      case "rig": {
        const q = p.t;
        if (q < 0 || !this.bagS || !this.bagO) return;
        const sq = q < 0.24 ? Math.sin((q / 0.24) * Math.PI) : 0, sx = 1 + 0.12 * sq, sy = 1 - 0.16 * sq;
        const op = Math.max(0, Math.min(1, (q - 0.28) / 0.26));
        const shake = q > 0.46 && q < 1.9 ? Math.sin(q * 75) * 2.6 * (1 - Math.min(1, (q - 0.46) / 1.5)) : 0;
        const ex = q > 1.9 ? q - 1.9 : 0, al = 1 - Math.min(1, ex / 0.6);
        g.setTransform(d, 0, 0, d, 0, 0);
        g.globalAlpha = 0.25 * al;
        g.fillStyle = "#000";
        g.beginPath();
        g.ellipse(p.x + 4, p.y + 34, 36 * sx, 8, 0, 0, Math.PI * 2);
        g.fill();
        g.translate(p.x + shake, p.y + ex * ex * 520);
        g.rotate(ex * 2.4);
        g.scale(sx, sy);
        const hh = this.bagS.height / d;
        g.globalAlpha = (1 - op) * al;
        g.drawImage(this.bagS, -BIG_W / 2, -hh / 2, BIG_W, hh);
        g.globalAlpha = op * al;
        g.drawImage(this.bagO, -BIG_W / 2, -hh / 2, BIG_W, hh);
        return;
      }
      case "spark": {
        g.setTransform(d, 0, 0, d, 0, 0);
        const tw = p.tw ? 0.6 + 0.4 * Math.sin(p.age * 30 + p.ph) : 1;
        g.globalAlpha = Math.max(0, 1 - p.age / p.life) * tw;
        g.fillStyle = p.col;
        if (p.rot != null) {
          g.translate(p.x, p.y);
          g.rotate(p.rot);
          g.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size);
        } else {
          g.beginPath();
          g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          g.fill();
        }
        return;
      }
      default:
        return; // fly and note are painted through sprite(), which balances its own save/restore
    }
  }

  private beams(): void {
    const g = this.g, r = this.rain;
    if (!g || r.beam <= 0.01) return;
    g.save();
    try {
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      for (let b = 0; b < 3; b++) {
        const bx = this.W * (0.2 + 0.3 * b) + Math.sin(r.t * 0.5 + b * 2) * 40, sw = 26 + 10 * b;
        const gr = g.createLinearGradient(bx, 0, bx + 60, this.H * 0.8);
        gr.addColorStop(0, `rgba(${K.beamRgb},${0.17 * r.beam})`);
        gr.addColorStop(1, `rgba(${K.beamRgb},0)`);
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(bx - sw * 0.4, 0);
        g.lineTo(bx + sw * 0.4, 0);
        g.lineTo(bx + sw * 2.6 + 60, this.H * 0.8);
        g.lineTo(bx - sw * 2.2 + 60, this.H * 0.8);
        g.closePath();
        g.fill();
      }
    } finally {
      g.restore();
    }
  }
}
