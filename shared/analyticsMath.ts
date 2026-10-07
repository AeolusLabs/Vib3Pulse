// Organiser-analytics maths shared by the server (what gets stored/returned) and the client
// (what gets drawn), so the card, the funnel and the table can never disagree.

// Share of views that turned into an RSVP or a purchase. null = nothing to divide by (no views
// recorded), which the UI shows as "—" rather than a misleading 0%. Capped at 100%: views are
// raw page opens while `converted` is distinct people, and views recorded before tracking
// existed can be fewer than the people who converted.
export function conversionPct(views: number, converted: number): number | null {
  if (!views || views <= 0) return null;
  return Math.min(100, Math.round((converted / views) * 1000) / 10);
}

export interface FunnelStage {
  key: "views" | "engaged" | "buyers";
  label: string;
  count: number;
  /** share of the previous stage (null for the first stage or when the previous stage is empty) */
  rate: number | null;
  /** bar length as % of the widest stage, so a bar can never overflow its track */
  widthPct: number;
}

// Views -> people who RSVP'd or bought -> people who bought a paid ticket.
// "buyers" are a subset of "engaged" by construction, so each rate is a real step-down.
export function buildFunnel(views: number, engaged: number, buyers: number): FunnelStage[] {
  const max = Math.max(views, engaged, buyers, 1);
  const step = (count: number, prev: number | null) =>
    prev && prev > 0 ? Math.min(100, Math.round((count / prev) * 100)) : null;
  return [
    { key: "views", label: "Viewed", count: views, rate: null, widthPct: (views / max) * 100 },
    { key: "engaged", label: "RSVP'd or bought", count: engaged, rate: step(engaged, views), widthPct: (engaged / max) * 100 },
    { key: "buyers", label: "Bought a ticket", count: buyers, rate: step(buyers, engaged), widthPct: (buyers / max) * 100 },
  ];
}
