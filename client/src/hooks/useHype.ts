import { useEffect, useRef, useState } from "react";
import { hypeDecay, hypeNext } from "@/lib/hype";
import type { ReactionItem } from "@/lib/roomReducer";

export interface HypeBurstState { n: number; emojis: string[] }
const BURST_MS = 3800;
const TICK_MS = 250;

/**
 * Counts every reaction the room delivers (including your own), drains the bar over time and reports a burst when it fills.
 * `reactions` is the reducer's short list of recent reactions; ids that were already counted are skipped.
 */
export function useHype(reactions: ReactionItem[]) {
  const [value, setValue] = useState(0);
  const [burst, setBurst] = useState<HypeBurstState | null>(null);
  const vref = useRef(0);
  const seen = useRef(new Set<string>());
  const bursts = useRef(0);

  useEffect(() => {
    const fresh = reactions.filter((r) => !seen.current.has(r.id));
    seen.current = new Set(reactions.map((r) => r.id));
    if (!fresh.length) return;
    let v = vref.current;
    let burstEmojis: string[] | null = null;
    fresh.forEach((r, i) => {
      const next = hypeNext(v, "reaction");
      v = next.value;
      if (next.burst) burstEmojis = fresh.slice(Math.max(0, i - 8), i + 1).map((x) => x.emoji);
    });
    vref.current = v;
    setValue(v);
    if (burstEmojis) setBurst({ n: ++bursts.current, emojis: burstEmojis });
  }, [reactions]);

  const draining = value > 0;
  useEffect(() => {
    if (!draining) return;
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      vref.current = hypeDecay(vref.current, (now - last) / 1000);
      last = now;
      setValue(vref.current);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [draining]);

  useEffect(() => {
    if (!burst) return;
    const t = setTimeout(() => setBurst(null), BURST_MS);
    return () => clearTimeout(t);
  }, [burst]);

  return { value, burst };
}
