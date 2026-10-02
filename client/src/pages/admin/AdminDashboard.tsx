import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import AdminLayout from "./AdminLayout";
import AdminFilterBar from "@/components/admin/AdminFilterBar";
import AdminDateRangePicker from "@/components/admin/AdminDateRangePicker";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  UsersIcon, CalendarIcon, TicketIcon, PoundSterlingIcon, UserPlusIcon,
  FlagIcon, TrendingUpIcon, ImageIcon, Loader2Icon, DownloadIcon,
  CreditCardIcon, MailIcon,
} from "@/components/ui/icons";
import { Building, Wrench, Database, Wallet, ArrowUp, ArrowDown } from "lucide-react";
import { formatMoney } from "@/lib/currency";
import { exportToCsv } from "@/lib/exportToCsv";

interface CurrencyRevenue {
  currency: string;
  totalRevenue: number;
}

interface PlatformStats {
  totalUsers: number;
  totalEvents: number;
  totalTicketsSold: number;
  totalVenueTicketsSold: number;
  revenueByCurrency: CurrencyRevenue[];
  activeUsers: number;
  newUsersToday: number;
  pendingReports: number;
  activeOrganizers: number;
}

interface DailyAnalytics {
  date: string;
  signups: number;
  ticketsSold: number;
  revenue: Record<string, number>;
}

interface AnalyticsTotals {
  signups: number;
  ticketsSold: number;
  revenue: Record<string, number>;
}

interface AnalyticsOverview {
  daily: DailyAnalytics[];
  totals: AnalyticsTotals;
  previousPeriod: AnalyticsTotals;
}

type ServiceStatus = { status: "ok" | "down"; detail?: string };

interface PlatformHealth {
  database: ServiceStatus;
  stripe: ServiceStatus;
  paystack: ServiceStatus;
  email: ServiceStatus;
}

const ADMIN_CHART_TOOLTIP_STYLE = {
  backgroundColor: "#1e293b",
  border: "1px solid #334155",
  borderRadius: "8px",
  fontSize: "13px",
  color: "#f1f5f9",
};

// ((current - previous) / previous) * 100, guarded against division by zero.
// previous === 0 has no meaningful percentage — treated as "New" rather than
// Infinity/NaN.
function pctChange(current: number, previous: number): number | "new" | null {
  if (previous === 0) {
    return current > 0 ? "new" : null;
  }
  return ((current - previous) / previous) * 100;
}

function GrowthBadge({ current, previous }: { current: number; previous: number }) {
  const change = pctChange(current, previous);
  if (change === null) return null;
  if (change === "new") {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 text-xs font-medium">
        New
      </span>
    );
  }
  const isUp = change >= 0;
  const color = isUp ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400";
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {isUp ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
      {Math.abs(change).toFixed(0)}%
    </span>
  );
}

function HealthRow({
  label,
  icon,
  status,
}: {
  label: string;
  icon: React.ReactNode;
  status?: ServiceStatus;
}) {
  const ok = status?.status === "ok";
  const known = status !== undefined;
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400 flex items-center gap-2">
        <span className="text-slate-500">{icon}</span>
        {label}
      </span>
      <span
        className={`px-2 py-1 rounded-full text-sm ${
          !known
            ? "bg-slate-500/20 text-slate-400"
            : ok
            ? "bg-green-500/20 text-green-400"
            : "bg-red-500/20 text-red-400"
        }`}
        title={status?.detail}
      >
        {!known ? "Unknown" : ok ? "Operational" : "Down"}
      </span>
    </div>
  );
}

