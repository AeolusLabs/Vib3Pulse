// Headline numbers. A stat tile is label, value and an optional change against a NAMED period; colour says whether the change is good
// (up can be bad, as with reversals) and is always paired with an arrow and a sign, never colour alone. One hero figure per view,
// in the same sans as the rest, proportional figures (tabular-nums is only for columns).

export type Delta = { pct: number | null; upIsGood: boolean; vs: string };

export function pctChange(now: number, before: number): number | null {
  if (before === 0) return now === 0 ? 0 : null;
  return ((now - before) / before) * 100;
}

function DeltaLine({ delta }: { delta: Delta }) {
  if (delta.pct === null) return <p className="text-xs text-slate-400">No sprays in {delta.vs} to compare</p>;
  const flat = Math.abs(delta.pct) < 0.05;
  const up = delta.pct > 0;
  const good = flat ? null : up === delta.upIsGood;
  const tone = good === null ? "text-slate-400" : good ? "text-emerald-400" : "text-red-400";
  const sign = flat ? "" : up ? "+" : "-";
  return (
    <p className="text-xs leading-snug">
      <span className={`inline-flex items-center gap-1 whitespace-nowrap font-semibold ${tone}`}>
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {flat ? <path d="M2 6h8" /> : up ? <path d="M6 10V2M2.5 5.5L6 2l3.5 3.5" /> : <path d="M6 2v8M2.5 6.5L6 10l3.5-3.5" />}
        </svg>
        {sign}{Math.abs(Math.round(delta.pct * 10) / 10)}%
      </span>{" "}
      <span className="text-slate-400">vs {delta.vs}</span>
    </p>
  );
}

export function StatTile({ label, value, delta, hero, large, testId, note }: { label: string; value: string; delta?: Delta; hero?: boolean; large?: boolean; testId: string; note?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="text-sm text-slate-400">{label}</p>
      <p className={`${hero ? "text-[clamp(1.875rem,8.5vw,3rem)]" : large ? "text-3xl" : "text-2xl"} mt-1 break-words font-semibold leading-tight text-white`}>{value}</p>
      {delta && <div className="mt-1"><DeltaLine delta={delta} /></div>}
      {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
    </div>
  );
}
