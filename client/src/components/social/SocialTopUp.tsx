import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CardPaymentForm } from "@/components/payments/CardPaymentForm";
import { formatMoney } from "@/lib/currency";
import type { PlanSummary } from "@/lib/socialPlans";

interface TopupPack {
  id: string;
  kind: "campaigns" | "platform";
  amount: number;
  label: string;
  prices: Record<"GBP" | "NGN", number>;
}

interface Catalog {
  topups: TopupPack[];
  maxExtraPlatforms: number;
}

interface PaymentStep {
  pack: TopupPack;
  clientSecret: string;
  paymentIntentId: string;
  provider: string;
  amount: number;
}

interface Props {
  plan: PlanSummary;
  // Which kinds to offer. The page offers both; the promote panel offers only what the
  // organizer just ran out of.
  show?: { campaigns?: boolean; platform?: boolean };
}

// Buy more of what you ran out of, for the rest of the current period. Charged in the
// currency the plan was bought in.
export function SocialTopUp({ plan, show = { campaigns: true, platform: true } }: Props) {
  const { toast } = useToast();
  const currency = plan.currency ?? "GBP";
  const [step, setStep] = useState<PaymentStep | null>(null);

  const { data: catalog } = useQuery<Catalog>({ queryKey: ["/api/social/plans"] });

  const intent = useMutation({
    mutationFn: async (pack: TopupPack) => {
      const res = await apiRequest("POST", "/api/social/topups/intent", { pack: pack.id, currency });
      return { pack, ...(await res.json()) } as PaymentStep;
    },
    onSuccess: setStep,
    onError: (e: Error) => toast({ title: "Couldn't start payment", description: e.message, variant: "destructive" }),
  });

  const confirm = useMutation({
    mutationFn: async (s: PaymentStep) => {
      await apiRequest("POST", "/api/social/topups/confirm", { paymentIntentId: s.paymentIntentId, provider: s.provider });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/social/plans/me"] });
      toast({ title: "Top-up added", description: "It's on your plan until this period ends." });
      setStep(null);
    },
    onError: (e: Error) => toast({ title: "Top-up problem", description: e.message, variant: "destructive" }),
  });

  if (!catalog) return null;

  if (step) {
    return (
      <CardPaymentForm
        clientSecret={step.clientSecret}
        provider={step.provider}
        amountLabel={formatMoney(step.amount, currency)}
        itemLabel={`Social top-up — ${step.pack.label}`}
        onSuccess={() => confirm.mutate(step)}
        onCancel={() => setStep(null)}
      />
    );
  }

  const packs = catalog.topups.filter((p) =>
    p.kind === "campaigns" ? show.campaigns : show.platform && plan.canAddPlatformTopup);
  if (packs.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="social-topup">
      <p className="text-xs font-medium text-muted-foreground">Top up</p>
      <div className="space-y-2">
        {packs.map((pack) => (
          <div key={pack.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{pack.label}</p>
              <p className="text-xs text-muted-foreground">
                {pack.kind === "campaigns" ? "Used the same way as your plan's campaigns." : "Lets you connect one more platform."}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={intent.isPending}
              onClick={() => intent.mutate(pack)}
              data-testid={`button-topup-${pack.id}`}
            >
              {formatMoney(pack.prices[currency], currency)}
            </Button>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Top-ups last until your current period ends and don't carry over.</p>
    </div>
  );
}
