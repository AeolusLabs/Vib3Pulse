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
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useOAuthPopup } from "@/hooks/useOAuthPopup";
import { PLATFORM_LABELS, PLATFORM_COLORS, platformInitial } from "@/lib/socialPlatforms";
import {
  MegaphoneIcon,
  SparklesIcon,
  CheckIcon,
  GlobeIcon,
  CheckCircleIcon,
  XCircleIcon,
  XIcon,
  ExternalLinkIcon,
} from "@/components/ui/icons";
import { CardPaymentForm } from "@/components/payments/CardPaymentForm";
import { formatMoney } from "@/lib/currency";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "@shared/schema";

interface PromoteEventDialogProps {
  eventId: string;
  eventTitle: string;
  currency: string;
  isPromoted?: boolean;
  promotedUntil?: Date | null;
  isOpen: boolean;
  onClose: () => void;
}

interface ConnectedSocial {
  platform: string;
  handle: string | null;
  connectedAt: string;
}

interface PromoteResult {
  postsCreated: number;
  totalCostUsd: number;
  platforms: Array<{ platform: string; success: boolean; error?: string }>;
}

const promotionMeta = [
  { days: 3, label: "3 Days", description: "Quick boost for upcoming events" },
  { days: 7, label: "1 Week", description: "Standard promotion period" },
  { days: 14, label: "2 Weeks", description: "Extended visibility" },
  { days: 30, label: "1 Month", description: "Maximum exposure" },
];

type Mode = "choice" | "inapp" | "social";

