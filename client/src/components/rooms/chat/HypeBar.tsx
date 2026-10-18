import { useEffect, useState } from "react";
import { HYPE, type HypeStore } from "@/lib/hype";
import type { HypeBurstState } from "@/hooks/useHype";

const TICK_MS = 250;

/**
 * A 4 px bar above the composer. Decorative (the burst is announced by HypeBurst). It owns its own state and timer, so a
 * draining bar re-renders only this component. The timer stops while the tab is hidden; the value is recomputed from the
 * clock on return.
 */
export function HypeBar({ store }: { store: HypeStore }) {
  const [value, setValue] = useState(() => store.read());
  useEffect(() => {
    const sync = () => setValue(store.read());
    const off = store.subscribe(sync);
    sync();
    return off;
  }, [store]);
  const draining = value > 0;
  useEffect(() => {
    if (!draining) return;
    let t: ReturnType<typeof setInterval> | undefined;
    const start = () => { if (!t && !document.hidden) t = setInterval(() => setValue(store.read()), TICK_MS); };
    const stop = () => { if (t) { clearInterval(t); t = undefined; } };
    const onVis = () => { if (document.hidden) stop(); else { setValue(store.read()); start(); } };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [draining, store]);
  const ratio = Math.min(1, Math.max(0, value / HYPE.max));
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true" data-testid="hype-bar">
      <div className="h-full w-full origin-left rounded-full bg-primary motion-safe:transition-transform motion-safe:duration-200" style={{ transform: `scaleX(${ratio})` }} />
    </div>
  );
}

function useReducedMotion() {
  const [reduce, setReduce] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

/**
 * The burst: floating emoji (skipped under reduced motion) and a polite "Hype moment" line. The live region stays mounted
 * so a screen reader hears the text when it appears. Place inside a relatively positioned frame. In the rail layout it is
 * centred over the video column (the frame minus the 360 px chat rail); in the stack layout over the whole width.
 */
export function HypeBurst({ burst, layout = "stack" }: { burst: HypeBurstState | null; layout?: "stack" | "rail" }) {
  const reduce = useReducedMotion();
  const emojis = burst?.emojis ?? [];
  return (
    <div className={`pointer-events-none absolute bottom-[132px] z-[13] h-0 ${layout === "rail" ? "left-0 right-[360px]" : "inset-x-0"}`} data-testid="hype-burst">
      <div role="status" aria-live="polite" className="flex justify-center">
        {burst && <p className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg" data-testid="hype-toast">Hype moment</p>}
      </div>
      {burst && !reduce && (
        <div aria-hidden="true" key={burst.n}>
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className="room-float absolute bottom-0 text-3xl" style={{ left: `${10 + i * 10}%`, animationDelay: `${(i % 3) * 120}ms` }} data-testid="hype-emoji">
              {emojis[i % Math.max(1, emojis.length)] ?? "🎉"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
