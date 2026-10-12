import { useQuery } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  MegaphoneIcon,
  DollarSignIcon,
  GlobeIcon,
  TrendingUpIcon,
  AlertTriangleIcon,
  UsersIcon,
} from "lucide-react";

// ── API types ──────────────────────────────────────────────────────────────────

interface DashboardData {
  stats: {
    total_posts:    number;
    total_cost_usd: string;
    platforms_used: number;
    posts_failed:   number;
  };
  daily_posts: Array<{ date: string; count: number; cost: string }>;
  by_platform: Array<{ platform: string; posts: number; cost: string }>;
}

interface CostsData {
  this_month_actual:  string;
  monthly_projection: string;
  by_platform:        Record<string, string>;
  daily:              Array<{ date: string; cost: string }>;
  trend_direction:    "up" | "down" | "stable";
}

interface OrganizerStat {
  user_id:            string;
  org_name:           string;
  connected_accounts: number;
  posts_this_month:   number;
  cost_this_month:    string;
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function TrendBadge({ direction }: { direction: "up" | "down" | "stable" }) {
  const map = {
    up:     { label: "↑ Up",     className: "bg-red-500/10 text-red-400 border-red-500/20" },
    down:   { label: "↓ Down",   className: "bg-green-500/10 text-green-400 border-green-500/20" },
    stable: { label: "→ Stable", className: "bg-slate-500/10 text-slate-400 border-slate-500/20" },
  };
  const { label, className } = map[direction];
  return <Badge className={`${className} border font-normal`}>{label}</Badge>;
}

function StatCard({
  title,
  value,
  sub,
  icon,
  color,
  iconBg,
}: {
  title:  string;
  value:  string | number;
  sub?:   string;
  icon:   React.ReactNode;
  color:  string;
  iconBg: string;
}) {
  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-slate-400 text-sm">{title}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
          </div>
          <div className={`p-2.5 rounded-lg ${iconBg}`}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

interface PlanStats {
  activePlans: { total: number; byTier: Record<string, { recurring: number; one_off: number }> };
  revenue30d: { byCurrency: Record<string, number>; gbp: number; payments: number };
  costs30d: { zernioAccountsBilled: number; zernioGbp: number; xPosts: number; xGbp: number; cardFeesGbp: number; totalGbp: number };
  marginGbp: number;
  marginPct: number | null;
  health: {
    overCapUsers: number; needsReconnect: number; expiring7d: number; scheduled24h: number;
    failedSends7d: number; stuckSending: number; unconfirmedPosts: number;
  };
  assumptions: { usdPerGbp: number; ngnPerGbp: number; xUsdPerPost: number; cardFeePct: number; cardFeeFixedGbp: number };
}

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Plan revenue vs estimated cost, plus checks that should read zero. Finance/super-admin only;
// for other roles the API answers 403 and the section simply isn't shown.
function PlansSection() {
  const { data, isLoading, isError } = useQuery<PlanStats>({
    queryKey: ["/api/admin/social/plans"],
    retry: false,
  });
  if (isError) return null;
  if (isLoading || !data) return <Skeleton className="h-40 w-full bg-slate-700/50" />;

  const { health } = data;
  // [label, value, bad when non-zero?]
  const checks: Array<[string, number, boolean]> = [
    ["Users over their plan's platform cap", health.overCapUsers, true],
    ["Accounts needing reconnect", health.needsReconnect, false],
    ["Sends stuck in \"sending\" over 10 min", health.stuckSending, true],
    ["Posts not confirmed by Zernio after 1 h", health.unconfirmedPosts, true],
    ["Failed or partial sends (7 d)", health.failedSends7d, false],
    ["Plans ending within 7 days, not renewing", health.expiring7d, false],
    ["Sends scheduled in the next 24 h", health.scheduled24h, false],
  ];

  return (
    <div className="space-y-4" data-testid="section-social-plans">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Plan revenue (30 d)" value={gbp(data.revenue30d.gbp)}
          sub={`${data.revenue30d.payments} payment${data.revenue30d.payments === 1 ? "" : "s"}`}
          icon={<DollarSignIcon className="w-5 h-5" />} color="text-emerald-400" iconBg="bg-emerald-500/20" />
        <StatCard title="Estimated costs (30 d)" value={gbp(data.costs30d.totalGbp)}
          sub={`Zernio ${gbp(data.costs30d.zernioGbp)} · X ${gbp(data.costs30d.xGbp)} · cards ${gbp(data.costs30d.cardFeesGbp)}`}
          icon={<TrendingUpIcon className="w-5 h-5" />} color="text-amber-400" iconBg="bg-amber-500/20" />
        <StatCard title="Margin" value={gbp(data.marginGbp)}
          sub={data.marginPct === null ? "No revenue yet" : `${data.marginPct}% of revenue`}
          icon={<DollarSignIcon className="w-5 h-5" />} color={data.marginGbp >= 0 ? "text-emerald-400" : "text-red-400"} iconBg="bg-emerald-500/20" />
        <StatCard title="Zernio accounts billed" value={data.costs30d.zernioAccountsBilled}
          sub={`${data.activePlans.total} active plan${data.activePlans.total === 1 ? "" : "s"}`}
          icon={<UsersIcon className="w-5 h-5" />} color="text-blue-400" iconBg="bg-blue-500/20" />
      </div>

      <Card className="bg-slate-800/50 border-slate-700">
        <CardHeader className="pb-2">
          <CardTitle className="text-slate-200 text-base">Active plans</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-700 hover:bg-transparent">
                <TableHead className="text-slate-400">Tier</TableHead>
                <TableHead className="text-slate-400 text-right">Monthly</TableHead>
                <TableHead className="text-slate-400 text-right">One-off</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(data.activePlans.byTier).map(([tier, n]) => (
                <TableRow key={tier} className="border-slate-700 hover:bg-slate-700/20">
                  <TableCell className="text-slate-200 capitalize font-medium">{tier}</TableCell>
                  <TableCell className="text-slate-300 text-right">{n.recurring}</TableCell>
                  <TableCell className="text-slate-300 text-right">{n.one_off}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="bg-slate-800/50 border-slate-700">
        <CardHeader className="pb-2">
          <CardTitle className="text-slate-200 text-base flex items-center gap-2">
            <AlertTriangleIcon className="h-4 w-4 text-amber-400" />
            Health checks
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ul>
            {checks.map(([label, value, badWhenNonZero]) => (
              <li key={label} className="flex items-center justify-between gap-3 border-t border-slate-700 px-4 py-2.5 text-sm">
                <span className="text-slate-300">{label}</span>
                <Badge className={`border font-normal ${value > 0 && badWhenNonZero ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-slate-500/10 text-slate-300 border-slate-500/20"}`}>
                  {value}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <p className="text-xs text-slate-500">
        Costs are estimates, not Zernio's invoice: ${data.assumptions.usdPerGbp} per £1, ₦{data.assumptions.ngnPerGbp} per £1, X at up to ${data.assumptions.xUsdPerPost} per post,
        cards at {(data.assumptions.cardFeePct * 100).toFixed(2)}% + {gbp(data.assumptions.cardFeeFixedGbp)}. Edit them in shared/socialPlans.ts.
      </p>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AdminSocialDashboard() {
  const { data: dashboard, isLoading: dashLoading } = useQuery<DashboardData>({
    queryKey: ["/api/admin/social/dashboard"],
  });

  const { data: organizers = [], isLoading: orgsLoading } = useQuery<OrganizerStat[]>({
    queryKey: ["/api/admin/social/organizers"],
  });

  const loading = dashLoading;

  return (
    <AdminLayout>
      <div className="space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <MegaphoneIcon className="h-6 w-6 text-purple-400" />
            Social Media Analytics
          </h1>
          <p className="text-slate-400 mt-1 text-sm">
            Plans, revenue and Zernio usage — last 30 days
          </p>
        </div>

        <PlansSection />

        {/* Stat cards */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <Card key={i} className="bg-slate-800/50 border-slate-700 animate-pulse">
                <CardContent className="p-5">
                  <div className="h-20 bg-slate-700/50 rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              title="Total Posts (30 d)"
              value={dashboard?.stats.total_posts ?? 0}
              icon={<MegaphoneIcon className="w-5 h-5" />}
              color="text-purple-400"
              iconBg="bg-purple-500/20"
            />
            <StatCard
              title="Platforms Active"
              value={dashboard?.stats.platforms_used ?? 0}
              icon={<GlobeIcon className="w-5 h-5" />}
              color="text-blue-400"
              iconBg="bg-blue-500/20"
            />
            <StatCard
              title="Failed Posts (30 d)"
              value={dashboard?.stats.posts_failed ?? 0}
              icon={<AlertTriangleIcon className="w-5 h-5" />}
              color="text-red-400"
              iconBg="bg-red-500/20"
            />
          </div>
        )}

        {/* Platform breakdown */}
        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-200 text-base flex items-center gap-2">
              <GlobeIcon className="h-4 w-4 text-blue-400" />
              Platform Breakdown (30 d)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {dashLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8 w-full bg-slate-700/50" />)}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700 hover:bg-transparent">
                    <TableHead className="text-slate-400">Platform</TableHead>
                    <TableHead className="text-slate-400 text-right">Posts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(dashboard?.by_platform ?? []).length === 0 ? (
                    <TableRow className="border-slate-700">
                      <TableCell colSpan={2} className="text-slate-500 text-center py-6">
                        No data yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    [...(dashboard?.by_platform ?? [])]
                      .sort((a, b) => b.posts - a.posts)
                      .map((row) => (
                        <TableRow key={row.platform} className="border-slate-700 hover:bg-slate-700/20">
                          <TableCell className="text-slate-200 capitalize font-medium">
                            {row.platform}
                          </TableCell>
                          <TableCell className="text-slate-300 text-right">{row.posts}</TableCell>
                        </TableRow>
                      ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Organizer stats */}
        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-200 text-base flex items-center gap-2">
              <UsersIcon className="h-4 w-4 text-purple-400" />
              Organizer Activity (this month)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {orgsLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full bg-slate-700/50" />)}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700 hover:bg-transparent">
                    <TableHead className="text-slate-400">Organizer</TableHead>
                    <TableHead className="text-slate-400 text-right">Linked</TableHead>
                    <TableHead className="text-slate-400 text-right">Posts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizers.length === 0 ? (
                    <TableRow className="border-slate-700">
                      <TableCell colSpan={3} className="text-slate-500 text-center py-6">
                        No organizer activity yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    organizers.map((org) => (
                      <TableRow key={org.user_id} className="border-slate-700 hover:bg-slate-700/20">
                        <TableCell className="text-slate-200 font-medium">
                          {org.org_name}
                        </TableCell>
                        <TableCell className="text-slate-300 text-right">
                          {org.connected_accounts}
                        </TableCell>
                        <TableCell className="text-slate-300 text-right">
                          {org.posts_this_month}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

      </div>
    </AdminLayout>
  );
}