export function PromoteEventDialog({ eventId, eventTitle, currency, isPromoted, promotedUntil, isOpen, onClose }: PromoteEventDialogProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("choice");

  // Fetched, not hardcoded — a client-side price table previously drifted
  // from what the server actually charged once NGN got its own real pricing.
  // Also carries the flat social-promotion fee (`.social`) alongside the
  // per-duration in-app tiers.
  const { data: promotionPrices } = useQuery<Record<string, Record<string, number>>>({
    queryKey: ["/api/payments/promotion-prices"],
  });
  const pricesForCurrency = promotionPrices?.[currency] ?? {};
  const socialPrice = pricesForCurrency.social ?? 0;

  // ── In-app promotion state ────────────────────────────────────────────────
  const promotionOptions = promotionMeta.map(m => ({ ...m, amount: pricesForCurrency[m.days] ?? 0 }));
  const [selectedDuration, setSelectedDuration] = useState<number>(7);
  const [paymentStep, setPaymentStep] = useState<"select" | "pay">("select");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>("stripe");

  // ── Social promotion state ────────────────────────────────────────────────
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<SocialPlatform>>(new Set());
  const [socialPaymentStep, setSocialPaymentStep] = useState<"select" | "pay">("select");
  const [socialClientSecret, setSocialClientSecret] = useState<string | null>(null);
  const [socialPaymentIntentId, setSocialPaymentIntentId] = useState<string | null>(null);
  const [socialProvider, setSocialProvider] = useState<string>("stripe");
  const [socialResult, setSocialResult] = useState<PromoteResult | null>(null);

  const {
    data: connected = [],
    isLoading: socialsLoading,
    refetch: refetchSocials,
  } = useQuery<ConnectedSocial[]>({
    queryKey: ["/api/organizer/connected-socials"],
    enabled: isOpen && mode === "social",
  });
  const connectedSet = new Set(connected.map((c) => c.platform));

  const openOAuthPopup = useOAuthPopup(() => {
    refetchSocials();
    toast({ title: "Account connected", description: "Your social account was linked." });
  });

  const disconnectMutation = useMutation({
    mutationFn: (platform: string) =>
      apiRequest("POST", "/api/organizer/disconnect-social", { platform }),
    onSuccess: (_data, platform) => {
      toast({ title: "Disconnected", description: `${PLATFORM_LABELS[platform] ?? platform} removed.` });
      queryClient.invalidateQueries({ queryKey: ["/api/organizer/connected-socials"] });
      setSelectedPlatforms((prev) => {
        const next = new Set(prev);
        next.delete(platform as SocialPlatform);
        return next;
      });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to disconnect account.", variant: "destructive" });
    },
  });

  const togglePlatform = (platform: SocialPlatform) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      next.has(platform) ? next.delete(platform) : next.add(platform);
      return next;
    });
  };

  const handleClose = () => {
    setMode("choice");
    setPaymentStep("select");
    setClientSecret(null);
    setPaymentIntentId(null);
    setProvider("stripe");
    setSelectedPlatforms(new Set());
    setSocialPaymentStep("select");
    setSocialClientSecret(null);
    setSocialPaymentIntentId(null);
    setSocialProvider("stripe");
    setSocialResult(null);
    onClose();
  };

  const invalidateEventQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/events'] });
    queryClient.invalidateQueries({ queryKey: ['/api/events/my-events'] });
  };

  // ── In-app promotion mutations ────────────────────────────────────────────
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

  // ── Social promotion mutations ────────────────────────────────────────────
  const socialIntentMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/payments/event/promote-social/intent", {
        eventId,
        platforms: Array.from(selectedPlatforms),
      });
      return response.json();
    },
    onSuccess: (data) => {
      setSocialClientSecret(data.clientSecret);
      setSocialPaymentIntentId(data.paymentIntentId);
      setSocialProvider(data.provider ?? "stripe");
      setSocialPaymentStep("pay");
    },
    onError: (error: Error) => {
      toast({
        title: "Promotion Failed",
        description: error.message || "Failed to start social promotion payment",
        variant: "destructive",
      });
    },
  });

  const socialConfirmMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/payments/event/promote-social/confirm", {
        eventId,
        paymentIntentId: socialPaymentIntentId,
        provider: socialProvider,
      });
      return (await response.json()) as PromoteResult;
    },
    onSuccess: (data) => {
      setSocialResult(data);
      const failed = data.platforms.filter((p) => !p.success);
      if (failed.length === 0) {
        toast({
          title: "Promoted!",
          description: `Posted to ${data.postsCreated} platform${data.postsCreated !== 1 ? "s" : ""}.`,
        });
      } else {
        toast({
          title: `Partially posted (${data.postsCreated}/${data.platforms.length})`,
          description: `${failed.length} platform${failed.length !== 1 ? "s" : ""} failed.`,
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Promote failed",
        description: error.message || "Something went wrong. Try again.",
        variant: "destructive",
      });
    },
  });

  const selectedOption = promotionOptions.find(o => o.days === selectedDuration)!;
  const canPromoteSocial = selectedPlatforms.size > 0 && !socialIntentMutation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-promote-event">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MegaphoneIcon className="h-5 w-5 text-primary" />
            Promote Event
          </DialogTitle>
          <DialogDescription>
            Boost visibility for "{eventTitle}".
          </DialogDescription>
        </DialogHeader>

        {mode === "choice" && (
          <>
            <div className="py-2 space-y-3">
              <button
                type="button"
                className="w-full text-left flex items-center gap-3 rounded-lg border p-4 hover-elevate"
                onClick={() => setMode("inapp")}
                data-testid="button-choose-inapp"
              >
                <MegaphoneIcon className="h-6 w-6 text-primary flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">Promote in App</p>
                  <p className="text-sm text-muted-foreground">Feature in feeds & search — Free for now</p>
                </div>
              </button>
              <button
                type="button"
                className="w-full text-left flex items-center gap-3 rounded-lg border p-4 hover-elevate"
                onClick={() => setMode("social")}
                data-testid="button-choose-social"
              >
                <GlobeIcon className="h-6 w-6 text-primary flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">Zernio Social Promotion</p>
                  <p className="text-sm text-muted-foreground">
                    Blast to your connected social accounts — {socialPrice > 0 ? formatMoney(socialPrice, currency) : "Paid"}
                  </p>
                </div>
              </button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose} data-testid="button-cancel-promote">
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {mode === "inapp" && isPromoted && (
          <>
            <div className="py-6 text-center space-y-1">
              <SparklesIcon className="h-6 w-6 text-primary mx-auto" />
              <p className="font-medium">Already promoted</p>
              <p className="text-sm text-muted-foreground">
                {promotedUntil
                  ? `Featured until ${promotedUntil.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`
                  : "This event is currently featured in-app."}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setMode("choice")} data-testid="button-back-promote">
                Back
              </Button>
            </DialogFooter>
          </>
        )}

        {mode === "inapp" && !isPromoted && (
          paymentStep === "select" ? (
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
                      <Label htmlFor={`duration-${option.days}`} className="flex-1 cursor-pointer">
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
                <Button variant="outline" onClick={() => setMode("choice")} data-testid="button-back-promote">
                  Back
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
          )
        )}

        {mode === "social" && !socialResult && socialPaymentStep === "select" && (
          <>
            <div className="py-2 space-y-4">
              {connected.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Connected accounts</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {connected.map((acct) => (
                      <label
                        key={acct.platform}
                        className="flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer hover:bg-muted/40 transition-colors"
                      >
                        <Checkbox
                          checked={selectedPlatforms.has(acct.platform as SocialPlatform)}
                          onCheckedChange={() => togglePlatform(acct.platform as SocialPlatform)}
                        />
                        <span
                          className={`h-5 w-5 rounded-full bg-gradient-to-br ${PLATFORM_COLORS[acct.platform] ?? "from-zinc-400 to-zinc-600"} flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0`}
                        >
                          {platformInitial(acct.platform)}
                        </span>
                        <span className="text-sm truncate flex-1">{PLATFORM_LABELS[acct.platform] ?? acct.platform}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); disconnectMutation.mutate(acct.platform); }}
                          disabled={disconnectMutation.isPending}
                          className="flex-shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                          title={`Disconnect ${PLATFORM_LABELS[acct.platform]}`}
                        >
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {connected.length > 0 ? "Connect more accounts" : "Connect an account to get started"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {socialsLoading ? (
                    <Skeleton className="h-7 w-24 rounded-md" />
                  ) : (
                    SOCIAL_PLATFORMS.filter((p) => !connectedSet.has(p)).map((platform) => (
                      <Button
                        key={platform}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => openOAuthPopup(platform)}
                        data-testid={`button-connect-${platform}`}
                      >
                        <ExternalLinkIcon className="h-3 w-3" />
                        {PLATFORM_LABELS[platform] ?? platform}
                      </Button>
                    ))
                  )}
                </div>
              </div>

              {connected.length === 0 && !socialsLoading && (
                <p className="text-sm text-muted-foreground text-center py-2">
                  Connect at least one account above to enable promotion.
                </p>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setMode("choice")} data-testid="button-back-social">
                Back
              </Button>
              <Button
                disabled={!canPromoteSocial}
                onClick={() => socialIntentMutation.mutate()}
                data-testid="button-confirm-social-promote"
              >
                {socialIntentMutation.isPending
                  ? "Processing..."
                  : `Promote via Zernio for ${formatMoney(socialPrice, currency)}`}
              </Button>
            </DialogFooter>
          </>
        )}

        {mode === "social" && !socialResult && socialPaymentStep === "pay" && (
          <div className="py-4">
            {socialClientSecret && (
              <CardPaymentForm
                clientSecret={socialClientSecret}
                provider={socialProvider}
                amountLabel={formatMoney(socialPrice, currency)}
                itemLabel="Zernio Social Promotion"
                onSuccess={() => socialConfirmMutation.mutate()}
                onCancel={() => setSocialPaymentStep("select")}
              />
            )}
          </div>
        )}

        {mode === "social" && socialResult && (
          <>
            <div className="py-2 space-y-2">
              <p className="text-sm">
                <span className="font-semibold text-green-500">{socialResult.postsCreated}</span>
                {" "}posted
              </p>
              <div className="space-y-1.5">
                {socialResult.platforms.map((result) => (
                  <div
                    key={result.platform}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-5 w-5 rounded-full bg-gradient-to-br ${PLATFORM_COLORS[result.platform] ?? "from-zinc-400 to-zinc-600"} flex items-center justify-center text-white text-[10px] font-bold`}
                      >
                        {platformInitial(result.platform)}
                      </span>
                      <span>{PLATFORM_LABELS[result.platform] ?? result.platform}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {result.success ? (
                        <>
                          <CheckCircleIcon className="h-4 w-4 text-green-500" />
                          <span className="text-green-500 text-xs">Posted</span>
                        </>
                      ) : (
                        <>
                          <XCircleIcon className="h-4 w-4 text-destructive" />
                          <span className="text-destructive text-xs truncate max-w-[140px]">
                            {result.error ?? "Failed"}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleClose} data-testid="button-done-social-promote">Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
