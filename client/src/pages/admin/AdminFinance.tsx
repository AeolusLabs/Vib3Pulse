import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

import AdminLayout from "./AdminLayout";
import { Badge } from "@/components/ui/badge";
import { PoundSterlingIcon, TicketIcon, TrendingUpIcon, CreditCardIcon, InfoIcon, AlertTriangleIcon } from "@/components/ui/icons";

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
      icon: <PoundSterlingIcon className="w-5 h-5" />,
      color: "bg-emerald-500/10 text-emerald-400",
      iconBg: "bg-emerald-500/20",
    },
    {
      title: "Tickets Sold",
      value: finance?.totalTicketsSold || 0,
      icon: <TicketIcon className="w-5 h-5" />,
      color: "bg-blue-500/10 text-blue-400",
      iconBg: "bg-blue-500/20",
    },
    {
      title: "Avg. Ticket Price",
      value: finance && finance.totalTicketsSold > 0 
        ? `£${((finance.totalRevenue / finance.totalTicketsSold) / 100).toFixed(2)}`
        : "£0.00",
      icon: <TrendingUpIcon className="w-5 h-5" />,
      color: "bg-purple-500/10 text-purple-400",
      iconBg: "bg-purple-500/20",
    },
    {
      title: "Payment Mode",
      value: "Demo",
      icon: <CreditCardIcon className="w-5 h-5" />,
      color: "bg-indigo-500/10 text-indigo-400",
      iconBg: "bg-indigo-500/20",
    },
  ];

  return (
    <AdminLayout>
      <div className="space-y-6">
        <Alert className="border-red-500/50 bg-red-500/10">
          <AlertTriangleIcon className="w-4 h-4 text-red-400" />
          <AlertDescription className="text-red-300 font-medium">
            DEMO DATA ONLY — Real revenue tracking coming after Paystack setup
          </AlertDescription>
        </Alert>

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
                  <div className="w-10 h-10 bg-amber-500/20 rounded-lg flex items-center justify-center">
                    <InfoIcon className="w-5 h-5 text-amber-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium">Simulated Payments</p>
                    <p className="text-sm text-slate-400">Demo Mode Active</p>
                  </div>
                </div>
                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
                  Demo
                </Badge>
              </div>
              <p className="text-sm text-slate-400">
                All payments are currently simulated for demonstration purposes. 
                No real transactions are processed. Connect a payment provider 
                for production use.
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
                All amounts shown are simulated for demonstration.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white">Demo Mode Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <div className="flex items-start gap-3">
                <InfoIcon className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-white font-medium mb-1">Simulated Payment Environment</p>
                  <p className="text-slate-400 text-sm">
                    This platform is running in demo mode. All payments are simulated 
                    and no real money is transferred. Ticket purchases are instantly 
                    confirmed for testing purposes.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
