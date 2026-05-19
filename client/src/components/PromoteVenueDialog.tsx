import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SparklesIcon, CheckIcon, ZapIcon, CrownIcon, RocketIcon, AlertCircleIcon } from "@/components/ui/icons";

interface PromoteVenueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venueId: string;
  venueName: string;
}

const promotionPackages = [
  {
    duration: 3,
    price: 9.99,
    label: "3 Days",
    icon: Zap,
    popular: false,
    description: "Quick visibility boost"
  },
  {
    duration: 7,
    price: 19.99,
    label: "1 Week",
    icon: Sparkles,
    popular: true,
    description: "Best for weekend events"
  },
  {
    duration: 14,
    price: 34.99,
    label: "2 Weeks",
    icon: Crown,
    popular: false,
    description: "Extended exposure"
  },
  {
    duration: 30,
    price: 59.99,
    label: "1 Month",
    icon: Rocket,
    popular: false,
    description: "Maximum impact"
  },
];

export function PromoteVenueDialog({ open, onOpenChange, venueId, venueName }: PromoteVenueDialogProps) {
  const [selectedPackage, setSelectedPackage] = useState(7);
  const [paymentStep, setPaymentStep] = useState<"select" | "pay">("select");
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>("stripe");
  const [processing, setProcessing] = useState(false);
  const { toast } = useToast();

  const intentMutation = useMutation({
    mutationFn: async (durationDays: number) => {
      const res = await apiRequest("POST", "/api/payments/venue/promote/intent", { venueId, durationDays });
      return res.json();
    },
    onSuccess: (data) => {
      setPaymentIntentId(data.paymentIntentId);
      setProvider(data.provider ?? "stripe");
      setPaymentStep("pay");
    },
    onError: () => {
      toast({ title: "Failed to start promotion payment", variant: "destructive" });
    },
  });

  const handleClose = () => {
    setPaymentStep("select");
    setPaymentIntentId(null);
    setProvider("stripe");
    onOpenChange(false);
  };

  const handleConfirmPayment = async () => {
    if (!paymentIntentId) return;
    setProcessing(true);
    try {
      await apiRequest("POST", "/api/payments/venue/promote/confirm", {
        venueId,
        durationDays: selectedPackage,
        paymentIntentId,
        provider,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/my-venues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/venues/promoted"] });
      toast({ title: "Venue promoted successfully!", description: "Your venue is now featured." });
      handleClose();
    } catch {
      toast({ title: "Failed to confirm promotion payment", variant: "destructive" });
    }
    setProcessing(false);
  };

  const selectedPkg = promotionPackages.find(p => p.duration === selectedPackage)!;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl flex items-center gap-2">
            <SparklesIcon className="h-6 w-6 text-purple-500" />
            Promote Your Venue
          </DialogTitle>
          <DialogDescription>
            Feature "{venueName}" to reach more customers and increase visibility
          </DialogDescription>
        </DialogHeader>

        {paymentStep === "select" ? (
          <>
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                {promotionPackages.map((pkg) => (
                  <Card
                    key={pkg.duration}
                    className={`p-4 cursor-pointer transition-all hover-elevate ${
                      selectedPackage === pkg.duration
                        ? "ring-2 ring-purple-500 bg-purple-50/50 dark:bg-purple-950/20"
                        : ""
                    }`}
                    onClick={() => setSelectedPackage(pkg.duration)}
                    data-testid={`card-promo-${pkg.duration}`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <pkg.icon className={`h-5 w-5 ${selectedPackage === pkg.duration ? "text-purple-500" : "text-muted-foreground"}`} />
                      {pkg.popular && (
                        <Badge className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                          Popular
                        </Badge>
                      )}
                      {selectedPackage === pkg.duration && !pkg.popular && (
                        <CheckIcon className="h-4 w-4 text-purple-500" />
                      )}
                    </div>
                    <div className="font-semibold">{pkg.label}</div>
                    <div className="text-2xl font-bold text-purple-600">£{pkg.price}</div>
                    <div className="text-xs text-muted-foreground mt-1">{pkg.description}</div>
                  </Card>
                ))}
              </div>

              <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                <h4 className="font-semibold text-sm">What you get:</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li className="flex items-center gap-2">
                    <CheckIcon className="h-4 w-4 text-green-500" />
                    Featured placement on Discover page
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckIcon className="h-4 w-4 text-green-500" />
                    Priority in search results
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckIcon className="h-4 w-4 text-green-500" />
                    Special "Featured" badge
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckIcon className="h-4 w-4 text-green-500" />
                    Analytics dashboard access
                  </li>
                </ul>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} data-testid="button-cancel-promote">
                Cancel
              </Button>
              <Button
                onClick={() => intentMutation.mutate(selectedPackage)}
                disabled={intentMutation.isPending}
                className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
                data-testid="button-confirm-promote"
              >
                {intentMutation.isPending ? "Processing..." : `Promote for £${selectedPkg.price}`}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="space-y-4 py-4">
            <div className="rounded-lg border border-dashed border-amber-500/50 bg-amber-50 dark:bg-amber-950/20 p-4">
              <div className="flex items-start gap-3">
                <AlertCircleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-amber-800 dark:text-amber-200">Demo Mode</p>
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Payments are simulated. No real charges will be made.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Promotion — {selectedPkg.label}</span>
                <span>£{selectedPkg.price}</span>
              </div>
              <div className="border-t pt-3 flex justify-between font-medium">
                <span>Total</span>
                <span>£{selectedPkg.price}</span>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setPaymentStep("select")} disabled={processing}>
                Back
              </Button>
              <Button
                onClick={handleConfirmPayment}
                disabled={processing}
                className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
                data-testid="button-confirm-promote-payment"
              >
                {processing ? "Processing..." : `Pay £${selectedPkg.price}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
