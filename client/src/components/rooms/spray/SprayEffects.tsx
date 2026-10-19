// The room's spray effects (task 5.9 side of the lane D engine). Effects play from the server's room:spray events in
// state.sprays, so the payer and everyone else see the same thing; never from a tap. New ids only, and only recent ones,
// so a reconnect never replays an old pour. Quiet effects (a per-viewer setting kept in this browser) and reduced motion
// replace the animation with a short chip; the chat line is the server's own (room:chat), never made here.
// Coordinates: from the payer's avatar (or the bottom middle when they are not drawn) to the recipient's avatar (or the
// upper middle), measured against this layer's own box.
import { useCallback, useEffect, useRef, useState } from "react";
import SprayLayer from "./SprayLayer";
import type { SprayEngine } from "./engine";
import type { SprayEvent } from "@/lib/roomReducer";
import { AMBER } from "@/lib/roomTickets";
import { animateSprays, newSprays, sprayChipText } from "@/lib/sprayUi";

const QUIET_KEY = "vib3.rooms.sprayQuiet";

/** Quiet effects: a per-viewer convenience stored in this browser only. Storage can be missing; the default is off. */
export function useSprayQuiet(): [boolean, (on: boolean) => void] {
  const [quiet, setQuietState] = useState(() => { try { return window.localStorage.getItem(QUIET_KEY) === "1"; } catch { return false; } });
  const setQuiet = useCallback((on: boolean) => {
    setQuietState(on);
    try { if (on) window.localStorage.setItem(QUIET_KEY, "1"); else window.localStorage.removeItem(QUIET_KEY); } catch { /* kept for this visit only */ }
  }, []);
  return [quiet, setQuiet];
}

function useReducedMotion() {
  const [reduce, setReduce] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

const esc = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&"));

interface Props {
  sprays: readonly SprayEvent[];
  nameOf(userId: string): string;
  quiet: boolean;
  /** server clock minus client clock (state.serverOffsetMs), so "recent" is judged on the server's clock. */
  serverOffsetMs: number;
  /** True while a live video is on screen: the engine lowers its note cap to 120. */
  videoActive(): boolean;
}

export default function SprayEffects({ sprays, nameOf, quiet, serverOffsetMs, videoActive }: Props) {
  const engineRef = useRef<SprayEngine | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  // Everything already in the list when the room opened counts as seen: it happened before you looked.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(sprays.map((s) => s.id));
  const [chips, setChips] = useState<{ id: string; text: string }[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const names = useRef(nameOf);
  names.current = nameOf;

  useEffect(() => {
    const e = engineRef.current;
    if (e) { e.quiet = quiet; e.muted = quiet; }
  }, [quiet]);

  useEffect(() => {
    const done = seen.current!;
    const fresh = newSprays(sprays, done, Date.now() + serverOffsetMs);
    sprays.forEach((s) => done.add(s.id));
    if (done.size > 200) { const keep = new Set(sprays.map((s) => s.id)); seen.current = keep; }
    if (!fresh.length) return;
    const animate = animateSprays({ quiet, reducedMotion: reduced });
    const rect = box.current?.getBoundingClientRect();
    const at = (userId: string, fallback: { x: number; y: number }) => {
      if (!rect) return fallback;
      const el = document.querySelector<HTMLElement>(`[data-testid="avatar-${esc(userId)}"], [data-testid="strip-${esc(userId)}"]`);
      const r = el?.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return fallback;
      return { x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top };
    };
    const chip = (s: SprayEvent) => {
      const text = sprayChipText(s.tier, names.current(s.fromId), names.current(s.toId));
      setChips((c) => [...c.slice(-2), { id: s.id, text }]);
      const t = setTimeout(() => { timers.current.delete(t); setChips((c) => c.filter((x) => x.id !== s.id)); }, 3500);
      timers.current.add(t);
    };
    for (const s of fresh) {
      const w = rect?.width ?? 0, h = rect?.height ?? 0;
      const from = at(s.fromId, { x: w / 2, y: Math.max(0, h - 60) });
      const to = at(s.toId, { x: w / 2, y: h * 0.3 });
      const eng = engineRef.current;
      if (!animate || !eng) { chip(s); if (eng) { try { eng.spray(s.tier, from, to); } catch { /* the chip already says it */ } } continue; }
      try { eng.spray(s.tier, from, to); } catch { chip(s); }
    }
  }, [sprays]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-[12] overflow-hidden" aria-hidden data-testid="spray-effects">
      <SprayLayer engineRef={engineRef} videoActive={videoActive} />
      <div className="absolute inset-x-0 bottom-[calc(150px+env(safe-area-inset-bottom,0px))] flex flex-col items-center gap-1.5 px-4">
        {chips.map((c) => <p key={c.id} className={`${AMBER.chip} max-w-full truncate px-3 py-1.5 text-sm shadow-lg`} data-testid="spray-chip">{c.text}</p>)}
      </div>
    </div>
  );
}
