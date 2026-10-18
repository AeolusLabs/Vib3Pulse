import { useEffect, useState } from "react";
import { HYPE } from "@/lib/hype";
import type { HypeBurstState } from "@/hooks/useHype";

/** A 4 px bar above the composer. Decorative: the burst is announced by HypeBurst instead. Animates transform only. */
export function HypeBar({ value }: { value: number }) {
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
 * so a screen reader hears the text when it appears. Place inside a relatively positioned frame.
 */
export function HypeBurst({ burst }: { burst: HypeBurstState | null }) {
  const reduce = useReducedMotion();
  const emojis = burst?.emojis ?? [];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[132px] z-[13] h-0" data-testid="hype-burst">
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
