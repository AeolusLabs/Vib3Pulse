import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend, ComposedChart, Line,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  TicketIcon, EyeIcon, DollarSignIcon, CalendarIcon,
  TrendingUpIcon, BarChart3Icon,
} from "@/components/ui/icons";
import {
  Users, Award, ArrowRight, ChevronUp, ChevronDown,
  Minus, ExternalLink, AlertCircle, TrendingUp,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type Period = "all" | "30d" | "90d";

interface EventBreakdownItem {
  eventId: string;
  title: string;
  rsvps: number;
  tickets: number;
  views: number;
  revenue: number;
  ticketPrice: number;
  capacity: number;
  eventDate: string;
  isFree: boolean;
}

interface DemographicsData {
  totalEvents: number;
  totalRsvps: number;
  totalTicketsSold: number;
  totalViews: number;
  totalRevenue: number;
  ageDistribution: { ageGroup: string; count: number; percentage: number }[];
  genderDistribution: { gender: string; count: number; percentage: number }[];
  eventBreakdown: EventBreakdownItem[];
  ticketSalesByAge: { ageGroup: string; tickets: number; revenue: number; percentage: number }[];
  ticketSalesByGender: { gender: string; tickets: number; revenue: number; percentage: number }[];
  averageTicketPrice: number;
  bestSellingEvent: { title: string; tickets: number; revenue: number } | null;
  conversionRate: number;
}

type SortField = "title" | "tickets" | "revenue" | "sellThrough" | "conversion" | "rsvps";
type SortDir = "asc" | "desc";

interface Props {
  organizerId: string;
  organizerName: string;
}

// ─── Color constants ──────────────────────────────────────────────────────────

const GENDER_COLORS = ["#7C3AED", "#EC4899", "#6366F1", "#94A3B8"];
const AGE_COLOR = "#7C3AED";
const CHART_TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "8px",
  fontSize: "13px",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatGBP(pence: number): string {
  if (pence === 0) return "£0";
  const pounds = pence / 100;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: pounds >= 100 ? 0 : 2,
  }).format(pounds);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function sellThrough(tickets: number, capacity: number): number {
  if (capacity === 0) return 0;
  return Math.min(100, Math.round((tickets / capacity) * 100));
}

