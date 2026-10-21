// The room's spray effects (task 5.9 side of the lane D engine). Effects play from the server's room:spray events in
// state.sprays, so the payer and everyone else see the same thing; never from a tap. New ids only, and only recent ones,
// so a reconnect never replays an old pour. Quiet effects (a per-viewer setting kept in this browser) and reduced motion
// replace the animation with a short chip; the chat line is the server's own (room:chat), never made here.
//
// Screen effects from docs/design/rooms-2026-10/notes.html (fix round FC, ruling 9), all driven by room:spray:
// - the flash: a warm radial flash where a bundle, bag or rain lands (380 ms);
// - the avatar bump: the recipient's avatar scales 1 -> 1.1 -> 0.97 -> 1 (380 ms) when a note, bundle or bag lands;
// - rain only: the room dims to 70% (50% over live video) with a clear spotlight on the recipient (260 ms in), and a
//   banner slides up from the dock with the payer and recipient and a V3C counter running to the rain's V3C value; both go
//   at 5.6 s;
// - the recipient (only) is then offered "Say thank you" (after a bag lands, or 5.9 s into rain). Tapping it sends a real
//   chat line from them; nothing is ever said on their behalf.
// None of it blocks input (pointer-events none everywhere except the thank-you button itself), none of it plays under
// Quiet effects or reduced motion (the chip and the server's chat line instead), and none of it shows a naira sign: the
// counter counts V3C only.
// Coordinates: from the payer's avatar (or the bottom middle when they are not drawn) to the recipient's avatar (or the
// upper middle), measured against this layer's own box.
import { useCallback, useEffect, useRef, useState } from "react";
import SprayLayer from "./SprayLayer";
import type { SprayEngine } from "./engine";
import { Button } from "@/components/ui/button";
import { HeartIcon } from "@/components/ui/icons";
import type { SprayEvent } from "@/lib/roomReducer";
import { AMBER } from "@/lib/roomTickets";
import { formatV3c } from "@shared/money";
import {
  RAIN_FX, SPRAY_COPY, SPRAY_SCREEN_FX, THANK_OFFER_MS, animateSprays, counterAt, newSprays, rainBannerText, sprayChipText, thankYouText,
} from "@/lib/sprayUi";

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
const avatarEl = (userId: string) => document.querySelector<HTMLElement>(`[data-testid="avatar-${esc(userId)}"], [data-testid="strip-${esc(userId)}"]`);
const EASE = "cubic-bezier(.23,1,.32,1)";
type Pt = { x: number; y: number };

interface Props {
  sprays: readonly SprayEvent[];
  nameOf(userId: string): string;
  quiet: boolean;
  /** server clock minus client clock (state.serverOffsetMs), so "recent" is judged on the server's clock. */
  serverOffsetMs: number;
  /** True while a live video is on screen: the engine lowers its note cap to 120 and the rain dim is lighter. */
  videoActive(): boolean;
  /** The viewer: the recipient of a big spray is offered a thank-you; the payer's own banner says "You". */
  selfId?: string | null;
  /** Send a chat line as the viewer (the thank-you). Absent (muted, listen-only): no thank-you is offered. */
  onThank?(text: string): void;
  /** Cap on simultaneous spray notes (a game room keeps it low: several feeds are already playing). Default: the engine's own cap. */
  maxNotes?: number;
}

