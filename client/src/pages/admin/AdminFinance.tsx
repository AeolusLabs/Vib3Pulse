import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

import AdminLayout from "./AdminLayout";
import { Badge } from "@/components/ui/badge";
import { PoundSterlingIcon, TicketIcon, TrendingUpIcon, CreditCardIcon, InfoIcon, AlertTriangleIcon, CheckCircleIcon } from "@/components/ui/icons";
import { formatMoney } from "@/lib/currency";

interface CurrencyRevenue {
  currency: string;
  ticketsSold: number;
  ticketRevenue: number;
  venueTicketsSold: number;
  venueRevenue: number;
  totalRevenue: number;
}

interface FinanceOverview {
  revenueByCurrency: CurrencyRevenue[];
  totalTicketsSold: number;
  totalVenueTicketsSold: number;
}

interface PaymentConfig {
  stripeConfigured: boolean;
  paystackConfigured: boolean;
}

export default function AdminFinance() {
  const { data: finance, isLoading } = useQuery<FinanceOverview>({
    queryKey: ["/api/admin/finance/overview"],
  });

  const { data: paymentConfig } = useQuery<PaymentConfig>({
    queryKey: ["/api/payments/config"],
  });

  const stripeLive = !!paymentConfig?.stripeConfigured;
  const paystackLive = !!paymentConfig?.paystackConfigured;
  const anyProviderLive = stripeLive || paystackLive;

  const paymentModeLabel = stripeLive && paystackLive
    ? "Stripe + Paystack"
    : stripeLive
    ? "Stripe"
    : paystackLive
    ? "Paystack"
    : "Not configured";

  const revenueByCurrency = finance?.revenueByCurrency ?? [];

  const statCards = [
    {
      title: "Tickets Sold",
      value: finance?.totalTicketsSold || 0,
      icon: <TicketIcon className="w-5 h-5" />,
      color: "bg-blue-500/10 text-blue-400",
      iconBg: "bg-blue-500/20",
    },
    {
      title: "Venue Tickets Sold",
      value: finance?.totalVenueTicketsSold || 0,
      icon: <TicketIcon className="w-5 h-5" />,
      color: "bg-cyan-500/10 text-cyan-400",
      iconBg: "bg-cyan-500/20",
    },
    ...(revenueByCurrency.length > 0
      ? revenueByCurrency.map((r) => ({
          title: `Revenue (${r.currency})`,
          value: formatMoney(r.totalRevenue, r.currency),
          icon: <PoundSterlingIcon className="w-5 h-5" />,
          color: "bg-emerald-500/10 text-emerald-400",
          iconBg: "bg-emerald-500/20",
        }))
      : [{
          title: "Revenue",
          value: "£0.00",
          icon: <PoundSterlingIcon className="w-5 h-5" />,
          color: "bg-emerald-500/10 text-emerald-400",
          iconBg: "bg-emerald-500/20",
        }]),
    {
      title: "Payment Mode",
      value: paymentModeLabel,
      icon: <CreditCardIcon className="w-5 h-5" />,
      color: "bg-indigo-500/10 text-indigo-400",
      iconBg: "bg-indigo-500/20",
    },
  ];

  return (
    <AdminLayout>
      <div className="space-y-6">
        {!anyProviderLive && (
          <Alert className="border-amber-500/50 bg-amber-500/10">
            <AlertTriangleIcon className="w-4 h-4 text-amber-400" />
            <AlertDescription className="text-amber-300 font-medium">
              No payment provider is configured yet — Stripe and Paystack keys are both unset.
              The figures below only reflect free/RSVP activity until keys are added.
            </AlertDescription>
          </Alert>
        )}

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
              <CardTitle className="text-white">Payment Processing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-700/30 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${anyProviderLive ? "bg-emerald-500/20" : "bg-amber-500/20"}`}>
                    {anyProviderLive ? (
                      <CheckCircleIcon className="w-5 h-5 text-emerald-400" />
                    ) : (
                      <InfoIcon className="w-5 h-5 text-amber-400" />
                    )}
                  </div>
                  <div>
                    <p className="text-white font-medium">{anyProviderLive ? "Live Payments" : "No Provider Configured"}</p>
                    <p className="text-sm text-slate-400">{paymentModeLabel}</p>
                  </div>
                </div>
                <Badge className={anyProviderLive ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-amber-500/20 text-amber-400 border-amber-500/30"}>
                  {anyProviderLive ? "Live" : "Not Configured"}
                </Badge>
              </div>
              <p className="text-sm text-slate-400">
                {anyProviderLive
                  ? "Real card payments are processed through the provider(s) above. Ticket and promotion purchases charge a real card."
                  : "Set STRIPE_SECRET_KEY and/or PAYSTACK_SECRET_KEY to start accepting real payments. Until then, only free RSVPs and admin-granted promotion credits go through."}
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">Revenue Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {revenueByCurrency.length === 0 ? (
                <p className="text-sm text-slate-400">No confirmed sales yet.</p>
              ) : (
                revenueByCurrency.map((r) => {
                  const eventShare = r.totalRevenue > 0 ? Math.round((r.ticketRevenue / r.totalRevenue) * 100) : 0;
                  const avgTicketPrice = r.ticketsSold > 0 ? formatMoney(Math.round(r.ticketRevenue / r.ticketsSold), r.currency) : formatMoney(0, r.currency);
                  return (
                    <div key={r.currency} className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-white font-medium">{r.currency}</span>
                        <span className="text-white font-medium">{formatMoney(r.totalRevenue, r.currency)}</span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-400">Event Tickets ({r.ticketsSold})</span>
                          <span className="text-slate-300">{formatMoney(r.ticketRevenue, r.currency)}</span>
                        </div>
                        <div className="w-full bg-slate-700 rounded-full h-2">
                          <div className="bg-purple-500 h-2 rounded-full" style={{ width: `${eventShare}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-400">Venue Tickets ({r.venueTicketsSold})</span>
                          <span className="text-slate-300">{formatMoney(r.venueRevenue, r.currency)}</span>
                        </div>
                        <div className="w-full bg-slate-700 rounded-full h-2">
                          <div className="bg-cyan-500 h-2 rounded-full" style={{ width: `${100 - eventShare}%` }} />
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-sm pt-1">
                        <span className="text-slate-400 flex items-center gap-1">
                          <TrendingUpIcon className="w-3.5 h-3.5" /> Avg. ticket price
                        </span>
                        <span className="text-slate-300">{avgTicketPrice}</span>
                      </div>
                    </div>
                  );
                })
              )}
              <p className="text-sm text-slate-400 pt-2 border-t border-slate-700">
                Revenue is calculated from confirmed ticket purchases only (refunded and failed payments are excluded).
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
