import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useOAuthPopup } from "@/hooks/useOAuthPopup";
import { PLATFORM_LABELS, PLATFORM_COLORS, platformInitial } from "@/lib/socialPlatforms";
import { CheckCircleIcon, XCircleIcon, XIcon, ExternalLinkIcon } from "@/components/ui/icons";
import { SocialPlanPicker } from "@/components/social/SocialPlanPicker";
import { SocialTopUp } from "@/components/social/SocialTopUp";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "@shared/schema";
import {
  SEND_STATUS_LABEL,
  fetchCampaigns,
  localInputValue,
  targetQuery,
  type CampaignRow,
  type ConnectedSocial,
  type PlanSummary,
  type PromoteResult,
  type PromoteTarget,
} from "@/lib/socialPlans";

interface Props {
  target: PromoteTarget;
  currency: string;
  isOpen: boolean;
  onBack: () => void;
  onDone: () => void;
}

// The whole "promote on social media" flow for one event / venue / venue night: pick a
// plan if there isn't one, connect accounts, post now or schedule, see and cancel what is
// scheduled. Rendered inside a DialogContent (it supplies its own DialogFooters).
export function SocialPromotePanel({ target, currency, isOpen, onBack, onDone }: Props) {
  const { toast } = useToast();
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<SocialPlatform>>(new Set());
  const [result, setResult] = useState<PromoteResult | null>(null);
  // Scheduling: times are picked in the browser's local time and sent as UTC instants.
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [times, setTimes] = useState<string[]>([""]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const { data: plan, isLoading: planLoading, refetch: refetchPlan } = useQuery<PlanSummary>({
    queryKey: ["/api/social/plans/me"],
    enabled: isOpen,
  });

  const {
    data: connected = [],
    isLoading: socialsLoading,
    refetch: refetchSocials,
  } = useQuery<ConnectedSocial[]>({
    queryKey: ["/api/organizer/connected-socials"],
    enabled: isOpen,
  });
  const connectedSet = new Set(connected.map((c) => c.platform));

  const campaignsKey = ["/api/social/campaigns", targetQuery(target)] as const;
  const { data: campaigns = [] } = useQuery<CampaignRow[]>({
    queryKey: campaignsKey,
    queryFn: () => fetchCampaigns(targetQuery(target)),
    enabled: isOpen && !!plan?.active,
  });
  const upcoming = campaigns.filter((c) => c.status === "active" && c.sends.some((s) => s.status === "scheduled"));

  const openOAuthPopup = useOAuthPopup(
    () => {
      refetchSocials();
      refetchPlan();
      toast({ title: "Account connected", description: "Your social account was linked." });
    },
    (message) => toast({ title: "Couldn't connect account", description: message, variant: "destructive" }),
  );

  const disconnectMutation = useMutation({
    mutationFn: (platform: string) => apiRequest("POST", "/api/organizer/disconnect-social", { platform }),
    onSuccess: (_data, platform) => {
      toast({ title: "Disconnected", description: `${PLATFORM_LABELS[platform] ?? platform} removed.` });
      queryClient.invalidateQueries({ queryKey: ["/api/organizer/connected-socials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/social/plans/me"] });
      setSelectedPlatforms((prev) => {
        const next = new Set(prev);
        next.delete(platform as SocialPlatform);
        return next;
      });
    },
    onError: () => toast({ title: "Error", description: "Failed to disconnect account.", variant: "destructive" }),
  });

  const body = () => ({ ...target, platforms: Array.from(selectedPlatforms) });

  // No payment here — the plan is the payment. The server checks the plan, takes one
  // campaign from it, and gives it back if nothing got published.
  const postNow = useMutation({
    mutationFn: async () => (await (await apiRequest("POST", "/api/social/campaigns", body())).json()) as PromoteResult,
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/social/plans/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/social/campaigns"] });
      const failed = data.platforms.filter((p) => !p.success);
      if (failed.length === 0) {
        toast({ title: "Promoted!", description: `Posted to ${data.postsCreated} platform${data.postsCreated !== 1 ? "s" : ""}.` });
      } else {
        toast({
          title: `Partially posted (${data.postsCreated}/${data.platforms.length})`,
          description: `${failed.length} platform${failed.length !== 1 ? "s" : ""} failed.`,
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => toast({ title: "Promote failed", description: error.message || "Something went wrong. Try again.", variant: "destructive" }),
  });

  const schedule = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/social/campaigns/schedule", {
        ...body(),
        times: times.filter(Boolean).map((t) => new Date(t).toISOString()),
        timezone,
      })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/social/plans/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/social/campaigns"] });
      toast({ title: "Campaign scheduled", description: "We'll post at the times you picked." });
      setWhen("now");
      setTimes([""]);
      setSelectedPlatforms(new Set());
    },
    onError: (error: Error) => toast({ title: "Couldn't schedule", description: error.message, variant: "destructive" }),
  });

  const cancelCampaign = useMutation({
    mutationFn: async (id: string) =>
      (await (await apiRequest("POST", `/api/social/campaigns/${id}/cancel`)).json()) as { allowanceReturned: boolean },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/social/plans/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/social/campaigns"] });
      toast({
        title: "Campaign cancelled",
        description: data.allowanceReturned
          ? "The campaign was returned to your plan."
          : "It was too close to the first post (or already started), so it stays used.",
      });
    },
    onError: (error: Error) => toast({ title: "Couldn't cancel", description: error.message, variant: "destructive" }),
  });

  const togglePlatform = (platform: SocialPlatform) =>
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      next.has(platform) ? next.delete(platform) : next.add(platform);
      return next;
    });

  const maxTimes = plan?.timesPerCampaign ?? 1;
  const filledTimes = times.filter(Boolean);
  const busy = postNow.isPending || schedule.isPending;
  const canPromote = selectedPlatforms.size > 0 && !busy && (plan?.campaignsLeft ?? 0) > 0 && (when === "now" || filledTimes.length > 0);
  const atPlatformCap = !!plan?.active && plan.platformsConnected >= (plan.maxPlatforms ?? 0);
  const minLocal = localInputValue(new Date(Date.now() + 6 * 60_000));

  if (planLoading) return <Skeleton className="h-40 w-full rounded-lg" />;

  if (!plan?.active) {
    return (
      <>
        <SocialPlanPicker currency={currency} onActivated={() => refetchPlan()} />
        <DialogFooter>
          <Button variant="outline" onClick={onBack} data-testid="button-back-social">Back</Button>
        </DialogFooter>
      </>
    );
  }

  if (result) {
    return (
      <>
        <div className="py-2 space-y-2">
          <p className="text-sm"><span className="font-semibold text-green-500">{result.postsCreated}</span> posted</p>
          <div className="space-y-1.5">
            {result.platforms.map((r) => (
              <div key={r.platform} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className={`h-5 w-5 rounded-full bg-gradient-to-br ${PLATFORM_COLORS[r.platform] ?? "from-zinc-400 to-zinc-600"} flex items-center justify-center text-white text-[10px] font-bold`}>
                    {platformInitial(r.platform)}
                  </span>
                  <span>{PLATFORM_LABELS[r.platform] ?? r.platform}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {r.success ? (
                    <><CheckCircleIcon className="h-4 w-4 text-green-500" /><span className="text-green-500 text-xs">Posted</span></>
                  ) : (
                    <><XCircleIcon className="h-4 w-4 text-destructive" /><span className="text-destructive text-xs truncate max-w-[140px]">{r.error ?? "Failed"}</span></>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onDone} data-testid="button-done-social-promote">Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <div className="py-2 space-y-4">
        <div className="rounded-lg bg-muted px-3 py-2 text-sm flex items-center justify-between gap-2" data-testid="plan-usage">
          <span><span className="font-medium">{plan.label}</span> plan</span>
          <span className="text-muted-foreground">{plan.campaignsLeft} of {plan.campaignsLimit} campaigns left</span>
        </div>

        {connected.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Connected accounts</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {connected.map((acct) => (
                <label key={acct.platform} className="flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer hover:bg-muted/40 transition-colors">
                  <Checkbox
                    checked={selectedPlatforms.has(acct.platform as SocialPlatform)}
                    disabled={acct.needsReconnect}
                    onCheckedChange={() => togglePlatform(acct.platform as SocialPlatform)}
                  />
                  <span className={`h-5 w-5 rounded-full bg-gradient-to-br ${PLATFORM_COLORS[acct.platform] ?? "from-zinc-400 to-zinc-600"} flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0`}>
                    {platformInitial(acct.platform)}
                  </span>
                  <span className="text-sm truncate flex-1">{PLATFORM_LABELS[acct.platform] ?? acct.platform}</span>
                  {acct.needsReconnect && (
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); openOAuthPopup(acct.platform); }}
                      className="text-[11px] font-medium text-amber-600"
                      data-testid={`button-reconnect-${acct.platform}`}
                    >
                      Reconnect
                    </button>
                  )}
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
            {atPlatformCap
              ? `Your ${plan.label} plan allows ${plan.maxPlatforms} connected platforms. Disconnect one, or add a platform below.`
              : connected.length > 0 ? "Connect more accounts" : "Connect an account to get started"}
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
                  disabled={atPlatformCap}
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
          <p className="text-sm text-muted-foreground text-center py-2">Connect at least one account above to enable promotion.</p>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">When</p>
          <div className="grid grid-cols-2 gap-1 rounded-lg border p-1" role="group" aria-label="When to post">
            {([["now", "Post now"], ["schedule", "Schedule"]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={when === value}
                onClick={() => setWhen(value)}
                className={`rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${when === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                data-testid={`button-when-${value}`}
              >
                {label}
              </button>
            ))}
          </div>

          {when === "schedule" && (
            <div className="space-y-2">
              {times.map((value, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    id={`schedule-time-${i}`}
                    type="datetime-local"
                    aria-label={`Post time ${i + 1}`}
                    value={value}
                    min={minLocal}
                    onChange={(e) => setTimes((prev) => prev.map((t, j) => (j === i ? e.target.value : t)))}
                    className="flex-1 min-w-0 rounded-md border bg-background px-2 py-1.5 text-sm"
                    data-testid={`input-schedule-time-${i}`}
                  />
                  {i > 0 && (
                    <button type="button" aria-label="Remove time" onClick={() => setTimes((prev) => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">
                      <XIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              {times.length < maxTimes && (
                <button type="button" onClick={() => setTimes((prev) => [...prev, ""])} className="text-sm font-medium text-primary" data-testid="button-add-time">
                  + Add another time ({times.length}/{maxTimes})
                </button>
              )}
              <p className="text-xs text-muted-foreground">
                Times are in your timezone ({timezone}), at least 30 minutes apart{target.venueId && !target.venueNightId ? "" : ", before it starts"}.
                {filledTimes.length > 1 && " X posts once, at the first time that works; the other platforms post every time."}
              </p>
            </div>
          )}
        </div>

        {upcoming.length > 0 && (
          <div className="space-y-1.5" data-testid="upcoming-campaigns">
            <p className="text-xs font-medium text-muted-foreground">Already scheduled</p>
            {upcoming.map((c) => (
              <div key={c.id} className="rounded-lg border px-3 py-2 text-sm space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{c.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(", ")}</span>
                  <button
                    type="button"
                    onClick={() => cancelCampaign.mutate(c.id)}
                    disabled={cancelCampaign.isPending}
                    className="text-xs font-medium text-destructive"
                    data-testid={`button-cancel-campaign-${c.id}`}
                  >
                    Cancel
                  </button>
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {c.sends.map((s) => (
                    <li key={s.id} className="flex justify-between gap-2">
                      <span>{new Date(s.runAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                      <span>{SEND_STATUS_LABEL[s.status] ?? s.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {plan.campaignsLeft === 0 && (
          <p className="text-sm text-destructive">You have used all {plan.campaignsLimit} campaigns on this plan.</p>
        )}
        {(plan.campaignsLeft === 0 || atPlatformCap) && (
          <SocialTopUp plan={plan} show={{ campaigns: plan.campaignsLeft === 0, platform: atPlatformCap }} />
        )}
      </div>

      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onBack} data-testid="button-back-social">Back</Button>
        <Button
          disabled={!canPromote}
          onClick={() => (when === "schedule" ? schedule.mutate() : postNow.mutate())}
          data-testid="button-confirm-social-promote"
        >
          {busy ? "Working..." : when === "schedule" ? "Schedule · uses 1 campaign" : "Post now · uses 1 campaign"}
        </Button>
      </DialogFooter>
    </>
  );
}
