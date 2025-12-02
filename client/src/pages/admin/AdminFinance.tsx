import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PoundSterling, Ticket, TrendingUp, CreditCard } from "lucide-react";
import AdminLayout from "./AdminLayout";

interface FinanceOverview {
  totalRevenue: number;
  totalTicketsSold: number;
}

export default function AdminFinance() {
  const { data: finance, isLoading } = useQuery<FinanceOverview>({
    queryKey: ["/api/admin/finance/overview"],
  });

  const stats = [
    {
      title: "Total Revenue",
      value: finance ? `£${(finance.totalRevenue / 100).toFixed(2)}` : "£0.00",
      icon: <PoundSterling className="w-5 h-5" />,
      color: "bg-emerald-500/10 text-emerald-400",
      iconBg: "bg-emerald-500/20",
    },
    {
      title: "Tickets Sold",
      value: finance?.totalTicketsSold || 0,
      icon: <Ticket className="w-5 h-5" />,
      color: "bg-blue-500/10 text-blue-400",
      iconBg: "bg-blue-500/20",
    },
    {
      title: "Avg. Ticket Price",
      value: finance && finance.totalTicketsSold > 0 
        ? `£${((finance.totalRevenue / finance.totalTicketsSold) / 100).toFixed(2)}`
        : "£0.00",
      icon: <TrendingUp className="w-5 h-5" />,
      color: "bg-purple-500/10 text-purple-400",
      iconBg: "bg-purple-500/20",
    },
    {
      title: "Payment Gateway",
      value: "Stripe",
      icon: <CreditCard className="w-5 h-5" />,
      color: "bg-indigo-500/10 text-indigo-400",
      iconBg: "bg-indigo-500/20",
    },
  ];

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Finance Overview</h1>
          <p className="text-slate-400 mt-1">
            Platform revenue and payment statistics
          </p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <Card key={i} className="bg-slate-800/50 border-slate-700 animate-pulse">
                <CardContent className="p-6">
                  <div className="h-20 bg-slate-700/50 rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {stats.map((stat, index) => (
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
              <CardTitle className="text-white">Payment Processing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-700/30 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-500/20 rounded-lg flex items-center justify-center">
                    <CreditCard className="w-5 h-5 text-indigo-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium">Stripe Integration</p>
                    <p className="text-sm text-slate-400">Connected</p>
                  </div>
                </div>
                <span className="px-2 py-1 rounded-full bg-green-500/20 text-green-400 text-sm">
                  Active
                </span>
              </div>
              <p className="text-sm text-slate-400">
                All payments are processed through Stripe. Refunds and disputes 
                should be handled directly in the Stripe Dashboard.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">Revenue Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Event Tickets</span>
                  <span className="text-white font-medium">
                    £{finance ? (finance.totalRevenue / 100).toFixed(2) : '0.00'}
                  </span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div 
                    className="bg-purple-500 h-2 rounded-full" 
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
              <p className="text-sm text-slate-400 pt-2">
                Revenue is calculated from all confirmed ticket purchases.
                Platform fees and processing fees are handled by Stripe.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white">Stripe Dashboard Access</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-slate-400 mb-4">
              For detailed transaction history, refunds, disputes, and payouts, 
              please access the Stripe Dashboard directly.
            </p>
            <a 
              href="https://dashboard.stripe.com" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
              data-testid="link-stripe-dashboard"
            >
              <CreditCard className="w-4 h-4" />
              Open Stripe Dashboard
            </a>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
