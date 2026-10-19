// Dev-only: /dev/spray-fixture. Plays every spray effect on the real SprayLayer + SprayEngine with no server,
// no payment and no room. App.tsx only registers this route when import.meta.env.DEV, so production bundles
// drop the route and this chunk (same gate as RoomFixture).
// Shows a live particle counter, the note count, whether a frame loop is scheduled (it must go back to "idle"
// after every effect: no leaked rAF), and the average frame time of the last effect (QA: Rain under 33 ms on a
// 4x CPU throttle). Toggles: quiet effects, sound, live video on screen (note cap 120).
// Query: ?theme=dark|light
import { useEffect, useRef, useState } from "react";
import SprayLayer from "@/components/rooms/spray/SprayLayer";
import { SPRAY_KINDS, type SprayEngine, type SprayKind } from "@/components/rooms/spray/engine";
import { snd } from "@/components/rooms/spray/sound";

const LABELS: Record<SprayKind, string> = { note: "Throw a note", bundle: "Throw a bundle", bag: "Open a money bag", rain: "Make it rain" };
const STAGE = [
  { id: "cohost", name: "Dayo", colour: "#0f8f8a" },
  { id: "host", name: "Mara", colour: "#7c46d6" },
  { id: "guest", name: "Kemi", colour: "#c2410c" },
] as const;

