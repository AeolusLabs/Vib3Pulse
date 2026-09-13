import { useState } from "react";
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
import { CheckCircleIcon, Loader2Icon } from "@/components/ui/icons";

interface PayoutStatus {
  stripe: { detailsSubmitted: boolean; payoutsEnabled: boolean } | null;
  paystack: { detailsSubmitted: boolean; payoutsEnabled: boolean } | null;
}

interface Bank {
  name: string;
  code: string;
}

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
              <p className="text-sm text-muted-foreground">
                Your payout account is connected. Naira ticket sales will pay out to this account going forward.
              </p>
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
              <Badge variant="outline">Coming soon</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              GBP payout setup via Stripe Connect isn't available yet.
            </p>
          </CardContent>
        </Card>
      </main>
      <BottomNavigation />
    </div>
  );
}
