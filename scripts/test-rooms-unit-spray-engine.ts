// Spray effects engine checks (no database, no real DOM):   npx tsx scripts/test-rooms-unit-spray-engine.ts   (or npm run test:rooms)
// Pure helpers first, then the engine itself against a stub canvas, a stub document and a hand-pumped
// requestAnimationFrame queue: caps, quiet mode, exactly-once onLand, no leaked frame loop after an exception,
// hidden tab, destroy().
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e?.message ?? e).split("\n")[0]}`); }
};

// ---------- stubs (installed before the engine is imported) ----------
const fault = { draw: false, clear: false };
function fakeCtx(): any {
  const grad = { addColorStop() { /* noop */ } };
  const t: Record<string | symbol, unknown> = { createLinearGradient: () => grad, createRadialGradient: () => grad, measureText: () => ({ width: 0 }) };
  return new Proxy(t, {
    get(o, p) {
      if (p === "drawImage") return () => { if (fault.draw) throw new Error("draw failed"); };
      if (p === "clearRect") return () => { if (fault.clear) throw new Error("clear failed"); };
      if (p in o) return o[p];
      return () => { /* any other 2d call is a noop */ };
    },
    set(o, p, v) { o[p] = v; return true; },
  });
}
function fakeCanvas(): any {
  const ctx = fakeCtx();
  return { width: 0, height: 0, getContext: () => ctx };
}
type Listener = () => void;
const docListeners = new Map<string, Set<Listener>>();
const fakeDocument = {
  hidden: false,
  createElement: () => fakeCanvas(),
  addEventListener: (t: string, l: Listener) => { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t)!.add(l); },
  removeEventListener: (t: string, l: Listener) => { docListeners.get(t)?.delete(l); },
};
const listenerCount = () => [...docListeners.values()].reduce((n, s) => n + s.size, 0);
(globalThis as any).document = fakeDocument;

const frames = new Map<number, (ts: number) => void>();
let rafId = 0, clock = 1000;
(globalThis as any).requestAnimationFrame = (cb: (ts: number) => void) => { rafId++; frames.set(rafId, cb); return rafId; };
(globalThis as any).cancelAnimationFrame = (id: number) => { frames.delete(id); };
/** Run up to `max` frames `stepMs` apart (stepMs may be negative to fake a clock going backwards). Returns frames run. */
function pump(max: number, stepMs = 16.7, onFrame?: () => void): number {
  let n = 0;
  while (frames.size && n < max) {
    clock += stepMs;
    const batch = [...frames.entries()];
    frames.clear();
    for (const [, cb] of batch) cb(clock);
    n++;
    onFrame?.();
  }
  return n;
}

const E = await import("../client/src/components/rooms/spray/engine");
const { clampDt, rainRate, windAt, beamAt, bezierAt, noteCap, easeOutQuart, isSprayKind, SprayEngine, MAX_NOTES, MAX_NOTES_VIDEO, MAX_PARTICLES, SPRAY_KINDS } = E;

// ---------- pure helpers ----------
test("clampDt: first frame is 16 ms", () => assert.equal(clampDt(500, 0), 0.016));
test("clampDt: a clock going backwards gives 0, never negative", () => assert.equal(clampDt(100, 200), 0));
test("clampDt: a long gap is clamped to 33 ms", () => assert.equal(clampDt(10_000, 1000), 0.033));
test("clampDt: NaN and Infinity give the first-frame step", () => {
  assert.equal(clampDt(NaN, 100), 0.016);
  assert.equal(clampDt(100, NaN), 0.016);
  assert.equal(clampDt(Infinity, 100), 0.016);
});
test("clampDt: never negative and never above 33 ms (fuzz)", () => {
  for (let i = 0; i < 5000; i++) {
    const d = clampDt((Math.random() - 0.3) * 1e5, (Math.random() - 0.3) * 1e5);
    assert.ok(d >= 0 && d <= 0.033 && Number.isFinite(d));
  }
});
test("rainRate(0) === 0", () => assert.equal(rainRate(0), 0));
test("rainRate(1.5) === 150", () => assert.equal(rainRate(1.5), 150));
test("rainRate(5) === 0", () => assert.equal(rainRate(5), 0));
test("rainRate ramps, holds and tapers", () => {
  assert.equal(rainRate(0.45), 75);
  assert.equal(rainRate(3.6), 150);
  assert.ok(rainRate(4.5) > 0 && rainRate(4.5) < 150);
  assert.equal(rainRate(-1), 0);
  assert.equal(rainRate(NaN), 0);
  assert.equal(rainRate(99), 0);
  for (let t = 0; t < 6; t += 0.01) assert.ok(rainRate(t) >= 0 && rainRate(t) <= 150);
});
test("windAt is finite and bounded", () => {
  for (let t = 0; t < 20; t += 0.05) assert.ok(Math.abs(windAt(t)) <= 73);
  assert.equal(windAt(NaN), 0);
});
test("beamAt ramps to 1 and fades to 0", () => {
  assert.equal(beamAt(0), 0);
  assert.equal(beamAt(2), 1);
  assert.equal(beamAt(5.4), 0);
  assert.ok(beamAt(0.45) > 0.49 && beamAt(0.45) < 0.51);
});
test("bezierAt: ends, middle and clamping", () => {
  assert.equal(bezierAt(0, 10, 20, 0), 0);
  assert.equal(bezierAt(0, 10, 20, 1), 20);
  assert.equal(bezierAt(0, 10, 20, 0.5), 10);
  assert.equal(bezierAt(0, -100, 0, 0.5), -50);
  assert.equal(bezierAt(0, 10, 20, 2), 20);
  assert.equal(bezierAt(0, 10, 20, -1), 0);
  assert.equal(bezierAt(0, 10, 20, NaN), 0);
});
test("easeOutQuart: 0 to 1, monotonic", () => {
  assert.equal(easeOutQuart(0), 0);
  assert.equal(easeOutQuart(1), 1);
  let prev = -1;
  for (let u = 0; u <= 1; u += 0.01) { const e = easeOutQuart(u); assert.ok(e >= prev); prev = e; }
});
test("noteCap: 200, 120 with live video, never above, never negative", () => {
  assert.equal(MAX_NOTES, 200);
  assert.equal(MAX_NOTES_VIDEO, 120);
  assert.equal(noteCap(undefined, false), 200);
  assert.equal(noteCap(undefined, true), 120);
  assert.equal(noteCap(500, false), 200);
  assert.equal(noteCap(500, true), 120);
  assert.equal(noteCap(50, true), 50);
  assert.equal(noteCap(NaN, false), 200);
  assert.equal(noteCap(-3, false), 0);
});
test("kinds are note, bundle, bag, rain; the old n20/n50/n100 are gone", () => {
  assert.deepEqual([...SPRAY_KINDS], ["note", "bundle", "bag", "rain"]);
  for (const k of SPRAY_KINDS) assert.ok(isSprayKind(k));
  for (const k of ["n20", "n50", "n100", "", null, 1, "RAIN"]) assert.equal(isSprayKind(k), false);
});

// ---------- engine ----------
const make = (opts?: ConstructorParameters<typeof SprayEngine>[1]) => {
  const e = new SprayEngine(fakeCanvas(), opts);
  e.muted = true;
  e.setSize(390, 740, 2);
  return e;
};
const A = { x: 330, y: 700 }, B = { x: 195, y: 280 };
const settle = (_e: InstanceType<typeof SprayEngine>) => pump(5000, 33);
const reset = () => { frames.clear(); fault.draw = false; fault.clear = false; fakeDocument.hidden = false; };

test("note: onLand fires exactly once, then the loop goes idle with nothing left", () => {
  reset();
  const e = make();
  let lands = 0;
  e.spray("note", A, B, { onLand: () => lands++ });
  assert.ok(e.isRunning && e.liveCount > 0);
  settle(e);
  assert.equal(lands, 1);
  assert.equal(e.liveCount, 0);
  assert.equal(e.isRunning, false);
  assert.equal(frames.size, 0);
  e.destroy();
});

for (const kind of ["bundle", "bag", "rain"] as const) {
  test(`${kind}: onLand once, notes capped at 200 every frame, memory flat after`, () => {
    reset();
    const e = make();
    let lands = 0, maxNotes = 0, maxParts = 0;
    e.spray(kind, A, B, { onLand: () => lands++ });
    pump(5000, 16.7, () => { maxNotes = Math.max(maxNotes, e.noteCount); maxParts = Math.max(maxParts, e.liveCount); });
    assert.equal(lands, 1);
    assert.ok(maxNotes <= 200, `max notes ${maxNotes}`);
    assert.ok(maxParts <= MAX_PARTICLES + 1, `max particles ${maxParts}`);
    assert.ok(maxNotes > 0);
    assert.equal(e.liveCount, 0);
    assert.equal(e.noteCount, 0);
    assert.equal(e.isRunning, false);
    assert.equal(frames.size, 0);
    e.destroy();
  });
}

test("stress (3 rains, 4 bags, 6 bundles): never above 200 notes, ends idle, every onLand once", () => {
  reset();
  const e = make();
  let lands = 0, maxNotes = 0;
  const kinds = [...Array(3).fill("rain"), ...Array(4).fill("bag"), ...Array(6).fill("bundle")] as ("rain" | "bag" | "bundle")[];
  for (const k of kinds) e.spray(k, A, B, { onLand: () => lands++ });
  pump(10000, 16.7, () => { maxNotes = Math.max(maxNotes, e.noteCount); });
  assert.ok(maxNotes <= 200, `max notes ${maxNotes}`);
  assert.equal(lands, kinds.length);
  assert.equal(e.isRunning, false);
  assert.equal(frames.size, 0);
  e.destroy();
});

test("live video on screen: never above 120 notes", () => {
  reset();
  const e = make({ videoActive: () => true });
  let maxNotes = 0;
  e.spray("rain", A, B);
  e.spray("bag", A, B);
  pump(10000, 16.7, () => { maxNotes = Math.max(maxNotes, e.noteCount); });
  assert.ok(maxNotes <= 120 && maxNotes > 0, `max notes ${maxNotes}`);
  e.destroy();
});

test("a throwing videoActive is treated as no video, never breaks the loop", () => {
  reset();
  const e = make({ videoActive: () => { throw new Error("x"); } });
  let lands = 0;
  e.spray("bundle", A, B, { onLand: () => lands++ });
  settle(e);
  assert.equal(lands, 1);
  assert.equal(e.isRunning, false);
  e.destroy();
});

test("quiet: no particles, no frame scheduled, onLand at once", () => {
  reset();
  const e = make();
  e.quiet = true;
  let lands = 0;
  for (const k of SPRAY_KINDS) e.spray(k, A, B, { onLand: () => lands++ });
  assert.equal(lands, 4);
  assert.equal(e.liveCount, 0);
  assert.equal(e.isRunning, false);
  assert.equal(frames.size, 0);
  e.destroy();
});

test("a particle that throws while painting is dropped, onLand still fires once, no leaked loop", () => {
  reset();
  const e = make();
  fault.draw = true;
  let lands = 0;
  e.spray("note", A, B, { onLand: () => lands++ });
  e.spray("bag", A, B, { onLand: () => lands++ });
  settle(e);
  assert.equal(lands, 2);
  assert.equal(e.liveCount, 0);
  assert.equal(e.isRunning, false);
  assert.equal(frames.size, 0);
  e.destroy();
});

test("a frame that fails outside the particles stops cleanly after 3 tries (no spin), hooks fire", () => {
  reset();
  const e = make();
  let lands = 0;
  e.spray("rain", A, B, { onLand: () => lands++ });
  fault.clear = true;
  const n = pump(100, 16.7);
  assert.ok(n <= 3, `frames after failure ${n}`);
  assert.equal(lands, 1);
  assert.equal(e.isRunning, false);
  assert.equal(frames.size, 0);
  assert.equal(e.liveCount, 0);
  e.destroy();
});

test("a throwing onLand hook never breaks the engine", () => {
  reset();
  const e = make();
  e.spray("bundle", A, B, { onLand: () => { throw new Error("ui bug"); } });
  let lands = 0;
  e.spray("note", A, B, { onLand: () => lands++ });
  settle(e);
  assert.equal(lands, 1);
  assert.equal(e.isRunning, false);
  e.destroy();
});

test("clock going backwards: nothing turns NaN, the effect still finishes", () => {
  reset();
  const e = make();
  let lands = 0;
  e.spray("bundle", A, B, { onLand: () => lands++ });
  pump(20, -50); // dt is 0 on every one of these frames
  assert.equal(lands, 0);
  settle(e);
  assert.equal(lands, 1);
  assert.equal(e.isRunning, false);
  e.destroy();
});

test("tab hidden: everything dropped, loop stopped, pending onLand fired; sprays while hidden do not animate", () => {
  reset();
  const e = make();
  let lands = 0;
  e.spray("rain", A, B, { onLand: () => lands++ });
  e.spray("note", A, B, { onLand: () => lands++ });
  pump(3, 16.7);
  fakeDocument.hidden = true;
  for (const l of docListeners.get("visibilitychange") ?? []) l();
  assert.equal(lands, 2);
  assert.equal(e.liveCount, 0);
  assert.equal(e.isRunning, false);
  assert.equal(frames.size, 0);
  e.spray("bag", A, B, { onLand: () => lands++ });
  assert.equal(lands, 3);
  assert.equal(e.liveCount, 0);
  assert.equal(frames.size, 0);
  e.destroy();
});

test("destroy(): cancels the scheduled frame, removes listeners, ignores later sprays", () => {
  reset();
  const before = listenerCount();
  const e = make();
  assert.equal(listenerCount(), before + 1);
  e.spray("rain", A, B);
  pump(2, 16.7);
  assert.equal(frames.size, 1);
  e.destroy();
  assert.equal(frames.size, 0);
  assert.equal(listenerCount(), before);
  assert.equal(e.isRunning, false);
  assert.equal(e.liveCount, 0);
  let lands = 0;
  e.spray("note", A, B, { onLand: () => lands++ });
  assert.equal(lands, 0);
  assert.equal(frames.size, 0);
  e.destroy(); // twice is fine
});

test("bad input: unknown kind ignored, non-finite points fall back, size 0 skips animation", () => {
  reset();
  const e = make();
  e.spray("n20" as any, A, B);
  assert.equal(e.liveCount, 0);
  let lands = 0;
  e.spray("note", { x: NaN, y: Infinity }, { x: NaN, y: 1 }, { onLand: () => lands++ });
  settle(e);
  assert.equal(lands, 1);
  const z = new SprayEngine(fakeCanvas());
  z.spray("rain", A, B, { onLand: () => lands++ });
  assert.equal(lands, 2);
  assert.equal(z.isRunning, false);
  z.destroy();
  e.destroy();
});

test("art and engine sources carry no currency sign, denomination or banknote wording", () => {
  for (const f of ["art.ts", "engine.ts", "sound.ts", "SprayLayer.tsx"]) {
    const src = readFileSync(fileURLToPath(new URL(`../client/src/components/rooms/spray/${f}`, import.meta.url)), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(!code.includes("₦"), `${f} has a naira sign`);
    assert.ok(!/LEGAL TENDER|No\. 0|fillText\(String\(/i.test(code), `${f} has banknote wording`);
    assert.ok(!/\bn20\b|\bn50\b|\bn100\b/.test(code), `${f} still mentions old tiers`);
    assert.ok(!/\bcash\b/i.test(code), `${f} says cash`);
    assert.ok(!src.includes("—"), `${f} has an em dash`);
  }
  const tokens = readFileSync(fileURLToPath(new URL("../client/src/lib/sprayTokens.ts", import.meta.url)), "utf8");
  assert.ok(!tokens.includes("₦") && !tokens.includes("—"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
