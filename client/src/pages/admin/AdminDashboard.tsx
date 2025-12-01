import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Users, 
  Calendar, 
  Ticket, 
  DollarSign, 
  UserPlus, 
  Flag, 
  Building,
  TrendingUp
} from "lucide-react";
import AdminLayout from "./AdminLayout";

interface PlatformStats {
  totalUsers: number;
  totalEvents: number;
  totalTicketsSold: number;
  totalRevenue: number;
  activeUsers: number;
  newUsersToday: number;
  pendingReports: number;
  activeOrganizers: number;
}

export default function AdminDashboard() {
  const { data: stats, isLoading } = useQuery<PlatformStats>({
    queryKey: ["/api/admin/stats"],
  });

  const statCards = [
    {
      title: "Total Users",
      value: stats?.totalUsers || 0,
      icon: <Users className="w-5 h-5" />,
      color: "bg-blue-500/10 text-blue-400",
      iconBg: "bg-blue-500/20",
    },
    {
      title: "Total Events",
      value: stats?.totalEvents || 0,
      icon: <Calendar className="w-5 h-5" />,
      color: "bg-purple-500/10 text-purple-400",
      iconBg: "bg-purple-500/20",
    },
    {
      title: "Tickets Sold",
      value: stats?.totalTicketsSold || 0,
      icon: <Ticket className="w-5 h-5" />,
      color: "bg-green-500/10 text-green-400",
      iconBg: "bg-green-500/20",
    },
    {
      title: "Total Revenue",
      value: `$${((stats?.totalRevenue || 0) / 100).toFixed(2)}`,
      icon: <DollarSign className="w-5 h-5" />,
      color: "bg-emerald-500/10 text-emerald-400",
      iconBg: "bg-emerald-500/20",
    },
    {
      title: "New Users Today",
      value: stats?.newUsersToday || 0,
      icon: <UserPlus className="w-5 h-5" />,
      color: "bg-cyan-500/10 text-cyan-400",
      iconBg: "bg-cyan-500/20",
    },
    {
      title: "Pending Reports",
      value: stats?.pendingReports || 0,
      icon: <Flag className="w-5 h-5" />,
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
      title: "Active Users",
      value: stats?.activeUsers || 0,
      icon: <TrendingUp className="w-5 h-5" />,
      color: "bg-indigo-500/10 text-indigo-400",
      iconBg: "bg-indigo-500/20",
    },
  ];

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-dashboard-title">
            Dashboard
          </h1>
          <p className="text-slate-400 mt-1">
            Platform overview and key metrics
          </p>
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
                <Flag className="w-5 h-5 text-red-400" />
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
                <Calendar className="w-5 h-5 text-purple-400" />
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
                <Users className="w-5 h-5 text-blue-400" />
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
              <div className="flex items-center justify-between">
                <span className="text-slate-400">System Status</span>
                <span className="px-2 py-1 rounded-full bg-green-500/20 text-green-400 text-sm">
                  Operational
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Database</span>
                <span className="px-2 py-1 rounded-full bg-green-500/20 text-green-400 text-sm">
                  Connected
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Payment Gateway</span>
                <span className="px-2 py-1 rounded-full bg-green-500/20 text-green-400 text-sm">
                  Active
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Storage</span>
                <span className="px-2 py-1 rounded-full bg-green-500/20 text-green-400 text-sm">
                  Available
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