export default function SprayEffects({ sprays, nameOf, quiet, serverOffsetMs, videoActive, selfId = null, onThank, maxNotes }: Props) {
  const engineRef = useRef<SprayEngine | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);
  const counterRaf = useRef(0);
  const reduced = useReducedMotion();
  // Everything already in the list when the room opened counts as seen: it happened before you looked.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(sprays.map((s) => s.id));
  const [chips, setChips] = useState<{ id: string; text: string }[]>([]);
  const [dim, setDim] = useState<{ x: number; y: number; on: boolean; video: boolean }>({ x: 0, y: 0, on: false, video: false });
  const [banner, setBanner] = useState<{ id: string; sub: string; who: string; label: string; total: number; on: boolean } | null>(null);
  const [thank, setThank] = useState<{ id: string; text: string; label: string } | null>(null);
  const rainGen = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    if (counterRaf.current && typeof cancelAnimationFrame === "function") cancelAnimationFrame(counterRaf.current);
  }, []);
  const later = (fn: () => void, ms: number) => { const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms); timers.current.add(t); };
  const names = useRef(nameOf);
  names.current = nameOf;
  const thankRef = useRef(onThank);
  thankRef.current = onThank;

  useEffect(() => {
    const e = engineRef.current;
    if (e) { e.quiet = quiet; e.muted = quiet; }
  }, [quiet]);

  // Quiet effects switched on (or reduced motion) mid-rain: the dim and the banner go at once.
  useEffect(() => {
    if (!animateSprays({ quiet, reducedMotion: reduced })) { rainGen.current++; setDim((d) => ({ ...d, on: false })); setBanner(null); }
  }, [quiet, reduced]);

  useEffect(() => {
    const done = seen.current!;
    const fresh = newSprays(sprays, done, Date.now() + serverOffsetMs);
    sprays.forEach((s) => done.add(s.id));
    if (done.size > 200) { const keep = new Set(sprays.map((s) => s.id)); seen.current = keep; }
    if (!fresh.length) return;
    const animate = animateSprays({ quiet, reducedMotion: reduced });
    const rect = box.current?.getBoundingClientRect();
    const at = (userId: string, fallback: Pt): Pt => {
      if (!rect) return fallback;
      const r = avatarEl(userId)?.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return fallback;
      return { x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top };
    };
    const chip = (s: SprayEvent) => {
      const text = sprayChipText(s.tier, names.current(s.fromId), names.current(s.toId));
      setChips((c) => [...c.slice(-2), { id: s.id, text }]);
      later(() => setChips((c) => c.filter((x) => x.id !== s.id)), 3500);
    };
    const flash = (p: Pt, a: number) => {
      const el = flashRef.current;
      if (!el || !(a > 0) || typeof el.animate !== "function") return;
      el.style.background = `radial-gradient(circle at ${Math.round(p.x)}px ${Math.round(p.y)}px, rgba(255,244,214,.95) 0, rgba(245,184,61,.35) 24%, rgba(245,184,61,0) 60%)`;
      try { el.animate([{ opacity: a }, { opacity: 0 }], { duration: 380, easing: EASE }); } catch { /* an effect never breaks the room */ }
    };
    const bump = (userId: string) => {
      const el = avatarEl(userId);
      if (!el || typeof el.animate !== "function") return;
      try { el.animate([{ transform: "scale(1)" }, { transform: "scale(1.1)", offset: 0.3 }, { transform: "scale(.97)", offset: 0.6 }, { transform: "scale(1)" }], { duration: 380, easing: EASE }); } catch { /* ignore */ }
    };
    const offerThanks = (s: SprayEvent) => {
      if (!selfId || s.toId !== selfId || s.fromId === selfId || !SPRAY_SCREEN_FX[s.tier].thank || !thankRef.current) return;
      const from = names.current(s.fromId);
      setThank({ id: s.id, text: thankYouText(from), label: `${SPRAY_COPY.thankYou} to ${from}` });
      later(() => setThank((t) => (t && t.id === s.id ? null : t)), THANK_OFFER_MS);
    };
    const runCounter = (total: number) => {
      if (typeof requestAnimationFrame !== "function") return;
      if (counterRaf.current) cancelAnimationFrame(counterRaf.current);
      const t0 = performance.now();
      const step = (now: number) => {
        const elapsed = now - t0;
        const el = counterRef.current;
        if (el) el.textContent = formatV3c(counterAt(total, elapsed));
        counterRaf.current = elapsed < RAIN_FX.counterMs || !el ? requestAnimationFrame(step) : 0;
      };
      counterRaf.current = requestAnimationFrame(step);
    };
    const rain = (s: SprayEvent, to: Pt, w: number) => {
      const gen = ++rainGen.current;
      const from = names.current(s.fromId), toName = names.current(s.toId);
      const t = rainBannerText(from, toName, !!selfId && s.fromId === selfId);
      let video = false;
      try { video = !!videoActive(); } catch { video = false; }
      setDim({ x: to.x, y: to.y, on: true, video });
      setBanner({ id: s.id, sub: t.sub, who: t.who, label: t.label, total: s.v3c, on: true });
      runCounter(s.v3c);
      flash(to, SPRAY_SCREEN_FX.rain.flash);
      later(() => { if (rainGen.current === gen) { setDim((d) => ({ ...d, on: false })); setBanner((b) => (b && b.id === s.id ? { ...b, on: false } : b)); } }, RAIN_FX.offMs);
      later(() => { setBanner((b) => (b && b.id === s.id && !b.on ? null : b)); }, RAIN_FX.offMs + 240);
      later(() => { bump(s.toId); offerThanks(s); }, RAIN_FX.thankMs);
      return () => { bump(s.toId); flash({ x: w / 2, y: 70 }, 0.32); }; // when the rain "lands" (0.9 s)
    };

    for (const s of fresh) {
      const w = rect?.width ?? 0, h = rect?.height ?? 0;
      const from = at(s.fromId, { x: w / 2, y: Math.max(0, h - 60) });
      const to = at(s.toId, { x: w / 2, y: h * 0.3 });
      const eng = engineRef.current;
      if (!animate || !eng) {
        chip(s);
        offerThanks(s);
        if (eng) { try { eng.spray(s.tier, from, to); } catch { /* the chip already says it */ } }
        continue;
      }
      const fx = SPRAY_SCREEN_FX[s.tier];
      const onLand = s.tier === "rain"
        ? rain(s, to, w)
        : () => {
          bump(s.toId);
          if (fx.flash > 0) flash(s.tier === "bag" ? { x: to.x, y: Math.max(to.y - 52, 40) } : s.tier === "bundle" ? { x: to.x, y: to.y - 30 } : to, fx.flash);
          if (s.tier === "bag") offerThanks(s);
        };
      try { eng.spray(s.tier, from, to, { onLand }); } catch { chip(s); offerThanks(s); }
    }
  }, [sprays]); // eslint-disable-line react-hooks/exhaustive-deps

  const dimOpacity = dim.on ? (dim.video ? RAIN_FX.dimOpacityVideo : RAIN_FX.dimOpacity) : 0;
  return (
    <>
      <div ref={box} className="pointer-events-none absolute inset-0 z-[12] overflow-hidden" aria-hidden data-testid="spray-effects">
        <div className="pointer-events-none absolute inset-0 transition-opacity duration-[260ms] ease-out" data-testid="spray-dim" data-on={dim.on ? "1" : "0"}
          style={{ opacity: dimOpacity, background: `radial-gradient(circle at ${Math.round(dim.x)}px ${Math.round(dim.y)}px, transparent 0, transparent 54px, rgb(5 3 10) 190px)` }} />
        <div ref={flashRef} className="pointer-events-none absolute inset-0 opacity-0" data-testid="spray-flash" />
        <SprayLayer engineRef={engineRef} videoActive={videoActive} maxNotes={maxNotes} />
        <div className="absolute inset-x-0 bottom-[calc(150px+env(safe-area-inset-bottom,0px))] flex flex-col items-center gap-1.5 px-4">
          {chips.map((c) => <p key={c.id} className={`${AMBER.chip} max-w-full truncate px-3 py-1.5 text-sm shadow-lg`} data-testid="spray-chip">{c.text}</p>)}
        </div>
      </div>
      {banner && (
        // The rain banner: says once, politely, who is making it rain on whom; the counter itself is not read out.
        <div role="status" aria-live="polite"
          className={`pointer-events-none absolute inset-x-3 bottom-[calc(96px+env(safe-area-inset-bottom,0px))] z-[13] flex items-center justify-between gap-3 overflow-hidden rounded-2xl bg-secondary px-3.5 py-3 text-secondary-foreground shadow-xl ${banner.on ? "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-8 motion-safe:duration-300" : "motion-safe:animate-out motion-safe:fade-out motion-safe:slide-out-to-bottom-8 motion-safe:duration-200 opacity-0"}`}
          data-testid="spray-rain-banner" data-on={banner.on ? "1" : "0"}>
          <span className="sr-only">{banner.label}</span>
          <div className="min-w-0" aria-hidden>
            <small className="block truncate text-[13px] opacity-80">{banner.sub}</small>
            <b className="block truncate font-serif text-2xl leading-none">{banner.who}</b>
          </div>
          <span ref={counterRef} className="shrink-0 text-2xl font-bold leading-none tabular-nums" aria-hidden data-testid="spray-rain-counter">{formatV3c(0)}</span>
        </div>
      )}
      {thank && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(200px+env(safe-area-inset-bottom,0px))] z-[14] flex justify-center px-4" data-testid="spray-thank">
          <Button type="button" className={`pointer-events-auto min-h-[44px] rounded-full px-5 shadow-lg ${AMBER.button}`} aria-label={thank.label}
            onClick={() => { const t = thank; setThank(null); thankRef.current?.(t.text); }} data-testid="spray-thank-button">
            <HeartIcon size={16} aria-hidden /> <span className="ml-1.5">{SPRAY_COPY.thankYou}</span>
          </Button>
        </div>
      )}
    </>
  );
}
