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

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AdminSocialDashboard() {
  const { data: dashboard, isLoading: dashLoading } = useQuery<DashboardData>({
    queryKey: ["/api/admin/social/dashboard"],
  });

  const { data: costs, isLoading: costsLoading } = useQuery<CostsData>({
    queryKey: ["/api/admin/social/costs"],
  });

  const { data: organizers = [], isLoading: orgsLoading } = useQuery<OrganizerStat[]>({
    queryKey: ["/api/admin/social/organizers"],
  });

  const loading = dashLoading || costsLoading;

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
            Zernio integration usage — last 30 days
          </p>
        </div>

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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title="Total Posts (30 d)"
              value={dashboard?.stats.total_posts ?? 0}
              icon={<MegaphoneIcon className="w-5 h-5" />}
              color="text-purple-400"
              iconBg="bg-purple-500/20"
            />
            <StatCard
              title="Total Spend (30 d)"
              value={`$${parseFloat(dashboard?.stats.total_cost_usd ?? "0").toFixed(2)}`}
              sub={`MTD: $${parseFloat(costs?.this_month_actual ?? "0").toFixed(2)}`}
              icon={<DollarSignIcon className="w-5 h-5" />}
              color="text-emerald-400"
              iconBg="bg-emerald-500/20"
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

        {/* Cost projection + trend */}
        {!costsLoading && costs && (
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader className="pb-2">
              <CardTitle className="text-slate-200 text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <TrendingUpIcon className="h-4 w-4 text-emerald-400" />
                  Monthly Cost Projection
                </span>
                <TrendBadge direction={costs.trend_direction} />
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex gap-8">
                <div>
                  <p className="text-slate-400 text-xs">Month-to-date</p>
                  <p className="text-xl font-bold text-white">${parseFloat(costs.this_month_actual).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-slate-400 text-xs">Projected full month</p>
                  <p className="text-xl font-bold text-emerald-400">${parseFloat(costs.monthly_projection).toFixed(2)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
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
                    <TableHead className="text-slate-400 text-right">Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(dashboard?.by_platform ?? []).length === 0 ? (
                    <TableRow className="border-slate-700">
                      <TableCell colSpan={3} className="text-slate-500 text-center py-6">
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
                          <TableCell className="text-slate-300 text-right">
                            ${parseFloat(row.cost).toFixed(2)}
                          </TableCell>
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
                    <TableHead className="text-slate-400 text-right">Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizers.length === 0 ? (
                    <TableRow className="border-slate-700">
                      <TableCell colSpan={4} className="text-slate-500 text-center py-6">
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
                        <TableCell className="text-slate-300 text-right">
                          ${parseFloat(org.cost_this_month ?? "0").toFixed(2)}
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
