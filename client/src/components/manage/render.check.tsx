// Run (needs the automatic JSX runtime):
//   echo '{"extends":"./tsconfig.json","compilerOptions":{"jsx":"react-jsx"}}' > tsconfig.check.json
//   npx tsx --tsconfig tsconfig.check.json client/src/components/manage/render.check.tsx
//   rm tsconfig.check.json
// The useLayoutEffect warning is expected (server render only; the app renders in the browser).
// Server-renders the redesigned organiser UI with fixture data to catch runtime errors
// (no browser needed). Checks the numbers and states that matter, not pixels.
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrganizerAnalyticsDashboard } from "../OrganizerAnalyticsDashboard";
import { StatusChip } from "./StatusChip";
import { CapacityBar } from "./CapacityBar";

const ev = (over: Record<string, unknown>) => ({
  eventId: "e1", title: "Friday Sessions", rsvps: 10, tickets: 25, views: 200, converted: 30, revenue: 125000,
  currency: "GBP", ticketPrice: 5000, capacity: 100, eventDate: "2026-12-01T20:00:00.000Z", isFree: false, ...over,
});

const base = {
  totalEvents: 2, totalRsvps: 10, totalTicketsSold: 25, totalViews: 200, totalRevenue: 125000,
  ageDistribution: [], genderDistribution: [], ticketSalesByAge: [], ticketSalesByGender: [],
  averageTicketPrice: 5000, bestSellingEvent: { title: "Friday Sessions", tickets: 25, revenue: 125000, currency: "GBP" },
  conversionRate: 15, convertedTotal: 30, buyers: 25, rsvpBuyers: 5,
  eventBreakdown: [ev({}), ev({ eventId: "e2", title: "Sunday Brunch", views: 0, converted: 0, tickets: 0, revenue: 0, rsvps: 0 })],
};

function render(data: unknown): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  qc.setQueryData(["/api/organizers/o1/demographics"], data);
  return renderToString(
    <QueryClientProvider client={qc}>
      <OrganizerAnalyticsDashboard organizerId="o1" organizerName="Test Org" />
    </QueryClientProvider>,
  );
}

// 1. with traffic: real conversion, stat band, funnel, insight naming the best event
let html = render(base);
assert.ok(html.includes("kpi-strip"), "stat band renders");
assert.ok(html.includes("15%"), "conversion shown");
assert.ok(html.includes("Conversion funnel"), "funnel renders in Overview");
assert.ok(html.includes("Friday Sessions converts best: 15%"), "insight picks best-converting event");
assert.ok(html.includes('data-testid="tab-overview"') && html.includes('data-testid="tab-audience"'), "Overview / Events / Audience tabs");
assert.ok(!html.includes("NaN") && !html.includes("Infinity"), "no NaN/Infinity anywhere");

// 2. no views yet (the pre-tracking state): dash, not 0%, plus the explanation
html = render({ ...base, totalViews: 0, conversionRate: 0, eventBreakdown: base.eventBreakdown.map((e) => ({ ...e, views: 0 })) });
assert.ok(html.includes("No views recorded yet"), "explains missing views");
assert.ok(html.includes("Views are counted from now on"), "insight explains tracking");
assert.ok(!html.includes("NaN") && !html.includes("Infinity"), "no NaN/Infinity with zero views");

// 3. small shared pieces
assert.ok(renderToString(<StatusChip kind="promoted" />).includes("Promoted"));
const bar = renderToString(<CapacityBar sold={100} total={100} />);
assert.ok(bar.includes("Sold out") && bar.includes("scaleX(1)"));
assert.ok(renderToString(<CapacityBar sold={0} total={0} />).includes("scaleX(0)"), "zero capacity doesn't divide by zero");

console.log("render.check: ok");
