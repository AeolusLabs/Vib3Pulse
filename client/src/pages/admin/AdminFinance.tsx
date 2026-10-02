import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import AdminLayout from "./AdminLayout";
import AdminDateRangePicker from "@/components/admin/AdminDateRangePicker";
import AdminFilterBar from "@/components/admin/AdminFilterBar";
import { Badge } from "@/components/ui/badge";
import {
  PoundSterlingIcon,
  TicketIcon,
  TrendingUpIcon,
  CreditCardIcon,
  InfoIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  DownloadIcon,
  EditIcon,
} from "@/components/ui/icons";
import { formatMoney } from "@/lib/currency";
import { exportToCsv } from "@/lib/exportToCsv";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface CurrencyRevenue {
  currency: string;
  ticketsSold: number;
  ticketRevenue: number;
  venueTicketsSold: number;
  venueRevenue: number;
  totalRevenue: number;
}

type LedgerType =
  | "ticket_sale"
  | "venue_ticket_sale"
  | "event_promotion"
  | "venue_promotion"
  | "social_promotion"
  | "refund";

interface LedgerRow {
  type: LedgerType;
  currency: string;
  count: number;
  grossAmount: number;
  platformFeeAmount: number;
  netToOrganizerAmount: number;
}

interface FinanceOverview {
  revenueByCurrency: CurrencyRevenue[];
  totalTicketsSold: number;
  totalVenueTicketsSold: number;
  commissionBps: number;
  ledger: LedgerRow[];
}

interface PaymentConfig {
  stripeConfigured: boolean;
  paystackConfigured: boolean;
}

interface AdminMe {
  role: string;
}

const LEDGER_TYPE_LABELS: Record<LedgerType, string> = {
  ticket_sale: "Ticket Sales",
  venue_ticket_sale: "Venue Ticket Sales",
  event_promotion: "Event Promotions",
  venue_promotion: "Venue Promotions",
  social_promotion: "Social Promotions",
  refund: "Refunds",
};

// Display order within a currency group — sales first, then promotions, then
// refunds last so the "money coming in" rows read before the "money going
// back out" row.
const LEDGER_TYPE_ORDER: LedgerType[] = [
  "ticket_sale",
  "venue_ticket_sale",
  "event_promotion",
  "venue_promotion",
  "social_promotion",
  "refund",
];

