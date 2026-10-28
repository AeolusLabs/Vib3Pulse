// The spray board, as two small pieces that sit over the room and never take a touch (pointer-events: none):
// - SprayBoardTray: the top three sprayers by V3C. It slides out from the right when a spray lands and goes after a few seconds,
//   a little see-through so the room shows behind it, with the words and numbers kept bright. An anonymous payer is "Anonymous".
// - SprayReceivedChip: what the viewer has been sprayed in this room, in naira and V3C. Only the person sprayed ever gets it.
// Motion is transform and opacity only: in 200 ms ease-out, out 150 ms; reduced motion keeps the fade and drops the slide.
import { useEffect, useRef, useState } from "react";
import { formatV3c } from "@shared/money";
import { formatNaira } from "@/lib/roomTickets";
import type { SprayBoardRow, SprayReceived } from "@/lib/roomReducer";

/** How long the tray stays out after a spray. */
export const BOARD_TRAY_MS = 6000;

export function SprayBoardTray({ top, tick, selfId }: { top: readonly SprayBoardRow[]; tick: number; selfId: string | null }) {
  const [open, setOpen] = useState(false);
  const seen = useRef(tick); // the first load is quiet: the tray only comes out for a spray that happens while you watch
  useEffect(() => {
    if (tick === seen.current || top.length === 0) return;
    seen.current = tick;
    setOpen(true);
    const t = setTimeout(() => setOpen(false), BOARD_TRAY_MS);
    return () => clearTimeout(t);
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (top.length === 0) return null;
  return (
    <aside
      aria-hidden={!open} data-testid="spray-board" data-open={open ? "1" : "0"}
      className={`pointer-events-none absolute right-3 top-[88px] z-[13] w-[224px] max-w-[64vw] rounded-2xl bg-black/55 px-3 py-2.5 text-white ring-1 ring-white/10 backdrop-blur-[6px] [text-shadow:0_1px_2px_rgb(0_0_0/0.6)] transition-[transform,opacity] ${open ? "translate-x-0 opacity-100 duration-200 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)]" : "translate-x-4 opacity-0 duration-150 ease-out motion-reduce:translate-x-0"}`}
    >
      <h3 className="mb-1.5 flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-white/75"><span>Top sprayers</span><span>V3C</span></h3>
      <ol className="grid gap-1.5">
        {top.map((r, i) => (
          <li key={`${r.id}:${i}`} className="flex items-center gap-2" data-testid="spray-board-row">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-[11px] font-bold tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{selfId && r.id === selfId ? "You" : r.name}</span>
            <span className="shrink-0 text-xs font-medium tabular-nums text-white/90">{formatV3c(r.v3c).split(" ")[0]}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function SprayReceivedChip({ received }: { received: SprayReceived | null }) {
  if (!received || received.v3c <= 0) return null;
  return (
    <div
      key={received.v3c} role="status" aria-live="polite" data-testid="spray-received"
      className="pointer-events-none absolute left-3 top-[88px] z-[13] rounded-2xl bg-secondary px-3 py-1.5 text-secondary-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200"
    >
      <span className="block text-[11px] font-medium opacity-80">You've been sprayed</span>
      <span className="block text-base font-bold leading-tight tabular-nums">{formatNaira(received.kobo)}</span>
      <span className="block text-xs tabular-nums opacity-80">{formatV3c(received.v3c)}</span>
    </div>
  );
}
