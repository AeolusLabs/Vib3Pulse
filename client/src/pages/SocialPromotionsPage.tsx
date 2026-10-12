import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useOAuthPopup } from "@/hooks/useOAuthPopup";
import { deriveDefaultCurrency } from "@/lib/currency";
import { PLATFORM_LABELS, PLATFORM_COLORS, platformInitial } from "@/lib/socialPlatforms";
import { SocialPlanPicker } from "@/components/social/SocialPlanPicker";
import { SocialTopUp } from "@/components/social/SocialTopUp";
import { ExternalLinkIcon, XIcon } from "@/components/ui/icons";
import { SOCIAL_PLATFORMS } from "@shared/schema";
import {
  SEND_STATUS_LABEL,
  fetchCampaigns,
  type CampaignRow,
  type ConnectedSocial,
  type PlanSummary,
} from "@/lib/socialPlans";

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">{used} / {limit}</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export default function SocialPromotionsPage() {
  const { toast } = useToast();
  const { data: user } = useAuth();
  const [currency, setCurrency] = useState<"GBP" | "NGN">(deriveDefaultCurrency());
  const [tab, setTab] = useState<"upcoming" | "history">("upcoming");
  const isOrganizer = user?.userType === "organizer";

  const { data: plan, isLoading: planLoading, refetch: refetchPlan } = useQuery<PlanSummary>({
    queryKey: ["/api/social/plans/me"],
    enabled: isOrganizer,
  });
  const { data: connected = [], isLoading: socialsLoading, refetch: refetchSocials } = useQuery<ConnectedSocial[]>({
    queryKey: ["/api/organizer/connected-socials"],
    enabled: isOrganizer,
  });
  const { data: campaigns = [], isLoading: campaignsLoading } = useQuery<CampaignRow[]>({
    queryKey: ["/api/social/campaigns", "all"],
    queryFn: () => fetchCampaigns(),
    enabled: isOrganizer && !!plan?.active,
  });

  // Returning from the hosted subscription checkout: the provider webhook activates the plan,
  // which can take a few seconds, so poll briefly instead of showing "no plan".
  const [activating, setActivating] = useState(() => new URLSearchParams(window.location.search).get("social_plan") === "success");
  useEffect(() => {
    if (!activating) return;
    if (plan?.active) { setActivating(false); toast({ title: "Plan activated" }); return; }
    let tries = 0;
    const t = setInterval(() => { if (++tries > 10) { setActivating(false); clearInterval(t); } else refetchPlan(); }, 3000);
    return () => clearInterval(t);
  }, [activating, plan?.active]); // eslint-disable-line react-hooks/exhaustive-deps

  const openOAuthPopup = useOAuthPopup(
    () => { refetchSocials(); refetchPlan(); toast({ title: "Account connected" }); },
    (message) => toast({ title: "Couldn't connect account", description: message, variant: "destructive" }),
  );

  const disconnect = useMutation({
    mutationFn: (platform: string) => apiRequest("POST", "/api/organizer/disconnect-social", { platform }),
    onSuccess: () => { refetchSocials(); refetchPlan(); },
    onError: () => toast({ title: "Failed to disconnect account", variant: "destructive" }),
  });

  const cancelRenewal = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/social/plans/cancel-renewal")).json(),
    onSuccess: () => {
      refetchPlan();
      toast({ title: "Renewal cancelled", description: "Your plan stays active until the end of the current period." });
    },
    onError: (e: Error) => toast({ title: "Couldn't cancel renewal", description: e.message, variant: "destructive" }),
  });

  const cancelCampaign = useMutation({
    mutationFn: async (id: string) => (await (await apiRequest("POST", `/api/social/campaigns/${id}/cancel`)).json()) as { allowanceReturned: boolean },
    onSuccess: (data) => {
      refetchPlan();
      queryClient.invalidateQueries({ queryKey: ["/api/social/campaigns"] });
      toast({
        title: "Campaign cancelled",
        description: data.allowanceReturned ? "It was returned to your plan." : "It was too close to the first post, so it stays used.",
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't cancel", description: e.message, variant: "destructive" }),
  });

  if (user && !isOrganizer) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="max-w-2xl mx-auto px-4 py-12 text-center">
          <h1 className="text-xl font-semibold">Organizer access only</h1>
          <p className="text-muted-foreground mt-2 text-sm">Social promotion plans are for organizer accounts.</p>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const connectedSet = new Set(connected.map((c) => c.platform));
  const atCap = !!plan?.active && plan.platformsConnected >= (plan.maxPlatforms ?? 0);
  const upcoming = campaigns.filter((c) => c.status === "active" && c.sends.some((s) => s.status === "scheduled" || s.status === "sending"));
  const history = campaigns.filter((c) => !upcoming.includes(c));
  const shown = tab === "upcoming" ? upcoming : history;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-2xl mx-auto px-4 py-6 pb-24 space-y-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="heading-social-promotions">Social promotions</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Your plan, your connected accounts, and everything scheduled or posted. Start a promotion from Manage events or Manage venues.
          </p>
        </div>

        {/* Plan */}
        <Card data-testid="card-plan">
          <CardHeader>
            <CardTitle>Your plan</CardTitle>
            {plan?.active && plan.endsAt && (
              <CardDescription>
                {plan.label} ·{" "}
                {plan.autoRenew ? `renews on ${fmtDate(plan.endsAt)}` : `ends on ${fmtDate(plan.endsAt)}`}
                {plan.billing === "one_off" ? " · one-off pass" : ""}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {planLoading ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : activating && !plan?.active ? (
              <p className="text-sm text-muted-foreground" data-testid="text-activating">Activating your plan… this takes a few seconds.</p>
            ) : plan?.active ? (
              <>
                <Meter label="Campaigns used" used={plan.campaignsUsed ?? 0} limit={plan.campaignsLimit ?? 0} />
                <Meter label="Platforms connected" used={plan.platformsConnected} limit={plan.maxPlatforms ?? 0} />
                {(plan.extraCampaigns || plan.extraPlatforms) ? (
                  <p className="text-xs text-muted-foreground" data-testid="text-extras">
                    Includes top-ups: {plan.extraCampaigns ? `+${plan.extraCampaigns} campaigns` : ""}
                    {plan.extraCampaigns && plan.extraPlatforms ? ", " : ""}
                    {plan.extraPlatforms ? `+${plan.extraPlatforms} platform${plan.extraPlatforms === 1 ? "" : "s"}` : ""}
                  </p>
                ) : null}
                <SocialTopUp plan={plan} />
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  {plan.billing === "recurring" && plan.autoRenew && (
                    <Button variant="outline" size="sm" disabled={cancelRenewal.isPending} onClick={() => cancelRenewal.mutate()} data-testid="button-cancel-renewal">
                      Cancel renewal
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {plan.billing === "recurring" && !plan.autoRenew
                    ? "Renewal is off. Your accounts disconnect 7 days after the plan ends. "
                    : ""}
                  To switch to a different plan, let this one end (cancel renewal if it renews), then choose the new plan.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">You don't have an active plan. Choose one to connect accounts and promote.</p>
            )}

            {!planLoading && !plan?.active && !activating && (
              <div className="space-y-3 border-t pt-4">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Pay in</span>
                  {(["GBP", "NGN"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={currency === c}
                      onClick={() => setCurrency(c)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${currency === c ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      data-testid={`button-currency-${c}`}
                    >
                      {c === "GBP" ? "£ GBP" : "₦ NGN"}
                    </button>
                  ))}
                </div>
                <SocialPlanPicker currency={currency} onActivated={() => refetchPlan()} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Accounts */}
        <Card data-testid="card-accounts">
          <CardHeader>
            <CardTitle>Connected accounts</CardTitle>
            <CardDescription>Each connected account counts toward your plan's platform limit.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {socialsLoading ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : connected.length === 0 ? (
              <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
            ) : (
              <ul className="space-y-2">
                {connected.map((acct) => (
                  <li key={acct.platform} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                    <span className={`h-7 w-7 rounded-full bg-gradient-to-br ${PLATFORM_COLORS[acct.platform] ?? "from-zinc-400 to-zinc-600"} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                      {platformInitial(acct.platform)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{PLATFORM_LABELS[acct.platform] ?? acct.platform}</p>
                      <p className="text-xs text-muted-foreground truncate">{acct.handle ? `@${acct.handle.replace(/^@/, "")}` : "Connected"}</p>
                    </div>
                    {acct.needsReconnect ? (
                      <Button size="sm" variant="outline" onClick={() => openOAuthPopup(acct.platform)} data-testid={`button-reconnect-${acct.platform}`}>
                        Reconnect
                      </Button>
                    ) : (
                      <span className="text-xs text-green-600">Live</span>
                    )}
                    <button
                      type="button"
                      aria-label={`Disconnect ${PLATFORM_LABELS[acct.platform] ?? acct.platform}`}
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate(acct.platform)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {plan?.active && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {atCap ? "Platform limit reached. Disconnect one or upgrade to add another." : "Connect an account"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SOCIAL_PLATFORMS.filter((p) => !connectedSet.has(p)).map((platform) => (
                    <Button
                      key={platform}
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      disabled={atCap}
                      onClick={() => openOAuthPopup(platform)}
                      data-testid={`button-connect-${platform}`}
                    >
                      <ExternalLinkIcon className="h-3 w-3" />
                      {PLATFORM_LABELS[platform] ?? platform}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Campaigns */}
        {plan?.active && (
          <Card data-testid="card-campaigns">
            <CardHeader>
              <CardTitle>Campaigns</CardTitle>
              <div className="flex gap-4 border-b" role="tablist">
                {([["upcoming", `Upcoming ${upcoming.length}`], ["history", "History"]] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => setTab(key)}
                    className={`pb-2 text-sm ${tab === key ? "border-b-2 border-primary font-semibold" : "text-muted-foreground"}`}
                    data-testid={`tab-${key}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {campaignsLoading ? (
                <Skeleton className="h-20 w-full rounded-lg" />
              ) : shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {tab === "upcoming" ? "Nothing scheduled. Schedule a promotion from Manage events or Manage venues." : "No past campaigns yet."}
                </p>
              ) : (
                shown.map((c) => (
                  <div key={c.id} className="rounded-lg border p-3 space-y-2" data-testid={`campaign-${c.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{c.eventTitle}</p>
                        <p className="text-xs text-muted-foreground">{c.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(", ")}</p>
                      </div>
                      {tab === "upcoming" && (
                        <Button size="sm" variant="outline" disabled={cancelCampaign.isPending} onClick={() => cancelCampaign.mutate(c.id)} data-testid={`button-cancel-campaign-${c.id}`}>
                          Cancel
                        </Button>
                      )}
                    </div>
                    <ul className="text-xs text-muted-foreground space-y-0.5">
                      {c.sends.map((s) => (
                        <li key={s.id} className="flex justify-between gap-2">
                          <span>{fmtWhen(s.runAt)}</span>
                          <span title={s.note ?? undefined}>
                            {SEND_STATUS_LABEL[s.status] ?? s.status}
                            {s.note && s.status !== "sent" ? ` · ${s.note}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}
      </main>
      <BottomNavigation />
    </div>
  );
}