async function fetchFinanceOverview(params: { from?: Date; to?: Date; currency?: string }): Promise<FinanceOverview> {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from.toISOString());
  if (params.to) qs.set("to", params.to.toISOString());
  if (params.currency) qs.set("currency", params.currency);
  const query = qs.toString();
  const res = await fetch(`/api/admin/finance/overview${query ? `?${query}` : ""}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = text;
    try {
      const json = JSON.parse(text);
      if (json.message) message = json.message;
    } catch {
      // not JSON, use raw text
    }
    throw new Error(message);
  }
  return res.json();
}

export default function AdminFinance() {
  const { toast } = useToast();
  const [dateRange, setDateRange] = useState<{ from?: Date; to?: Date }>({});
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const [commissionDialogOpen, setCommissionDialogOpen] = useState(false);
  const [commissionPercentInput, setCommissionPercentInput] = useState("");

  const { data: adminUser } = useQuery<AdminMe>({
    queryKey: ["/api/admin/me"],
  });

  const financeQueryKey = [
    "/api/admin/finance/overview",
    dateRange.from?.toISOString() ?? null,
    dateRange.to?.toISOString() ?? null,
    currency ?? null,
  ] as const;

  const { data: finance, isLoading } = useQuery<FinanceOverview>({
    queryKey: financeQueryKey,
    queryFn: () => fetchFinanceOverview({ from: dateRange.from, to: dateRange.to, currency }),
  });

  const { data: paymentConfig } = useQuery<PaymentConfig>({
    queryKey: ["/api/payments/config"],
  });

  const canEditCommission = adminUser?.role === "super_admin" || adminUser?.role === "finance_manager";

  const commissionMutation = useMutation({
    mutationFn: async (commissionBps: number) => {
      const res = await apiRequest("PATCH", "/api/admin/finance/commission-rate", { commissionBps });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Commission rate updated", description: "The new rate applies to checkouts from now on." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/finance/overview"] });
      setCommissionDialogOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Couldn't update commission rate",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const openCommissionDialog = () => {
    setCommissionPercentInput((((finance?.commissionBps ?? 0) / 100).toString()));
    setCommissionDialogOpen(true);
  };

  const handleSaveCommission = () => {
    const percent = parseFloat(commissionPercentInput);
    if (isNaN(percent) || percent < 0 || percent > 50) {
      toast({ title: "Invalid rate", description: "Enter a percentage between 0 and 50.", variant: "destructive" });
      return;
    }
    const commissionBps = Math.round(percent * 100);
    commissionMutation.mutate(commissionBps);
  };

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
  const ledger = finance?.ledger ?? [];

  const sortedLedger = useMemo(() => {
    return [...ledger].sort((a, b) => {
      if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
      return LEDGER_TYPE_ORDER.indexOf(a.type) - LEDGER_TYPE_ORDER.indexOf(b.type);
    });
  }, [ledger]);

  const handleExportLedger = () => {
    const rows = sortedLedger.map((row) => ({
      currency: row.currency,
      type: row.type,
      label: LEDGER_TYPE_LABELS[row.type] || row.type,
      count: row.count,
      grossAmount: formatMoney(row.grossAmount, row.currency),
      platformFeeAmount: formatMoney(row.platformFeeAmount, row.currency),
      netToOrganizerAmount: formatMoney(row.netToOrganizerAmount, row.currency),
    }));
    exportToCsv(`finance-ledger-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  };

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

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Finance Overview</h1>
            <p className="text-slate-400 mt-1">
              Platform revenue and payment statistics
            </p>
          </div>
          {canEditCommission && (
            <Button
              variant="outline"
              className="border-slate-600 text-slate-200 hover:text-white gap-2"
              onClick={openCommissionDialog}
              data-testid="button-edit-commission-rate"
            >
              <EditIcon className="w-4 h-4" />
              Commission Rate{finance ? `: ${(finance.commissionBps / 100).toFixed(2)}%` : ""}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <AdminDateRangePicker
            from={dateRange.from}
            to={dateRange.to}
            onChange={setDateRange}
          />
          <AdminFilterBar currency={currency} onCurrencyChange={setCurrency} />
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

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className="text-white">Ledger Breakdown</CardTitle>
              <p className="text-sm text-slate-400 mt-1">
                Every transaction type in the payments ledger — gross amount, platform fee, and organizer net.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-slate-600 text-slate-200 hover:text-white gap-2"
              onClick={handleExportLedger}
              disabled={sortedLedger.length === 0}
              data-testid="button-export-ledger-csv"
            >
              <DownloadIcon className="w-4 h-4" />
              Export CSV
            </Button>
          </CardHeader>
          <CardContent>
            {sortedLedger.length === 0 ? (
              <p className="text-sm text-slate-400">No ledger transactions in this range.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">Currency</TableHead>
                    <TableHead className="text-slate-400">Type</TableHead>
                    <TableHead className="text-slate-400 text-right">Count</TableHead>
                    <TableHead className="text-slate-400 text-right">Gross</TableHead>
                    <TableHead className="text-slate-400 text-right">Platform Fee</TableHead>
                    <TableHead className="text-slate-400 text-right">Organizer Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedLedger.map((row) => (
                    <TableRow key={`${row.currency}-${row.type}`} className="border-slate-700">
                      <TableCell className="text-slate-300 font-medium">{row.currency}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={row.type === "refund" ? "border-red-500 text-red-400" : "border-slate-500 text-slate-300"}
                        >
                          {LEDGER_TYPE_LABELS[row.type] || row.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-slate-300">{row.count}</TableCell>
                      <TableCell className="text-right text-white">{formatMoney(row.grossAmount, row.currency)}</TableCell>
                      <TableCell className="text-right text-slate-300">{formatMoney(row.platformFeeAmount, row.currency)}</TableCell>
                      <TableCell className="text-right text-emerald-400">{formatMoney(row.netToOrganizerAmount, row.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={commissionDialogOpen} onOpenChange={setCommissionDialogOpen}>
        <DialogContent className="bg-slate-800 border-slate-700">
          <DialogHeader>
            <DialogTitle className="text-white">Edit Commission Rate</DialogTitle>
            <DialogDescription className="text-slate-400">
              The platform commission percentage applied to new checkouts. Takes effect immediately — no deploy required.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label className="text-slate-300">Commission (%)</Label>
            <Input
              type="number"
              min={0}
              max={50}
              step={0.1}
              value={commissionPercentInput}
              onChange={(e) => setCommissionPercentInput(e.target.value)}
              className="bg-slate-700/50 border-slate-600 text-white"
              data-testid="input-commission-percent"
            />
            <p className="text-xs text-slate-500">Enter a value between 0 and 50.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommissionDialogOpen(false)} className="border-slate-600">
              Cancel
            </Button>
            <Button
              onClick={handleSaveCommission}
              disabled={commissionMutation.isPending}
              className="bg-purple-600 hover:bg-purple-700"
              data-testid="button-confirm-commission-rate"
            >
              {commissionMutation.isPending ? "Saving..." : "Save Rate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
