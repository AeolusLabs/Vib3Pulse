// Spray sounds, synthesised with WebAudio (no files). Ported from notes.html.
// The AudioContext is created lazily and only by `snd.unlock()`, which must be called from a user gesture
// (a tap on Spray, a tray button). Until then every sound is a silent no-op, so nothing autoplays and the
// browser never logs an autoplay warning. `snd.muted` silences everything; the engine also gates on its own
// `muted`. One shared context for the page; never created at import time.

type AC = AudioContext;
let ctx: AC | null = null;

function live(): AC | null {
  if (!ctx || snd.muted) return null;
  if (ctx.state !== "running") return null;
  return ctx;
}

function noise(dur: number, f: number, q: number, vol: number, start = 0, type: BiquadFilterType = "bandpass", f2?: number) {
  const a = live();
  if (!a) return;
  const n = Math.max(1, Math.floor(a.sampleRate * dur));
  const b = a.createBuffer(1, n, a.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  const src = a.createBufferSource();
  src.buffer = b;
  const fl = a.createBiquadFilter();
  fl.type = type;
  const t = a.currentTime + start;
  fl.frequency.setValueAtTime(f, t);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
  fl.Q.value = q;
  const gn = a.createGain();
  gn.gain.value = vol;
  src.connect(fl);
  fl.connect(gn);
  gn.connect(a.destination);
  src.onended = () => { try { src.disconnect(); fl.disconnect(); gn.disconnect(); } catch { /* already gone */ } };
  src.start(t);
}

function tone(f: number, start: number, dur: number, vol: number, type: OscillatorType = "sine", f2?: number) {
  const a = live();
  if (!a) return;
  const o = a.createOscillator(), gn = a.createGain(), t = a.currentTime + start;
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  gn.gain.setValueAtTime(0.0001, t);
  gn.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(gn);
  gn.connect(a.destination);
  o.onended = () => { try { o.disconnect(); gn.disconnect(); } catch { /* already gone */ } };
  o.start(t);
  o.stop(t + dur + 0.05);
}

function thump(vol: number, start = 0) {
  const a = live();
  if (!a) return;
  const o = a.createOscillator(), gn = a.createGain(), t = a.currentTime + start;
  o.frequency.setValueAtTime(90, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.45);
  gn.gain.setValueAtTime(vol, t);
  gn.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  o.connect(gn);
  gn.connect(a.destination);
  o.onended = () => { try { o.disconnect(); gn.disconnect(); } catch { /* already gone */ } };
  o.start(t);
  o.stop(t + 0.55);
}

const safe = (fn: () => void) => () => { try { fn(); } catch { /* sound is never allowed to break a spray */ } };

export const snd = {
  muted: false,
  /** Call from a user gesture. Creates (or resumes) the shared AudioContext. Safe to call many times. */
  unlock(): void {
    try {
      if (typeof window === "undefined") return;
      if (!ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        ctx = new Ctor();
      }
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    } catch { ctx = null; }
  },
  /** True once a gesture has unlocked audio. */
  get ready(): boolean { return !!ctx && ctx.state === "running"; },
  note: safe(() => { noise(0.07, 3000, 1.6, 0.12); tone(1900, 0, 0.08, 0.05, "triangle", 1100); }),
  bundle: safe(() => {
    for (let i = 0; i < 12; i++) noise(0.028, 3400, 2, 0.09, i * 0.024);
    noise(0.05, 6000, 0.8, 0.12, 0.3, "highpass");
    thump(0.24, 0.34);
    tone(660, 0.34, 0.22, 0.04, "triangle", 330);
  }),
  bag: safe(() => {
    tone(180, 0, 0.5, 0.05, "sine", 90);
    noise(0.4, 900, 1.2, 0.12, 0.45, "bandpass", 5200);
    for (let i = 0; i < 9; i++) noise(0.012, 5600, 3, 0.1, 0.45 + i * 0.04);
    thump(0.3, 0.72);
    for (const t of [0.8, 1.2, 1.62]) { noise(0.3, 2400, 1, 0.11, t); tone(900, t, 0.18, 0.03, "triangle", 500); }
  }),
  rain: safe(() => {
    thump(0.36, 0);
    noise(0.5, 900, 0.8, 0.1, 0.05);
    noise(1.9, 5200, 0.6, 0.08, 0.1, "highpass");
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.15 + i * 0.12, 0.55, 0.05, "sine"));
  }),
};
