import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { MegaphoneIcon, SparklesIcon, CheckIcon } from "@/components/ui/icons";
import { CardPaymentForm } from "@/components/payments/CardPaymentForm";
import { formatMoney } from "@/lib/currency";

interface PromoteEventDialogProps {
  eventId: string;
  eventTitle: string;
  currency: string;
  isOpen: boolean;
  onClose: () => void;
}

const promotionMeta = [
  { days: 3, label: "3 Days", description: "Quick boost for upcoming events" },
  { days: 7, label: "1 Week", description: "Standard promotion period" },
  { days: 14, label: "2 Weeks", description: "Extended visibility" },
  { days: 30, label: "1 Month", description: "Maximum exposure" },
];

export function PromoteEventDialog({ eventId, eventTitle, currency, isOpen, onClose }: PromoteEventDialogProps) {
  // Fetched, not hardcoded — a client-side price table previously drifted
  // from what the server actually charged once NGN got its own real pricing
  // (it always showed "£X.XX" regardless of the event's currency).
  const { data: promotionPrices } = useQuery<Record<string, Record<number, number>>>({
    queryKey: ["/api/payments/promotion-prices"],
  });
  const pricesForCurrency = promotionPrices?.[currency] ?? {};
  const promotionOptions = promotionMeta.map(m => ({ ...m, amount: pricesForCurrency[m.days] ?? 0 }));
  const [selectedDuration, setSelectedDuration] = useState<number>(7);
  const [paymentStep, setPaymentStep] = useState<"select" | "pay">("select");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>("stripe");
  const { toast } = useToast();

  const handleClose = () => {
    setPaymentStep("select");
    setClientSecret(null);
    setPaymentIntentId(null);
    setProvider("stripe");
    onClose();
  };

  const invalidateEventQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/events'] });
    queryClient.invalidateQueries({ queryKey: ['/api/events/my-events'] });
  };

  const intentMutation = useMutation({
    mutationFn: async (durationDays: number) => {
      const response = await apiRequest("POST", "/api/payments/event/promote/intent", { eventId, durationDays });
      return response.json();
    },
    onSuccess: (data) => {
      if (data.free) {
        invalidateEventQueries();
        toast({ title: "Event Promoted!", description: "Used a free promotion credit." });
        handleClose();
        return;
      }
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
      setProvider(data.provider ?? "stripe");
      setPaymentStep("pay");
    },
    onError: (error: Error) => {
      toast({
        title: "Promotion Failed",
        description: error.message || "Failed to start promotion payment",
        variant: "destructive",
      });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/payments/event/promote/confirm", {
        eventId,
        durationDays: selectedDuration,
        paymentIntentId,
        provider,
      });
    },
    onSuccess: () => {
      invalidateEventQueries();
      toast({
        title: "Event Promoted!",
        description: `Your event will be featured for ${selectedDuration} days.`,
      });
      handleClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Promotion Failed",
        description: error.message || "Failed to confirm promotion payment",
        variant: "destructive",
      });
    },
  });

  const selectedOption = promotionOptions.find(o => o.days === selectedDuration)!;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-promote-event">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MegaphoneIcon className="h-5 w-5 text-primary" />
            Promote Event
          </DialogTitle>
          <DialogDescription>
            Boost visibility for "{eventTitle}" by featuring it at the top of feeds and discover pages.
          </DialogDescription>
        </DialogHeader>

        {paymentStep === "select" ? (
          <>
            <div className="py-4">
              <RadioGroup
                value={selectedDuration.toString()}
                onValueChange={(value) => setSelectedDuration(parseInt(value))}
                className="space-y-3"
              >
                {promotionOptions.map((option) => (
                  <div
                    key={option.days}
                    className="flex items-center space-x-3 rounded-lg border p-4 cursor-pointer hover-elevate"
                    onClick={() => setSelectedDuration(option.days)}
                    data-testid={`option-duration-${option.days}`}
                  >
                    <RadioGroupItem value={option.days.toString()} id={`duration-${option.days}`} />
                    <Label
                      htmlFor={`duration-${option.days}`}
                      className="flex-1 cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{option.label}</p>
                          <p className="text-sm text-muted-foreground">{option.description}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{formatMoney(option.amount, currency)}</span>
                          {selectedDuration === option.days && (
                            <CheckIcon className="h-5 w-5 text-primary" />
                          )}
                        </div>
                      </div>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="bg-muted rounded-lg p-4">
              <div className="flex items-start gap-3">
                <SparklesIcon className="h-5 w-5 text-primary mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">What you get:</p>
                  <ul className="text-muted-foreground mt-1 space-y-1">
                    <li>Featured placement in event feeds</li>
                    <li>Priority in search results</li>
                    <li>Special "Featured" badge</li>
                    <li>Analytics to track performance</li>
                  </ul>
                </div>
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={handleClose} data-testid="button-cancel-promote">
                Cancel
              </Button>
              <Button
                onClick={() => intentMutation.mutate(selectedDuration)}
                disabled={intentMutation.isPending}
                data-testid="button-confirm-promote"
              >
                {intentMutation.isPending ? "Processing..." : `Promote for ${formatMoney(selectedOption.amount, currency)}`}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="py-4">
            {clientSecret && (
              <CardPaymentForm
                clientSecret={clientSecret}
                provider={provider}
                amountLabel={formatMoney(selectedOption.amount, currency)}
                itemLabel={`Promotion — ${selectedOption.label}`}
                onSuccess={() => confirmMutation.mutate()}
                onCancel={() => setPaymentStep("select")}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
