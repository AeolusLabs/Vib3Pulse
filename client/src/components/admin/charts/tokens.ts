// Chart colours for the admin screens. The admin shell is permanently dark, so these are the DARK steps of the dataviz reference
// palette, validated as a set against the real panel colour (slate-800 at 50% over slate-900 = #172033):
//   node validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300" --mode dark --surface "#172033"  ->  ALL CHECKS PASS
// (worst adjacent colour-blind separation 8.4, normal-vision 19.3, every slot >= 3:1 on the surface). Colour follows the entity,
// never its rank: the same split part always gets the same slot, whatever else is on screen.
export const SURFACE = "#172033";
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"] as const;
export const COLOR_MONEY = SERIES[0]; // blue: everything about money
export const COLOR_USAGE = SERIES[2]; // aqua: rooms and attendance
export const GRID = "#334155";        // slate-700, hairline
export const AXIS = "#475569";        // slate-600, baseline
export const INK_MUTED = "#94a3b8";   // slate-400, axis text
export const INK_SECONDARY = "#cbd5e1";
export const INK_PRIMARY = "#f8fafc";

/** Clean axis maximum above a value: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/** Naira from kobo for axes and headline tiles: 1.2M, 45K, 900. Exact amounts always stay in tooltips and tables. */
export function compactNaira(kobo: number): string {
  const n = kobo / 100;
  const a = Math.abs(n);
  const f = (v: number, s: string) => `₦${(Math.round(v * 10) / 10).toLocaleString("en-NG")}${s}`;
  if (a >= 1_000_000_000) return f(n / 1_000_000_000, "B");
  if (a >= 1_000_000) return f(n / 1_000_000, "M");
  if (a >= 10_000) return f(n / 1_000, "K");
  return `₦${Math.round(n).toLocaleString("en-NG")}`;
}

export const compactCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 100) / 10}K` : n.toLocaleString("en-NG"));

/** Every UTC day from `from` to `to` inclusive, as YYYY-MM-DD (capped at 400 so a bad range cannot hang the page). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
  for (let t = start; t <= end && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
