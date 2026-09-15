import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatMoney } from "@/lib/currency";
import { format } from "date-fns";
import { CheckCircleIcon, Loader2Icon, ArrowRightIcon } from "@/components/ui/icons";
import type { PaymentTransaction } from "@shared/schema";

interface ProviderStatus {
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  payoutSchedule?: string;
}

interface PayoutStatus {
  stripe: ProviderStatus | null;
  paystack: ProviderStatus | null;
}

interface Bank {
  name: string;
  code: string;
}

const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  ticket_sale: "Ticket sale",
  venue_ticket_sale: "Venue entry sale",
  event_promotion: "Event promotion",
  venue_promotion: "Venue promotion",
  refund: "Refund",
};

export default function OrganizerPayoutsPage() {
  const { toast } = useToast();
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [resolvedName, setResolvedName] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading } = useQuery<PayoutStatus>({
    queryKey: ["/api/organizer/payments/status"],
  });

  const { data: bankData, isLoading: banksLoading } = useQuery<{ banks: Bank[] }>({
    queryKey: ["/api/organizer/payments/paystack/banks"],
    enabled: !status?.paystack?.payoutsEnabled,
  });

  const { data: txData, isLoading: txLoading } = useQuery<{ transactions: PaymentTransaction[] }>({
    queryKey: ["/api/organizer/payments/transactions"],
  });

  // Returning from Stripe's hosted onboarding (or an expired-link refresh) —
  // the status query above always re-checks live against Stripe, so a
  // refetch is enough; just clean the query param so a page reload doesn't
  // re-trigger this.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("stripe")) {
      queryClient.invalidateQueries({ queryKey: ["/api/organizer/payments/status"] });
      window.history.replaceState({}, "", "/organizer/payouts");
    }
  }, []);

  const stripeOnboardMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/organizer/payments/stripe/onboard", {});
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error: any) => {
      toast({ title: "Couldn't start Stripe onboarding", description: error.message, variant: "destructive" });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/organizer/payments/paystack/resolve-account", {
        accountNumber,
        bankCode,
      });
      return res.json() as Promise<{ accountName: string }>;
    },
    onSuccess: (data) => {
      setResolvedName(data.accountName);
      toast({ title: "Account verified", description: data.accountName });
    },
    onError: (error: any) => {
      setResolvedName(null);
      toast({ title: "Could not verify account", description: error.message, variant: "destructive" });
    },
  });

  const onboardMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/organizer/payments/paystack/onboard", {
        accountNumber,
        bankCode,
        businessName: businessName || resolvedName || "VibePulse Organizer",
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Payout account connected", description: "You're set up to receive Naira ticket revenue." });
      queryClient.invalidateQueries({ queryKey: ["/api/organizer/payments/status"] });
    },
    onError: (error: any) => {
      toast({ title: "Connection failed", description: error.message, variant: "destructive" });
    },
  });

  const paystackConnected = !!status?.paystack?.payoutsEnabled;
  const stripeConnected = !!status?.stripe?.payoutsEnabled;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-2xl mx-auto px-4 py-6 pb-24 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Payouts</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Connect a payout account so ticket revenue can be paid out to you directly.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Paystack (Naira payouts)</CardTitle>
                <CardDescription>For events priced in NGN</CardDescription>
              </div>
              {statusLoading ? (
                <Loader2Icon className="w-5 h-5 animate-spin text-muted-foreground" />
              ) : paystackConnected ? (
                <Badge className="bg-emerald-500/20 text-emerald-500 border-emerald-500/30">
                  <CheckCircleIcon className="w-3.5 h-3.5 mr-1" /> Connected
                </Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {paystackConnected ? (
              <div className="text-sm text-muted-foreground space-y-1">
                <p>Your payout account is connected. Naira ticket sales will pay out to this account going forward.</p>
                {status?.paystack?.payoutSchedule && <p className="text-xs">{status.paystack.payoutSchedule}</p>}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="bank">Bank</Label>
                  <select
                    id="bank"
                    className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={bankCode}
                    onChange={(e) => { setBankCode(e.target.value); setResolvedName(null); }}
                    disabled={banksLoading}
                    data-testid="select-bank"
                  >
                    <option value="">{banksLoading ? "Loading banks..." : "Select your bank"}</option>
                    {bankData?.banks.map((bank) => (
                      <option key={bank.code} value={bank.code}>{bank.name}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="accountNumber">Account number</Label>
                  <Input
                    id="accountNumber"
                    value={accountNumber}
                    onChange={(e) => { setAccountNumber(e.target.value); setResolvedName(null); }}
                    placeholder="0123456789"
                    data-testid="input-account-number"
                  />
                </div>

                <Button
                  type="button"
                  variant="outline"
                  onClick={() => resolveMutation.mutate()}
                  disabled={!bankCode || accountNumber.length < 5 || resolveMutation.isPending}
                  data-testid="button-verify-account"
                >
                  {resolveMutation.isPending ? "Verifying..." : "Verify account"}
                </Button>

                {resolvedName && (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                    Account name: <span className="font-medium">{resolvedName}</span>
                  </div>
                )}

                {resolvedName && (
                  <div className="space-y-2">
                    <Label htmlFor="businessName">Payout name (shown on your statements)</Label>
                    <Input
                      id="businessName"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder={resolvedName}
                      data-testid="input-business-name"
                    />
                  </div>
                )}

                <Button
                  type="button"
                  onClick={() => onboardMutation.mutate()}
                  disabled={!resolvedName || onboardMutation.isPending}
                  data-testid="button-connect-payout"
                >
                  {onboardMutation.isPending ? "Connecting..." : "Connect payout account"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Stripe (GBP payouts)</CardTitle>
                <CardDescription>For events priced in GBP</CardDescription>
              </div>
              {statusLoading ? (
                <Loader2Icon className="w-5 h-5 animate-spin text-muted-foreground" />
              ) : stripeConnected ? (
                <Badge className="bg-emerald-500/20 text-emerald-500 border-emerald-500/30">
                  <CheckCircleIcon className="w-3.5 h-3.5 mr-1" /> Connected
                </Badge>
              ) : status?.stripe?.detailsSubmitted ? (
                <Badge variant="outline">Pending review</Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {stripeConnected ? (
              <div className="text-sm text-muted-foreground space-y-1">
                <p>Your payout account is connected. GBP ticket sales will pay out to this account going forward.</p>
                {status?.stripe?.payoutSchedule && <p className="text-xs">{status.stripe.payoutSchedule}</p>}
              </div>
            ) : status?.stripe?.detailsSubmitted ? (
              <p className="text-sm text-muted-foreground">
                Your details are submitted and Stripe is reviewing your account. This can take a little while — check back soon.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect a Stripe account to receive GBP ticket revenue. You'll be taken to Stripe to enter your bank and identity details.
              </p>
            )}
            <Button
              type="button"
              variant={stripeConnected ? "outline" : "default"}
              onClick={() => stripeOnboardMutation.mutate()}
              disabled={stripeOnboardMutation.isPending}
              data-testid="button-connect-stripe"
            >
              {stripeOnboardMutation.isPending ? "Redirecting…" : stripeConnected ? (
                <>Manage on Stripe <ArrowRightIcon className="w-4 h-4 ml-2" /></>
              ) : status?.stripe?.detailsSubmitted ? (
                <>Continue setup <ArrowRightIcon className="w-4 h-4 ml-2" /></>
              ) : (
                <>Connect with Stripe <ArrowRightIcon className="w-4 h-4 ml-2" /></>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payout History</CardTitle>
            <CardDescription>Every ticket sale, promotion charge, and refund across both providers</CardDescription>
          </CardHeader>
          <CardContent>
            {txLoading ? (
              <div className="flex justify-center py-8">
                <Loader2Icon className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : !txData?.transactions.length ? (
              <p className="text-sm text-muted-foreground text-center py-4">No transactions yet.</p>
            ) : (
              <div className="space-y-1">
                {txData.transactions.map((tx) => (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between py-2.5 border-b last:border-b-0 text-sm"
                    data-testid={`row-transaction-${tx.id}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">
                        {TRANSACTION_TYPE_LABELS[tx.type] ?? tx.type}
                        {tx.status !== "succeeded" && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({tx.status === "refunded" ? "refunded" : "refund failed"})
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(tx.createdAt), "MMM d, yyyy")} · {tx.provider === "stripe" ? "Stripe" : tx.provider === "paystack" ? "Paystack" : "Free"}
                      </p>
                    </div>
                    <p className={`font-semibold flex-shrink-0 ${tx.type === "refund" ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}`}>
                      {tx.type === "refund" ? "-" : ""}{formatMoney(tx.netToOrganizerAmount, tx.currency)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <BottomNavigation />
    </div>
  );
}