export default function SprayFixture() {
  const engineRef = useRef<SprayEngine | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<string>("host");
  const [quiet, setQuiet] = useState(false);
  const [muted, setMuted] = useState(false);
  const [video, setVideo] = useState(false);
  const videoRef = useRef(video);
  videoRef.current = video;
  const [stats, setStats] = useState({ live: 0, notes: 0, running: false });
  const [landed, setLanded] = useState<string[]>([]);
  const [frameMs, setFrameMs] = useState<number | null>(null);
  const meter = useRef<{ raf: number; last: number; sum: number; n: number }>({ raf: 0, last: 0, sum: 0, n: 0 });

  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    const root = document.documentElement;
    const was = root.classList.contains("dark");
    if (theme === "dark" || theme === "light") root.classList.toggle("dark", theme === "dark");
    return () => { root.classList.toggle("dark", was); };
  }, []);

  useEffect(() => { if (engineRef.current) engineRef.current.quiet = quiet; }, [quiet]);
  useEffect(() => { if (engineRef.current) engineRef.current.muted = muted; snd.muted = muted; }, [muted]);

  useEffect(() => {
    const t = setInterval(() => {
      const e = engineRef.current;
      setStats(e ? { live: e.liveCount, notes: e.noteCount, running: e.isRunning } : { live: 0, notes: 0, running: false });
    }, 200);
    const m = meter.current;
    return () => { clearInterval(t); if (m.raf) cancelAnimationFrame(m.raf); m.raf = 0; };
  }, []);

  const startMeter = () => {
    const m = meter.current;
    if (m.raf) return;
    m.last = 0; m.sum = 0; m.n = 0;
    const loop = (ts: number) => {
      if (m.last) { m.sum += ts - m.last; m.n++; }
      m.last = ts;
      const e = engineRef.current;
      if (e && (e.isRunning || m.n < 2)) { m.raf = requestAnimationFrame(loop); return; }
      m.raf = 0;
      setFrameMs(m.n ? Math.round((m.sum / m.n) * 10) / 10 : null);
    };
    m.raf = requestAnimationFrame(loop);
  };

  const centreOf = (el: Element | null) => {
    const scene = sceneRef.current;
    if (!el || !scene) return { x: 0, y: 0 };
    const a = el.getBoundingClientRect(), b = scene.getBoundingClientRect();
    return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
  };

  const fire = (kind: SprayKind) => {
    snd.unlock(); // the click is the user gesture
    const e = engineRef.current;
    if (!e) return;
    e.quiet = quiet;
    e.muted = muted;
    const to = centreOf(stageRef.current?.querySelector(`[data-id="${target}"]`) ?? null);
    const from = centreOf(fromRef.current);
    const at = new Date().toLocaleTimeString();
    e.spray(kind, from, to, { onLand: () => setLanded((l) => [`${at} ${kind} landed on ${target}`, ...l].slice(0, 6)) });
    startMeter();
  };

  const stress = () => {
    for (let i = 0; i < 3; i++) fire("rain");
    for (let i = 0; i < 4; i++) fire("bag");
    for (let i = 0; i < 6; i++) fire("bundle");
  };

  const btn = "min-h-[44px] rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
  const toggle = (label: string, on: boolean, set: (v: boolean) => void) => (
    <button type="button" role="switch" aria-checked={on} onClick={() => set(!on)} className={`${btn} ${on ? "border-primary" : ""}`}>
      {label}: {on ? "on" : "off"}
    </button>
  );

  return (
    <div className="min-h-screen bg-background p-4 text-foreground">
      <h1 className="mb-1 text-lg font-semibold">Spray effects fixture</h1>
      <p className="mb-4 text-sm text-muted-foreground">Development only. Nothing is charged and nothing is sent to a server.</p>

      <div className="flex flex-col gap-4 md:flex-row">
        <div ref={sceneRef} className="relative h-[620px] w-full max-w-[390px] overflow-hidden rounded-xl border border-border bg-[#0f0c18]">
          {video && <div className="absolute inset-x-0 top-0 h-[220px] bg-gradient-to-br from-[#2a1d4a] to-[#0f3f3d]" aria-label="Pretend live video" />}
          <div ref={stageRef} className="absolute inset-x-0 top-[240px] flex justify-center gap-6">
            {STAGE.map((p) => (
              <button
                key={p.id}
                type="button"
                data-id={p.id}
                aria-pressed={target === p.id}
                aria-label={`${p.name}${target === p.id ? ", selected" : ""}`}
                onClick={() => setTarget(p.id)}
                className="flex min-h-[44px] min-w-[44px] flex-col items-center gap-1 text-xs text-white"
              >
                <span className={`block h-14 w-14 rounded-full ${target === p.id ? "ring-2 ring-[#f5b83d]" : ""}`} style={{ background: p.colour }} />
                {p.name}
              </button>
            ))}
          </div>
          <button ref={fromRef} type="button" tabIndex={-1} aria-hidden="true" className="absolute bottom-4 right-4 h-11 w-20 rounded-full bg-[#8a5ce6] text-sm font-semibold text-white">
            Spray
          </button>
          <SprayLayer engineRef={engineRef} className="z-10" videoActive={() => videoRef.current} />
        </div>

        <div className="flex max-w-md flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {SPRAY_KINDS.map((k) => (
              <button key={k} type="button" className={btn} onClick={() => fire(k)}>{LABELS[k]}</button>
            ))}
            <button type="button" className={btn} onClick={stress}>Stress: 3 rains, 4 bags, 6 bundles</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {toggle("Quiet effects", quiet, setQuiet)}
            {toggle("Sound off", muted, setMuted)}
            {toggle("Live video on screen", video, setVideo)}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" aria-live="polite">
            <dt className="text-muted-foreground">Live particles</dt><dd data-testid="live-count">{stats.live}</dd>
            <dt className="text-muted-foreground">Live notes (cap {video ? 120 : 200})</dt><dd data-testid="note-count">{stats.notes}</dd>
            <dt className="text-muted-foreground">Frame loop</dt><dd data-testid="loop-state">{stats.running ? "running" : "idle"}</dd>
            <dt className="text-muted-foreground">Average frame, last effect</dt><dd data-testid="frame-ms">{frameMs == null ? "none yet" : `${frameMs} ms`}</dd>
          </dl>
          <ul className="text-xs text-muted-foreground" data-testid="landed">
            {landed.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}
