import { useState } from "react";

// Ranked horizontal bars (one measure across named things) and a single stacked bar (one total split into parts). Marks follow the
// dataviz skill: bars at most 24px thick, a 4px rounded data end and a square base, a 2px surface gap between touching segments, the value
// at the bar tip (never inside, so nothing is ever clipped), text in text colours with identity carried by the swatch, and a legend
// whenever there are two or more series. Hover and keyboard focus show the same tooltip; the table view carries every value.

export type BarRow = { id: string; label: string; value: number; valueLabel: string; sub?: string };

function Tip({ children }: { children: React.ReactNode }) {
  return <div role="status" className="pointer-events-none absolute left-0 top-full z-10 mt-1 max-w-full rounded-lg border border-slate-600 bg-slate-900/95 px-3 py-2 text-xs text-slate-200 shadow-lg">{children}</div>;
}

export function RankedBars({ rows, color, ariaLabel, testId, empty = "Nothing in this range." }: { rows: BarRow[]; color: string; ariaLabel: string; testId: string; empty?: string }) {
  const [hot, setHot] = useState<string | null>(null);
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-slate-400" data-testid={testId}>{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul aria-label={ariaLabel} data-testid={testId} className="space-y-1">
      {rows.map((r) => {
        const ratio = r.value / max;
        // The bar gets the width left after a fixed strip reserved for the value label at its tip, so the label never leaves the panel.
        const barW = r.value > 0 ? `max(2px, calc((100% - 10.5rem) * ${ratio}))` : "0px";
        const labelLeft = `calc(max(0px, calc((100% - 10.5rem) * ${ratio})) + 8px)`;
        return (
          <li key={r.id} tabIndex={0} aria-label={`${r.label}: ${r.valueLabel}${r.sub ? `, ${r.sub}` : ""}`}
            onPointerEnter={() => setHot(r.id)} onPointerLeave={() => setHot(null)} onFocus={() => setHot(r.id)} onBlur={() => setHot(null)}
            className="relative grid grid-cols-1 gap-1 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-purple-400 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-center sm:gap-3">
            <span className="truncate text-sm text-slate-300">{r.label}</span>
            <div className="relative h-[18px]">
              <div className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: barW, background: color, opacity: hot === null || hot === r.id ? 1 : 0.55, transition: "opacity 120ms" }} />
              <span className="absolute inset-y-0 flex items-center gap-2 whitespace-nowrap text-sm" style={{ left: labelLeft }}>
                <span className="font-semibold tabular-nums text-white">{r.valueLabel}</span>
                {r.sub && <span className="text-xs text-slate-400">{r.sub}</span>}
              </span>
            </div>
            {hot === r.id && <Tip><span className="font-semibold text-white">{r.valueLabel}</span> <span className="text-slate-400">{r.label}{r.sub ? `, ${r.sub}` : ""}</span></Tip>}
          </li>
        );
      })}
    </ul>
  );
}

export type SplitPart = { id: string; label: string; value: number; valueLabel: string; color: string };

export function StackedBar({ parts, total, totalLabel, ariaLabel, testId }: { parts: SplitPart[]; total: number; totalLabel: string; ariaLabel: string; testId: string }) {
  const [hot, setHot] = useState<string | null>(null);
  const shown = parts.filter((p) => p.value > 0);
  if (total <= 0 || shown.length === 0) return <p className="py-6 text-center text-sm text-slate-400" data-testid={testId}>Nothing in this range.</p>;
  const pctOf = (v: number) => (v / total) * 100;
  const fmt = (v: number) => `${pctOf(v) < 0.1 ? "<0.1" : (Math.round(pctOf(v) * 10) / 10).toString()}%`;
  return (
    <div data-testid={testId}>
      <div role="img" aria-label={`${ariaLabel}, total ${totalLabel}`} className="relative flex h-5 gap-[2px]">
        {shown.map((p, i) => (
          <div key={p.id} tabIndex={0} aria-label={`${p.label}: ${p.valueLabel}, ${fmt(p.value)}`}
            onPointerEnter={() => setHot(p.id)} onPointerLeave={() => setHot(null)} onFocus={() => setHot(p.id)} onBlur={() => setHot(null)}
            className={`min-w-[2px] outline-none focus-visible:ring-2 focus-visible:ring-purple-400 ${i === 0 ? "rounded-l-[4px]" : ""} ${i === shown.length - 1 ? "rounded-r-[4px]" : ""}`}
            style={{ width: `${pctOf(p.value)}%`, background: p.color, opacity: hot === null || hot === p.id ? 1 : 0.55, transition: "opacity 120ms" }} />
        ))}
      </div>
      {hot && (() => { const p = parts.find((x) => x.id === hot)!; return <div role="status" className="mt-2 inline-block rounded-lg border border-slate-600 bg-slate-900/95 px-3 py-2 text-xs text-slate-200"><span className="font-semibold text-white">{p.valueLabel}</span> <span className="text-slate-400">{p.label}, {fmt(p.value)}</span></div>; })()}
      <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2" aria-label="Legend">
        {parts.map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-sm">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: p.color }} />
            <span className="min-w-0 flex-1 truncate text-slate-300">{p.label}</span>
            <span className="font-semibold tabular-nums text-white">{p.valueLabel}</span>
            <span className="w-12 text-right text-xs tabular-nums text-slate-400">{p.value > 0 ? fmt(p.value) : "0%"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
