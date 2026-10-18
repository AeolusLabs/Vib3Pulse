import { useEffect, useRef, useState } from "react";
import { createHypeStore, splitFresh, type HypeStore } from "@/lib/hype";
import type { ReactionItem } from "@/lib/roomReducer";

export interface HypeBurstState { n: number; emojis: string[] }
const BURST_MS = 3800;

/**
 * Counts every reaction the room delivers (including your own) into a store outside React. The page keeps only the rare
 * burst state; the draining value is read by <HypeBar store>, so the page does not re-render while the bar empties.
 * Reactions already present on mount are marked seen without counting.
 */
export function useHype(reactions: ReactionItem[]): { store: HypeStore; burst: HypeBurstState | null } {
  const [burst, setBurst] = useState<HypeBurstState | null>(null);
  const store = useRef<HypeStore>();
  if (!store.current) store.current = createHypeStore();
  const seen = useRef<Set<string> | null>(null);
  if (!seen.current) seen.current = new Set(reactions.map((r) => r.id));
  const bursts = useRef(0);

  useEffect(() => {
    const split = splitFresh(seen.current!, reactions);
    seen.current = split.seen;
    if (!split.fresh.length) return;
    let emojis: string[] | null = null;
    // Count one at a time so the burst knows which reactions to float.
    split.fresh.forEach((r, i) => {
      if (store.current!.add(1)) emojis = split.fresh.slice(Math.max(0, i - 8), i + 1).map((x) => x.emoji);
    });
    if (emojis) setBurst({ n: ++bursts.current, emojis });
  }, [reactions]);

  useEffect(() => {
    if (!burst) return;
    const t = setTimeout(() => setBurst(null), BURST_MS);
    return () => clearTimeout(t);
  }, [burst]);

  return { store: store.current, burst };
}
