import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CardPaymentForm } from "@/components/payments/CardPaymentForm";
import { CheckIcon } from "@/components/ui/icons";
import { formatMoney } from "@/lib/currency";
import type { SocialBilling, SocialCurrency, SocialTier } from "@shared/socialPlans";

interface PlanCatalog {
  passDays: number;
  tiers: Array<{
    id: SocialTier;
    label: string;
    maxPlatforms: number;
    campaignsPerPass: number;
    timesPerCampaign: number;
    prices: Record<SocialCurrency, Record<SocialBilling, number>>;
  }>;
}

interface PaymentStep {
  tier: SocialTier;
  clientSecret: string;
  paymentIntentId: string;
  provider: string;
  amount: number;
}

interface Props {
  currency: string;
  onActivated: () => void;
}

// Buy a social plan: monthly (auto-renews, cheaper) or a single 30-day pass.
// Monthly redirects to the provider's hosted checkout; the plan is activated by
// the provider webhook, so the user returns to a page that refetches their plan.
export function SocialPlanPicker({ currency, onActivated }: Props) {
  const { toast } = useToast();
  const cur: SocialCurrency = currency === "NGN" ? "NGN" : "GBP";
  const [billing, setBilling] = useState<SocialBilling>("recurring");
  const [step, setStep] = useState<PaymentStep | null>(null);

  const { data: catalog, isLoading } = useQuery<PlanCatalog>({ queryKey: ["/api/social/plans"] });

  const fail = (title: string) => (error: Error) =>
    toast({ title, description: error.message, variant: "destructive" });

  const oneOffIntent = useMutation({
    mutationFn: async (tier: SocialTier) => {
      const res = await apiRequest("POST", "/api/social/plans/one-off/intent", { tier, currency: cur });
      return { tier, ...(await res.json()) } as PaymentStep & { currency: string };
    },
    onSuccess: (data) => setStep(data),
    onError: fail("Couldn't start payment"),
  });

  const oneOffConfirm = useMutation({
    mutationFn: async (s: PaymentStep) => {
      await apiRequest("POST", "/api/social/plans/one-off/confirm", {
        paymentIntentId: s.paymentIntentId,
        provider: s.provider,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/social/plans/me"] });
      toast({ title: "Plan activated", description: "You can now connect accounts and promote." });
      setStep(null);
      onActivated();
    },
    onError: fail("Payment taken but activation failed — contact support"),
  });

  const subscribe = useMutation({
    mutationFn: async (tier: SocialTier) => {
      const res = await apiRequest("POST", "/api/social/plans/subscribe", { tier, currency: cur });
      return (await res.json()) as { url: string };
    },
    onSuccess: ({ url }) => { window.location.href = url; },
    onError: fail("Couldn't start subscription"),
  });

  if (isLoading || !catalog) return <Skeleton className="h-48 w-full rounded-lg" />;

  if (step) {
    const tier = catalog.tiers.find((t) => t.id === step.tier);
    return (
      <div className="py-2">
        <CardPaymentForm
          clientSecret={step.clientSecret}
          provider={step.provider}
          amountLabel={formatMoney(step.amount, cur)}
          itemLabel={`${tier?.label ?? ""} social plan — ${catalog.passDays} days`}
          onSuccess={() => oneOffConfirm.mutate(step)}
          onCancel={() => setStep(null)}
        />
      </div>
    );
  }

  const busy = oneOffIntent.isPending || subscribe.isPending;

  return (
    <div className="space-y-3 py-2" data-testid="social-plan-picker">
      <p className="text-sm text-muted-foreground">
        Pick a plan to connect your social accounts and promote your events.
      </p>

      <div className="grid grid-cols-2 gap-1 rounded-lg border p-1" role="group" aria-label="Billing">
        {([
          ["recurring", "Monthly · cheaper"],
          ["one_off", `One-off · ${catalog.passDays} days`],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={billing === value}
            onClick={() => setBilling(value)}
            className={`rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
              billing === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
            data-testid={`button-billing-${value}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {catalog.tiers.map((tier) => (
          <div key={tier.id} className="flex items-center gap-3 rounded-lg border p-3" data-testid={`plan-${tier.id}`}>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{tier.label}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                <li className="flex items-center gap-1"><CheckIcon className="h-3 w-3" />{tier.maxPlatforms} connected platforms</li>
                <li className="flex items-center gap-1"><CheckIcon className="h-3 w-3" />{tier.campaignsPerPass} campaigns, up to {tier.timesPerCampaign} times each</li>
                <li className="flex items-center gap-1"><CheckIcon className="h-3 w-3" />X posts once per campaign</li>
              </ul>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <span className="font-semibold">
                {formatMoney(tier.prices[cur][billing], cur)}
                <span className="text-xs font-normal text-muted-foreground">{billing === "recurring" ? " /mo" : ""}</span>
              </span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => (billing === "recurring" ? subscribe.mutate(tier.id) : oneOffIntent.mutate(tier.id))}
                data-testid={`button-choose-${tier.id}`}
              >
                {busy ? "..." : "Choose"}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {billing === "recurring"
          ? "Renews every month until you cancel. Unused campaigns don't roll over."
          : "One payment, no renewal. Unused campaigns don't roll over."}
      </p>
    </div>
  );
}