function eventStatus(eventDate: string): { label: string; color: string } {
  const d = new Date(eventDate);
  const now = new Date();
  if (d > now) return { label: "Upcoming", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" };
  return { label: "Past", color: "bg-muted text-muted-foreground" };
}

function perEventConversion(views: number, rsvps: number, tickets: number): number {
  if (views === 0) return 0;
  return Math.round(((rsvps + tickets) / views) * 1000) / 10;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PeriodButton({ current, value, label, onChange }: {
  current: Period; value: Period; label: string; onChange: (v: Period) => void;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onChange(value)}
      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
        active
          ? "bg-violet-600 text-white shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}

function KpiCard({ label, value, sub, icon, accent = false }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; accent?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 p-4 rounded-xl border ${
      accent
        ? "border-violet-200 dark:border-violet-800/60 bg-violet-50/50 dark:bg-violet-950/20"
        : "border-border bg-card"
    }`}>
      <div className={`mt-0.5 shrink-0 ${accent ? "text-violet-600 dark:text-violet-400" : "text-muted-foreground"}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold tabular-nums leading-tight ${accent ? "text-violet-700 dark:text-violet-300" : ""}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function ConversionFunnel({ views, rsvps, tickets }: { views: number; rsvps: number; tickets: number }) {
  const stages = [
    { label: "Views", count: views, color: "bg-slate-400 dark:bg-slate-600" },
    { label: "RSVPs", count: rsvps, color: "bg-violet-400 dark:bg-violet-600" },
    { label: "Tickets", count: tickets, color: "bg-violet-700 dark:bg-violet-500" },
  ];

  const max = Math.max(views, 1);

  return (
    <div className="space-y-3">
      {stages.map((stage, i) => {
        const pct = Math.round((stage.count / max) * 100);
        const dropPct = i > 0 && stages[i - 1].count > 0
          ? Math.round((1 - stage.count / stages[i - 1].count) * 100)
          : null;
        const pctOfViews = views > 0 ? Math.round((stage.count / views) * 100) : 0;

        return (
          <div key={stage.label}>
            {dropPct !== null && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5 pl-1">
                <ArrowRight className="h-3 w-3" />
                <span>{dropPct}% did not continue</span>
              </div>
            )}
            <div className="flex items-center gap-3">
              <div className="w-20 shrink-0 text-right">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stage.label}</span>
              </div>
              <div className="flex-1 relative h-8 bg-muted rounded-md overflow-hidden">
                <div
                  className={`h-full ${stage.color} rounded-md transition-all duration-500`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="w-28 shrink-0 flex items-baseline gap-1.5">
                <span className="text-sm font-bold tabular-nums">{formatCompact(stage.count)}</span>
                {i > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    ({pctOfViews}%)
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {views === 0 && rsvps === 0 && tickets === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">
          No activity yet. Views and ticket sales will appear here once your events go live.
        </p>
      )}
    </div>
  );
}

function SellThroughBar({ tickets, capacity, isFree }: { tickets: number; capacity: number; isFree: boolean }) {
  if (isFree || capacity === 0) {
    return <span className="text-xs text-muted-foreground">{tickets > 0 ? `${tickets} RSVPs` : "—"}</span>;
  }
  const pct = sellThrough(tickets, capacity);
  const color =
    pct >= 80 ? "bg-emerald-500" :
    pct >= 50 ? "bg-violet-500" :
    pct >= 20 ? "bg-amber-500" : "bg-slate-400";

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground shrink-0">{tickets}/{capacity}</span>
      <span className="text-xs tabular-nums font-medium shrink-0">{pct}%</span>
    </div>
  );
}

function SortHeader({ field, label, sort, setSort }: {
  field: SortField; label: string;
  sort: { field: SortField; dir: SortDir };
  setSort: (s: { field: SortField; dir: SortDir }) => void;
}) {
  const active = sort.field === field;
  return (
    <th
      className="text-right py-3 px-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors"
      onClick={() =>
        setSort({ field, dir: active && sort.dir === "desc" ? "asc" : "desc" })
      }
    >
      <span className="inline-flex items-center justify-end gap-1">
        {label}
        {active ? (
          sort.dir === "desc" ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />
        ) : (
          <Minus className="h-3 w-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-8 text-center">
      <div className="w-16 h-16 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center mb-6">
        <BarChart3Icon className="h-8 w-8 text-violet-500" />
      </div>
      <h3 className="text-xl font-semibold mb-2">No events yet</h3>
      <p className="text-muted-foreground max-w-xs mb-8 leading-relaxed">
        Create your first event and once tickets start selling, you'll see revenue, audience demographics, and conversion metrics here.
      </p>
      <Link href="/manage-events">
        <Button className="gap-2">
          <CalendarIcon className="h-4 w-4" />
          Create your first event
        </Button>
      </Link>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OrganizerAnalyticsDashboard({ organizerId, organizerName }: Props) {
  const [period, setPeriod] = useState<Period>("all");
  const [sort, setSort] = useState<{ field: SortField; dir: SortDir }>({ field: "tickets", dir: "desc" });

  const queryKey = period === "all"
    ? [`/api/organizers/${organizerId}/demographics`]
    : [`/api/organizers/${organizerId}/demographics`, period];

  const queryFn = async () => {
    const url = period === "all"
      ? `/api/organizers/${organizerId}/demographics`
      : `/api/organizers/${organizerId}/demographics?period=${period}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("Failed to load analytics");
    return res.json() as Promise<DemographicsData>;
  };

  const { data, isLoading, error } = useQuery<DemographicsData>({
    queryKey,
    queryFn,
  });

  // Derived aggregate sell-through
  const aggregateSellThrough = useMemo(() => {
    if (!data?.eventBreakdown) return null;
    const paidEvents = data.eventBreakdown.filter(e => !e.isFree && e.capacity > 0);
    if (paidEvents.length === 0) return null;
    const totalCap = paidEvents.reduce((s, e) => s + e.capacity, 0);
    const totalSold = paidEvents.reduce((s, e) => s + e.tickets, 0);
    return totalCap > 0 ? Math.round((totalSold / totalCap) * 100) : 0;
  }, [data]);

  // Sorted event breakdown for table
  const sortedEvents = useMemo(() => {
    if (!data?.eventBreakdown) return [];
    return [...data.eventBreakdown].sort((a, b) => {
      let valA: number, valB: number;
      switch (sort.field) {
        case "tickets": valA = a.tickets; valB = b.tickets; break;
        case "revenue": valA = a.revenue; valB = b.revenue; break;
        case "rsvps": valA = a.rsvps; valB = b.rsvps; break;
        case "sellThrough": valA = sellThrough(a.tickets, a.capacity); valB = sellThrough(b.tickets, b.capacity); break;
        case "conversion": valA = perEventConversion(a.views, a.rsvps, a.tickets); valB = perEventConversion(b.views, b.rsvps, b.tickets); break;
        default: return sort.dir === "asc"
          ? a.title.localeCompare(b.title)
          : b.title.localeCompare(a.title);
      }
      return sort.dir === "asc" ? valA - valB : valB - valA;
    });
  }, [data?.eventBreakdown, sort]);

  // ── Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center py-16 text-center gap-3">
        <AlertCircle className="h-8 w-8 text-destructive opacity-80" />
        <p className="font-medium">Failed to load analytics</p>
        <p className="text-sm text-muted-foreground">Please refresh the page and try again.</p>
      </div>
    );
  }

  if (!data || data.totalEvents === 0) {
    return <EmptyState />;
  }

  const {
    totalRevenue, totalTicketsSold, totalViews, totalRsvps, totalEvents,
    conversionRate, averageTicketPrice, bestSellingEvent,
    ageDistribution, genderDistribution, ticketSalesByAge, ticketSalesByGender,
    eventBreakdown,
  } = data;

  return (
    <div className="space-y-7">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Performance report for <span className="font-medium text-foreground">{organizerName}</span>
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/60 border border-border w-fit">
          <PeriodButton current={period} value="all" label="All time" onChange={setPeriod} />
          <PeriodButton current={period} value="90d" label="90 days" onChange={setPeriod} />
          <PeriodButton current={period} value="30d" label="30 days" onChange={setPeriod} />
        </div>
      </div>

      {/* ── KPI Strip ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          accent
          label="Revenue"
          value={formatGBP(totalRevenue)}
          sub="from ticket sales"
          icon={<DollarSignIcon className="h-4 w-4" />}
        />
        <KpiCard
          label="Tickets sold"
          value={formatCompact(totalTicketsSold)}
          sub={aggregateSellThrough !== null ? `${aggregateSellThrough}% sell-through` : "across all events"}
          icon={<TicketIcon className="h-4 w-4" />}
        />
        <KpiCard
          label="Conversion"
          value={`${conversionRate}%`}
          sub="view → engagement"
          icon={<TrendingUpIcon className="h-4 w-4" />}
        />
        <KpiCard
          label="Avg ticket"
          value={averageTicketPrice > 0 ? formatGBP(averageTicketPrice) : "Free"}
          sub="per ticket sold"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <KpiCard
          label="Events hosted"
          value={String(totalEvents)}
          sub={`${totalRsvps} total RSVPs`}
          icon={<CalendarIcon className="h-4 w-4" />}
        />
      </div>

      {/* ── Conversion Funnel ──────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUpIcon className="h-4 w-4 text-violet-500" />
            Conversion Funnel
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Where attendees are in their journey — views to RSVPs to paid tickets
          </p>
        </CardHeader>
        <CardContent>
          <ConversionFunnel views={totalViews} rsvps={totalRsvps} tickets={totalTicketsSold} />
          {totalViews > 0 && (
            <div className="mt-5 pt-4 border-t grid grid-cols-3 text-center gap-2">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">RSVP rate</p>
                <p className="text-lg font-bold tabular-nums">
                  {totalViews > 0 ? `${Math.round((totalRsvps / totalViews) * 100)}%` : "—"}
                </p>
                <p className="text-xs text-muted-foreground">of views RSVP</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">Ticket rate</p>
                <p className="text-lg font-bold tabular-nums">
                  {totalViews > 0 ? `${Math.round((totalTicketsSold / totalViews) * 100)}%` : "—"}
                </p>
                <p className="text-xs text-muted-foreground">of views buy</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">RSVP → ticket</p>
                <p className="text-lg font-bold tabular-nums">
                  {totalRsvps > 0 ? `${Math.round((totalTicketsSold / totalRsvps) * 100)}%` : "—"}
                </p>
                <p className="text-xs text-muted-foreground">RSVPs convert</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Tabbed sections ───────────────────────────────────── */}
      <Tabs defaultValue="events">
        <TabsList className="grid grid-cols-3 w-full max-w-sm">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="audience">Audience</TabsTrigger>
        </TabsList>

        {/* ── Overview tab ── */}
        <TabsContent value="overview" className="space-y-5 mt-5">

          {/* Best performer */}
          {bestSellingEvent && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/40 dark:bg-amber-950/20 p-5">
              <div className="flex items-start gap-4">
                <div className="p-2.5 bg-amber-100 dark:bg-amber-900/40 rounded-lg shrink-0">
                  <Award className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                    Best selling event
                  </p>
                  <p className="font-semibold text-lg leading-snug">{bestSellingEvent.title}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-400">
                    {bestSellingEvent.tickets}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    tickets · {formatGBP(bestSellingEvent.revenue)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Sell-through per event */}
          {eventBreakdown.filter(e => !e.isFree && e.capacity > 0).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TicketIcon className="h-4 w-4 text-violet-500" />
                  Sell-through by event
                </CardTitle>
                <p className="text-xs text-muted-foreground">Tickets sold as a percentage of capacity</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {[...eventBreakdown]
                  .filter(e => !e.isFree && e.capacity > 0)
                  .sort((a, b) => sellThrough(b.tickets, b.capacity) - sellThrough(a.tickets, a.capacity))
                  .map(event => {
                    const pct = sellThrough(event.tickets, event.capacity);
                    const status = eventStatus(event.eventDate);
                    return (
                      <div key={event.eventId} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium truncate">{event.title}</span>
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${status.color}`}>
                              {status.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  pct >= 80 ? "bg-emerald-500" :
                                  pct >= 50 ? "bg-violet-500" :
                                  pct >= 20 ? "bg-amber-500" : "bg-slate-400"
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs tabular-nums text-muted-foreground w-20 text-right">
                              {event.tickets}/{event.capacity} ({pct}%)
                            </span>
                          </div>
                        </div>
                        <span className="text-sm font-semibold tabular-nums text-emerald-700 dark:text-emerald-400 w-20 text-right">
                          {formatGBP(event.revenue)}
                        </span>
                      </div>
                    );
                  })}
              </CardContent>
            </Card>
          )}

          {/* Revenue vs tickets chart */}
          {eventBreakdown.some(e => e.revenue > 0 || e.tickets > 0) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3Icon className="h-4 w-4 text-violet-500" />
                  Revenue by event
                </CardTitle>
                <p className="text-xs text-muted-foreground">Actual revenue from ticket sales</p>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={[...eventBreakdown]
                        .filter(e => e.revenue > 0 || e.tickets > 0)
                        .sort((a, b) => b.revenue - a.revenue)
                        .slice(0, 8)}
                      layout="vertical"
                      margin={{ top: 0, right: 40, left: 8, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} horizontal={false} />
                      <XAxis
                        type="number"
                        tickFormatter={v => formatGBP(v)}
                        tick={{ fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="title"
                        tick={{ fontSize: 11 }}
                        width={110}
                        tickFormatter={v => v.length > 16 ? `${v.slice(0, 16)}…` : v}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={CHART_TOOLTIP_STYLE}
                        formatter={(v: number) => [formatGBP(v), "Revenue"]}
                        cursor={{ fill: "hsl(var(--muted))" }}
                      />
                      <Bar dataKey="revenue" fill="#7C3AED" radius={[0, 4, 4, 0]} name="revenue" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Events tab ── */}
        <TabsContent value="events" className="mt-5">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarIcon className="h-4 w-4 text-violet-500" />
                All events
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Click column headers to sort. Sell-through and conversion are shown for events with paid tickets.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left py-3 px-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground w-[220px]">
                        Event
                      </th>
                      <th className="text-center py-3 px-3 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                        Status
                      </th>
                      <SortHeader field="rsvps" label="RSVPs" sort={sort} setSort={setSort} />
                      <SortHeader field="tickets" label="Tickets" sort={sort} setSort={setSort} />
                      <SortHeader field="sellThrough" label="Sell-through" sort={sort} setSort={setSort} />
                      <SortHeader field="revenue" label="Revenue" sort={sort} setSort={setSort} />
                      <SortHeader field="conversion" label="Conv." sort={sort} setSort={setSort} />
                      <th className="py-3 px-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedEvents.map((event, idx) => {
                      const status = eventStatus(event.eventDate);
                      const conv = perEventConversion(event.views, event.rsvps, event.tickets);
                      return (
                        <tr
                          key={event.eventId}
                          className={`border-b last:border-0 hover:bg-muted/30 transition-colors ${
                            idx % 2 === 1 ? "bg-muted/10" : ""
                          }`}
                        >
                          <td className="py-3 px-4">
                            <p className="font-medium truncate max-w-[200px]" title={event.title}>
                              {event.title}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {new Date(event.eventDate).toLocaleDateString("en-GB", {
                                day: "numeric", month: "short", year: "numeric",
                              })}
                            </p>
                          </td>
                          <td className="py-3 px-3 text-center">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${status.color}`}>
                              {status.label}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className="tabular-nums font-medium">{event.rsvps}</span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className="tabular-nums font-medium">{event.tickets}</span>
                          </td>
                          <td className="py-3 px-3">
                            <div className="flex justify-end">
                              <SellThroughBar
                                tickets={event.tickets}
                                capacity={event.capacity}
                                isFree={event.isFree}
                              />
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className="tabular-nums font-medium text-emerald-700 dark:text-emerald-400">
                              {event.revenue > 0 ? formatGBP(event.revenue) : "—"}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className={`text-xs tabular-nums font-medium ${
                              conv >= 10 ? "text-emerald-700 dark:text-emerald-400" :
                              conv >= 5 ? "text-amber-600 dark:text-amber-400" :
                              "text-muted-foreground"
                            }`}>
                              {event.views > 0 ? `${conv}%` : "—"}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <Link href={`/event/${event.eventId}`}>
                              <button
                                title="View event page"
                                className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 bg-muted/40 font-semibold text-sm">
                      <td className="py-3 px-4 text-xs uppercase tracking-wider text-muted-foreground">
                        Total ({totalEvents} events)
                      </td>
                      <td />
                      <td className="py-3 px-3 text-right tabular-nums">{totalRsvps}</td>
                      <td className="py-3 px-3 text-right tabular-nums">{totalTicketsSold}</td>
                      <td className="py-3 px-3 text-right text-xs text-muted-foreground">
                        {aggregateSellThrough !== null ? `${aggregateSellThrough}% avg` : "—"}
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatGBP(totalRevenue)}
                      </td>
                      <td className="py-3 px-3 text-right text-xs text-muted-foreground tabular-nums">
                        {conversionRate}%
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Audience tab ── */}
        <TabsContent value="audience" className="space-y-5 mt-5">

          {/* Age distribution charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* Audience age */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4 text-violet-500" />
                  Audience age
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Unique attendees (RSVPs + ticket buyers) by age group
                </p>
              </CardHeader>
              <CardContent>
                {ageDistribution.length > 0 ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={ageDistribution}
                        layout="vertical"
                        margin={{ top: 0, right: 40, left: 8, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis
                          type="category"
                          dataKey="ageGroup"
                          tick={{ fontSize: 11 }}
                          width={70}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          contentStyle={CHART_TOOLTIP_STYLE}
                          formatter={(v: number, _: string, props: any) => [
                            `${v} attendees (${props.payload.percentage}%)`,
                            "Attendees",
                          ]}
                          cursor={{ fill: "hsl(var(--muted))" }}
                        />
                        <Bar dataKey="count" fill={AGE_COLOR} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <NoDataState message="No age data yet. Appears when users RSVP or buy tickets." />
                )}
              </CardContent>
            </Card>

            {/* Gender distribution */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4 text-pink-500" />
                  Audience gender
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Gender breakdown of all unique attendees
                </p>
              </CardHeader>
              <CardContent>
                {genderDistribution.length > 0 ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={genderDistribution}
                          cx="50%"
                          cy="45%"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={3}
                          dataKey="count"
                          nameKey="gender"
                          label={({ gender, percentage }) => `${percentage}%`}
                          labelLine={false}
                        >
                          {genderDistribution.map((_, i) => (
                            <Cell key={i} fill={GENDER_COLORS[i % GENDER_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={CHART_TOOLTIP_STYLE}
                          formatter={(v: number, _: string, props: any) => [
                            `${v} (${props.payload.percentage}%)`,
                            props.payload.gender,
                          ]}
                        />
                        <Legend
                          verticalAlign="bottom"
                          height={32}
                          formatter={(value) => <span className="text-xs">{value}</span>}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <NoDataState message="No gender data yet. Appears when users RSVP or buy tickets." />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Ticket sales by age: bar + revenue line */}
          {ticketSalesByAge.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TicketIcon className="h-4 w-4 text-violet-500" />
                  Ticket sales by age group
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Bars = tickets sold, line = revenue generated. Which cohort is your biggest buyer?
                </p>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={ticketSalesByAge} margin={{ top: 16, right: 24, left: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis dataKey="ageGroup" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        allowDecimals={false}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        tickFormatter={v => formatGBP(v)}
                        tick={{ fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={CHART_TOOLTIP_STYLE}
                        formatter={(v: number, name: string, props: any) => {
                          if (name === "Tickets") return [`${v} tickets (${props.payload.percentage}%)`, "Tickets"];
                          return [formatGBP(v), "Revenue"];
                        }}
                        cursor={{ fill: "hsl(var(--muted))" }}
                      />
                      <Legend
                        verticalAlign="bottom"
                        height={28}
                        formatter={v => <span className="text-xs">{v}</span>}
                      />
                      <Bar yAxisId="left" dataKey="tickets" fill="#7C3AED" radius={[4, 4, 0, 0]} name="Tickets" />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="revenue"
                        stroke="#10B981"
                        strokeWidth={2}
                        dot={{ fill: "#10B981", r: 3 }}
                        name="Revenue"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Ticket sales by gender */}
          {ticketSalesByGender.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TicketIcon className="h-4 w-4 text-pink-500" />
                  Ticket sales by gender
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Tickets purchased and revenue generated, broken down by gender
                </p>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {ticketSalesByGender.map((g, i) => (
                    <div
                      key={g.gender}
                      className="p-3 rounded-lg border bg-card text-center"
                      style={{ borderColor: GENDER_COLORS[i % GENDER_COLORS.length] + "40" }}
                    >
                      <div
                        className="w-3 h-3 rounded-full mx-auto mb-2"
                        style={{ backgroundColor: GENDER_COLORS[i % GENDER_COLORS.length] }}
                      />
                      <p className="text-xs font-medium text-muted-foreground">{g.gender}</p>
                      <p className="text-xl font-bold tabular-nums mt-0.5">{g.tickets}</p>
                      <p className="text-xs text-muted-foreground">tickets</p>
                      <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400 mt-1 tabular-nums">
                        {formatGBP(g.revenue)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{g.percentage}% of sales</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Audience insights summary */}
          {(ageDistribution.length > 0 || genderDistribution.length > 0) && (
            <div className="rounded-xl border border-violet-200 dark:border-violet-800/50 bg-violet-50/30 dark:bg-violet-950/15 p-5">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-violet-100 dark:bg-violet-900/40 rounded-lg shrink-0">
                  <TrendingUpIcon className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                  <p className="font-semibold text-sm text-violet-900 dark:text-violet-100 mb-2">
                    Audience insights
                  </p>
                  <ul className="space-y-1.5 text-sm text-violet-800 dark:text-violet-200">
                    <li className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
                      <span>
                        Total reach:{" "}
                        <strong>{totalRsvps + totalTicketsSold}</strong> unique attendees
                        across <strong>{totalEvents}</strong>{" "}
                        {totalEvents === 1 ? "event" : "events"}
                      </span>
                    </li>
                    {ticketSalesByAge[0] && (
                      <li className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
                        <span>
                          Top buying age group:{" "}
                          <strong>{ticketSalesByAge[0].ageGroup}</strong>{" "}
                          ({ticketSalesByAge[0].percentage}% of ticket sales)
                        </span>
                      </li>
                    )}
                    {ticketSalesByGender[0] && (
                      <li className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-pink-500 shrink-0" />
                        <span>
                          Top buying gender:{" "}
                          <strong>{ticketSalesByGender[0].gender}</strong>{" "}
                          ({ticketSalesByGender[0].percentage}% of ticket sales,{" "}
                          {formatGBP(ticketSalesByGender[0].revenue)} revenue)
                        </span>
                      </li>
                    )}
                    {bestSellingEvent && (
                      <li className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                        <span>
                          Best event:{" "}
                          <strong>{bestSellingEvent.title}</strong> —{" "}
                          {bestSellingEvent.tickets} tickets,{" "}
                          {formatGBP(bestSellingEvent.revenue)}
                        </span>
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {ageDistribution.length === 0 && genderDistribution.length === 0 && (
            <NoDataState
              message="No demographic data yet. Data appears once attendees RSVP or purchase tickets for your events."
              large
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NoDataState({ message, large = false }: { message: string; large?: boolean }) {
  return (
    <div className={`flex items-center justify-center ${large ? "py-16" : "h-52"} text-center`}>
      <div>
        <EyeIcon className="h-8 w-8 mx-auto mb-2 opacity-25 text-muted-foreground" />
        <p className="text-sm text-muted-foreground max-w-xs">{message}</p>
      </div>
    </div>
  );
}
