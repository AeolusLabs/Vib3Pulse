import { useState } from "react";
import { useElementWidth } from "./useElementWidth";
import { AXIS, GRID, INK_MUTED, INK_PRIMARY, INK_SECONDARY, SURFACE, dayLabel, niceMax } from "./tokens";

// Two day-by-day charts on one frame: a line with a faint area for one running measure (money per day) and columns for counts
// (rooms started, peak attendance). Spec from the dataviz skill: 2px line, 8px end dot with a 2px surface ring, area ~10%, columns at
// most 24px with a 4px rounded top and a square base, hairline solid grid, a crosshair that snaps to the day, one tooltip listing every
// value, the same readout on keyboard focus, and only the end (line) or the peak (columns) labelled. Every value is also in the table
// view, so the tooltip never gates anything.

export type DayPoint = { day: string; value: number; tip: { label: string; value: string }[] };
type Props = {
  data: DayPoint[];
  color: string;
  formatTick: (n: number) => string;
  formatValue: (n: number) => string;
  ariaLabel: string;
  testId: string;
  height?: number;
  /** Counts: axis ticks must be whole numbers, so the maximum is an even number and the middle tick is exact. */
  integer?: boolean;
};

const M = { l: 46, r: 14, t: 18, b: 26 };

function Frame({ data, formatTick, ariaLabel, testId, height = 208, columns = false, integer = false, children }: Props & { columns?: boolean; children: (g: Geo) => React.ReactNode }) {
  const [ref, w] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = data.length;
  const innerW = Math.max(0, w - M.l - M.r);
  const innerH = height - M.t - M.b;
  const top = Math.max(0, ...data.map((d) => d.value));
  const max = integer && top <= 10 ? Math.max(2, Math.ceil(top / 2) * 2) : niceMax(top);
  const y = (v: number) => M.t + innerH - (v / max) * innerH;
  const slot = n ? innerW / n : 0;
  // Line charts run edge to edge; columns sit in equal slots, so the crosshair and ticks snap to a slot centre.
  const x = (i: number) => (columns ? M.l + slot * i + slot / 2 : M.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW));
  const geo: Geo = { n, innerW, innerH, max, y, x, slot, active, w, height };
  const idxFromPointer = (clientX: number, el: Element) => {
    const rel = clientX - el.getBoundingClientRect().left - M.l;
    const i = columns ? Math.floor(rel / Math.max(1, slot)) : Math.round((rel / Math.max(1, innerW)) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };
  const xTicks = Array.from(new Set(n === 0 ? [] : [0, Math.floor((n - 1) / 2), n - 1]));
  const yTicks = [0, max / 2, max];
  const a = active !== null ? data[active] : null;
  const tipLeft = a ? Math.min(Math.max(0, geo.x(active!) - 80), Math.max(0, w - 172)) : 0;

  return (
    <div ref={ref} className="relative w-full" data-testid={testId}
      onKeyDown={(e) => {
        if (n === 0) return;
        if (e.key === "ArrowLeft") { e.preventDefault(); setActive((i) => Math.max(0, (i ?? n) - 1)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); setActive((i) => Math.min(n - 1, (i ?? -1) + 1)); }
        else if (e.key === "Escape") setActive(null);
      }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} tabIndex={0} className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          onFocus={() => setActive((i) => i ?? (n ? n - 1 : null))} onBlur={() => setActive(null)}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={w - M.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={1} />
              <text x={M.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={INK_MUTED}>{formatTick(t)}</text>
            </g>
          ))}
          {xTicks.map((i, k) => (
            <text key={i} x={geo.x(i)} y={height - 8} textAnchor={k === 0 && xTicks.length > 1 ? "start" : k === xTicks.length - 1 && xTicks.length > 1 ? "end" : "middle"} fontSize={11} fill={INK_MUTED}>{dayLabel(data[i].day)}</text>
          ))}
          {children(geo)}
          {active !== null && <line x1={geo.x(active)} x2={geo.x(active)} y1={M.t} y2={M.t + innerH} stroke={INK_MUTED} strokeWidth={1} />}
          <rect x={M.l} y={M.t} width={innerW} height={innerH} fill="transparent"
            onPointerMove={(e) => setActive(idxFromPointer(e.clientX, e.currentTarget))} onPointerLeave={() => setActive(null)} />
        </svg>
      )}
      {a && (
        <div role="status" className="pointer-events-none absolute top-1 z-10 w-[10.5rem] rounded-lg border border-slate-600 bg-slate-900/95 px-3 py-2 shadow-lg" style={{ left: tipLeft }}>
          <p className="text-xs font-medium text-slate-300">{dayLabel(a.day)}</p>
          {a.tip.map((r) => (
            <p key={r.label} className="mt-1 flex items-baseline justify-between gap-3">
              <span className="text-xs text-slate-400">{r.label}</span>
              <span className="text-sm font-semibold tabular-nums text-white">{r.value}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

type Geo = { n: number; innerW: number; innerH: number; max: number; y: (v: number) => number; x: (i: number) => number; slot: number; active: number | null; w: number; height: number };

export function DayLineChart(props: Props) {
  const { data, color, formatValue } = props;
  return (
    <Frame {...props}>
      {(g) => {
        if (g.n === 0) return null;
        const line = data.map((d, i) => `${i ? "L" : "M"}${g.x(i)},${g.y(d.value)}`).join("");
        const base = M.t + g.innerH;
        const last = data.length - 1;
        return (
          <>
            <path d={`${line}L${g.x(last)},${base}L${g.x(0)},${base}Z`} fill={color} fillOpacity={0.1} />
            <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={g.x(last)} cy={g.y(data[last].value)} r={6} fill={SURFACE} />
            <circle cx={g.x(last)} cy={g.y(data[last].value)} r={4} fill={color} />
            <text x={g.x(last) - 10} y={Math.max(M.t + 10, g.y(data[last].value) - 10)} textAnchor="end" fontSize={12} fontWeight={600} fill={INK_PRIMARY}>{formatValue(data[last].value)}</text>
            {g.active !== null && (
              <>
                <circle cx={g.x(g.active)} cy={g.y(data[g.active].value)} r={6} fill={SURFACE} />
                <circle cx={g.x(g.active)} cy={g.y(data[g.active].value)} r={4} fill={color} />
              </>
            )}
          </>
        );
      }}
    </Frame>
  );
}

/** Rounded data end (4px), square at the baseline. */
const roundedTop = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}L${x},${y + rr}Q${x},${y} ${x + rr},${y}L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h}Z`;
};

export function DayColumnChart(props: Props) {
  const { data, color, formatValue } = props;
  return (
    <Frame {...props} columns integer>
      {(g) => {
        if (g.n === 0) return null;
        const peak = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
        const base = M.t + g.innerH;
        const colW = Math.min(24, Math.max(2, g.slot - 2));
        const cx = g.x;
        return (
          <>
            {data.map((d, i) => {
              const h = d.value <= 0 ? 0 : Math.max(2, base - g.y(d.value));
              const hot = g.active === i;
              return h > 0 ? <path key={d.day} d={roundedTop(cx(i) - colW / 2, base - h, colW, h, 4)} fill={color} fillOpacity={hot ? 1 : 0.85} stroke={hot ? INK_PRIMARY : "none"} strokeWidth={hot ? 1 : 0} /> : null;
            })}
            {data[peak].value > 0 && (
              <text x={Math.min(Math.max(cx(peak), M.l + 14), g.w - M.r - 14)} y={Math.max(M.t + 8, g.y(data[peak].value) - 6)} textAnchor="middle" fontSize={12} fontWeight={600} fill={INK_PRIMARY}>{formatValue(data[peak].value)}</text>
            )}
          </>
        );
      }}
    </Frame>
  );
}