export default function AdminDashboard() {
  const { toast } = useToast();

  const [dateRange, setDateRange] = useState<{ from?: Date; to?: Date }>({});
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const [country, setCountry] = useState<string | undefined>(undefined);

  const { data: stats, isLoading } = useQuery<PlatformStats>({
    queryKey: ["/api/admin/stats"],
  });

  const { data: adminUser } = useQuery<{ role: string }>({
    queryKey: ["/api/admin/me"],
  });

  const { data: health, isLoading: healthLoading } = useQuery<PlatformHealth>({
    queryKey: ["/api/admin/health"],
  });

  const analyticsFilters = {
    from: dateRange.from?.toISOString(),
    to: dateRange.to?.toISOString(),
    currency,
    country,
  };

  const { data: overview, isLoading: overviewLoading } = useQuery<AnalyticsOverview>({
    queryKey: ["/api/admin/analytics/overview", analyticsFilters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (analyticsFilters.from) params.set("from", analyticsFilters.from);
      if (analyticsFilters.to) params.set("to", analyticsFilters.to);
      if (analyticsFilters.currency) params.set("currency", analyticsFilters.currency);
      if (analyticsFilters.country) params.set("country", analyticsFilters.country);
      const qs = params.toString();
      const res = await fetch(`/api/admin/analytics/overview${qs ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load analytics overview");
      return res.json() as Promise<AnalyticsOverview>;
    },
  });

  const fixAclMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/utilities/fix-post-acl");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "ACL Fix Complete",
        description: `Fixed ${data.fixed} images, skipped ${data.skipped}${data.errors?.length ? `, ${data.errors.length} errors` : ''}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Currencies actually present in this period's revenue totals — drives
  // which per-currency revenue chart(s) render. Revenue in different
  // currencies can never be summed, so each gets its own small chart.
  const revenueCurrencies = useMemo(() => {
    const keys = new Set<string>();
    Object.keys(overview?.totals?.revenue || {}).forEach((k) => keys.add(k));
    (overview?.daily || []).forEach((d) => Object.keys(d.revenue || {}).forEach((k) => keys.add(k)));
    const all = Array.from(keys);
    // If a currency filter is active, only that currency's revenue is
    // meaningful to chart even if the totals object retains other keys.
    if (currency) return all.filter((c) => c === currency);
    return all.filter((c) => (overview?.totals?.revenue?.[c] || 0) > 0);
  }, [overview, currency]);

  const dailyChartData = overview?.daily || [];

  const handleExportDaily = () => {
    if (!dailyChartData.length) return;
    const rows = dailyChartData.map((d) => {
      const row: Record<string, unknown> = {
        date: d.date,
        signups: d.signups,
        ticketsSold: d.ticketsSold,
      };
      revenueCurrencies.forEach((c) => {
        row[`revenue_${c}`] = d.revenue?.[c] ?? 0;
      });
      return row;
    });
    exportToCsv("admin-analytics-daily", rows);
  };

  const statCards = [
    {
      title: "Total Users",
      value: stats?.totalUsers || 0,
      icon: <UsersIcon className="w-5 h-5" />,
      color: "bg-blue-500/10 text-blue-400",
      iconBg: "bg-blue-500/20",
    },
    {
      title: "Total Events",
      value: stats?.totalEvents || 0,
      icon: <CalendarIcon className="w-5 h-5" />,
      color: "bg-purple-500/10 text-purple-400",
      iconBg: "bg-purple-500/20",
    },
    {
      title: "Tickets Sold",
      value: stats?.totalTicketsSold || 0,
      icon: <TicketIcon className="w-5 h-5" />,
      color: "bg-green-500/10 text-green-400",
      iconBg: "bg-green-500/20",
    },
    ...((stats?.revenueByCurrency?.length ? stats.revenueByCurrency : [{ currency: "GBP", totalRevenue: 0 }]).map((r) => ({
      title: `Revenue (${r.currency})`,
      value: formatMoney(r.totalRevenue, r.currency),
      icon: <PoundSterlingIcon className="w-5 h-5" />,
      color: "bg-emerald-500/10 text-emerald-400",
      iconBg: "bg-emerald-500/20",
    }))),
    {
      title: "New Users Today",
      value: stats?.newUsersToday || 0,
      icon: <UserPlusIcon className="w-5 h-5" />,
      color: "bg-cyan-500/10 text-cyan-400",
      iconBg: "bg-cyan-500/20",
    },
    {
      title: "Pending Reports",
      value: stats?.pendingReports || 0,
      icon: <FlagIcon className="w-5 h-5" />,
      color: stats?.pendingReports ? "bg-red-500/10 text-red-400" : "bg-slate-500/10 text-slate-400",
      iconBg: stats?.pendingReports ? "bg-red-500/20" : "bg-slate-500/20",
    },
    {
      title: "Active Organizers",
      value: stats?.activeOrganizers || 0,
      icon: <Building className="w-5 h-5" />,
      color: "bg-amber-500/10 text-amber-400",
      iconBg: "bg-amber-500/20",
    },
    {
      title: "Verified Users",
      value: stats?.activeUsers || 0,
      icon: <TrendingUpIcon className="w-5 h-5" />,
      color: "bg-indigo-500/10 text-indigo-400",
      iconBg: "bg-indigo-500/20",
    },
  ];

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white" data-testid="text-dashboard-title">
              Dashboard
            </h1>
            <p className="text-slate-400 mt-1">
              Platform overview and key metrics
            </p>
          </div>
          <AdminDateRangePicker
            from={dateRange.from}
            to={dateRange.to}
            onChange={(range) => setDateRange(range)}
          />
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <Card key={i} className="bg-slate-800/50 border-slate-700 animate-pulse">
                <CardContent className="p-6">
                  <div className="h-20 bg-slate-700/50 rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {statCards.map((stat, index) => (
              <Card
                key={index}
                className="bg-slate-800/50 border-slate-700"
                data-testid={`stat-card-${stat.title.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-slate-400">{stat.title}</p>
                      <p className="text-2xl font-bold text-white mt-1">
                        {stat.value}
                      </p>
                    </div>
                    <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${stat.iconBg}`}>
                      <div className={stat.color.split(' ')[1]}>
                        {stat.icon}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Trends & filters */}
        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <CardTitle className="text-white">Trends</CardTitle>
            <div className="flex flex-wrap items-center gap-3">
              <AdminFilterBar
                currency={currency}
                onCurrencyChange={setCurrency}
                country={country}
                onCountryChange={setCountry}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportDaily}
                disabled={!dailyChartData.length}
                data-testid="button-export-daily-analytics"
              >
                <DownloadIcon className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {overviewLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-24 bg-slate-700/30 rounded animate-pulse" />
                ))}
              </div>
            ) : (
              <>
                {/* Period totals with growth badges */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-4 rounded-lg bg-slate-700/30">
                    <p className="text-sm text-slate-400">Signups</p>
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-xl font-bold text-white">{overview?.totals.signups ?? 0}</p>
                      <GrowthBadge current={overview?.totals.signups ?? 0} previous={overview?.previousPeriod.signups ?? 0} />
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-slate-700/30">
                    <p className="text-sm text-slate-400">Tickets Sold</p>
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-xl font-bold text-white">{overview?.totals.ticketsSold ?? 0}</p>
                      <GrowthBadge current={overview?.totals.ticketsSold ?? 0} previous={overview?.previousPeriod.ticketsSold ?? 0} />
                    </div>
                  </div>
                  {revenueCurrencies.length > 0 ? (
                    revenueCurrencies.slice(0, 2).map((c) => (
                      <div key={c} className="p-4 rounded-lg bg-slate-700/30">
                        <p className="text-sm text-slate-400">Revenue ({c})</p>
                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-xl font-bold text-white">
                            {formatMoney(overview?.totals.revenue?.[c] ?? 0, c)}
                          </p>
                          <GrowthBadge
                            current={overview?.totals.revenue?.[c] ?? 0}
                            previous={overview?.previousPeriod.revenue?.[c] ?? 0}
                          />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 rounded-lg bg-slate-700/30">
                      <p className="text-sm text-slate-400">Revenue</p>
                      <p className="text-xl font-bold text-white mt-1">—</p>
                    </div>
                  )}
                </div>

                {/* Signups & tickets sold trend charts */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div>
                    <p className="text-sm font-medium text-slate-300 mb-2">Signups over time</p>
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={dailyChartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
                          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                          <Tooltip contentStyle={ADMIN_CHART_TOOLTIP_STYLE} />
                          <Line type="monotone" dataKey="signups" stroke="#22d3ee" strokeWidth={2} dot={{ r: 2 }} name="Signups" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-300 mb-2">Tickets sold over time</p>
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={dailyChartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
                          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                          <Tooltip contentStyle={ADMIN_CHART_TOOLTIP_STYLE} />
                          <Line type="monotone" dataKey="ticketsSold" stroke="#34d399" strokeWidth={2} dot={{ r: 2 }} name="Tickets Sold" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {/* Revenue trend chart(s) — one per currency, GBP and NGN can never be summed */}
                {revenueCurrencies.length > 0 && (
                  <div className={`grid grid-cols-1 ${revenueCurrencies.length > 1 ? "lg:grid-cols-2" : ""} gap-6`}>
                    {revenueCurrencies.map((c) => (
                      <div key={c}>
                        <p className="text-sm font-medium text-slate-300 mb-2">Revenue over time ({c})</p>
                        <div className="h-56">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart
                              data={dailyChartData.map((d) => ({ date: d.date, revenue: d.revenue?.[c] ?? 0 }))}
                              margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
                              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                              <YAxis
                                tick={{ fontSize: 11, fill: "#94a3b8" }}
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={(v: number) => formatMoney(v, c)}
                              />
                              <Tooltip
                                contentStyle={ADMIN_CHART_TOOLTIP_STYLE}
                                formatter={(v: number) => [formatMoney(v, c), "Revenue"]}
                              />
                              <Line type="monotone" dataKey="revenue" stroke="#fbbf24" strokeWidth={2} dot={{ r: 2 }} name="Revenue" />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <a
                href="/admin/reports"
                className="flex items-center gap-3 p-3 rounded-lg bg-slate-700/30 hover:bg-slate-700/50 transition-colors cursor-pointer"
                data-testid="link-view-reports"
              >
                <FlagIcon className="w-5 h-5 text-red-400" />
                <div>
                  <p className="text-white font-medium">Review Reports</p>
                  <p className="text-sm text-slate-400">
                    {stats?.pendingReports || 0} pending reports to review
                  </p>
                </div>
              </a>
              <a
                href="/admin/events"
                className="flex items-center gap-3 p-3 rounded-lg bg-slate-700/30 hover:bg-slate-700/50 transition-colors cursor-pointer"
                data-testid="link-moderate-events"
              >
                <CalendarIcon className="w-5 h-5 text-purple-400" />
                <div>
                  <p className="text-white font-medium">Moderate Events</p>
                  <p className="text-sm text-slate-400">Review and approve events</p>
                </div>
              </a>
              <a
                href="/admin/users"
                className="flex items-center gap-3 p-3 rounded-lg bg-slate-700/30 hover:bg-slate-700/50 transition-colors cursor-pointer"
                data-testid="link-manage-users"
              >
                <UsersIcon className="w-5 h-5 text-blue-400" />
                <div>
                  <p className="text-white font-medium">Manage Users</p>
                  <p className="text-sm text-slate-400">View and manage platform users</p>
                </div>
              </a>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">Platform Health</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {healthLoading ? (
                <div className="space-y-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-7 bg-slate-700/30 rounded animate-pulse" />
                  ))}
                </div>
              ) : (
                <>
                  <HealthRow label="Database" icon={<Database className="w-4 h-4" />} status={health?.database} />
                  <HealthRow label="Stripe (GBP)" icon={<CreditCardIcon className="w-4 h-4" />} status={health?.stripe} />
                  <HealthRow label="Paystack (NGN)" icon={<Wallet className="w-4 h-4" />} status={health?.paystack} />
                  <HealthRow label="Email" icon={<MailIcon className="w-4 h-4" />} status={health?.email} />
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {adminUser?.role === "super_admin" && (
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Wrench className="w-5 h-5" />
                Admin Utilities
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-700/30">
                <div className="flex items-center gap-3">
                  <ImageIcon className="w-5 h-5 text-purple-400" />
                  <div>
                    <p className="text-white font-medium">Fix Post Image ACLs</p>
                    <p className="text-sm text-slate-400">
                      Repairs visibility settings on all post images so they display correctly to other users
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => fixAclMutation.mutate()}
                  disabled={fixAclMutation.isPending}
                  variant="outline"
                  className="shrink-0"
                  data-testid="button-fix-acl"
                >
                  {fixAclMutation.isPending ? (
                    <>
                      <Loader2Icon className="w-4 h-4 mr-2 animate-spin" />
                      Fixing...
                    </>
                  ) : (
                    "Run Fix"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
