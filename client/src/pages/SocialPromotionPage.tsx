import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import type { Event as DBEvent } from "@shared/schema";
import { SOCIAL_PLATFORMS } from "@shared/schema";
import {
  GlobeIcon,
  MegaphoneIcon,
  CheckCircleIcon,
  XCircleIcon,
  LinkIcon,
  XIcon,
  ShieldOffIcon,
  Loader2Icon,
  ZapIcon,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

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

// ── Platform display helpers ───────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  twitter: "Twitter / X",
  tiktok: "TikTok",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  threads: "Threads",
  reddit: "Reddit",
  pinterest: "Pinterest",
  bluesky: "Bluesky",
  telegram: "Telegram",
  snapchat: "Snapchat",
  whatsapp: "WhatsApp",
  discord: "Discord",
};

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "from-pink-500 to-purple-600",
  twitter:   "from-sky-400 to-sky-600",
  tiktok:    "from-black to-zinc-700",
  facebook:  "from-blue-600 to-blue-800",
  linkedin:  "from-blue-500 to-blue-700",
  youtube:   "from-red-500 to-red-700",
  threads:   "from-zinc-600 to-zinc-800",
  reddit:    "from-orange-500 to-orange-700",
  pinterest: "from-red-400 to-red-600",
  bluesky:   "from-sky-500 to-blue-600",
  telegram:  "from-sky-400 to-cyan-600",
  snapchat:  "from-yellow-400 to-yellow-500",
  whatsapp:  "from-green-500 to-green-700",
  discord:   "from-indigo-500 to-violet-600",
};

function platformInitial(platform: string) {
  return (PLATFORM_LABELS[platform] ?? platform).charAt(0).toUpperCase();
}

// ── Popup OAuth connect ────────────────────────────────────────────────────────

function useOAuthPopup(onSuccess: () => void) {
  const popupRef = useRef<Window | null>(null);

  const open = (platform: string) => {
    const url = `/api/auth/social/connect?platform=${encodeURIComponent(platform)}`;
    const popup = window.open(url, `connect_${platform}`, "width=600,height=700,popup=1");
    popupRef.current = popup;
  };

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data && typeof e.data === "object" && "success" in e.data) {
        if (e.data.success) {
          onSuccess();
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onSuccess]);

  return open;
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function SocialPromotionPage() {
  const { toast } = useToast();
  const { data: user, isLoading: userLoading } = useAuth();

  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [promoteResults, setPromoteResults] = useState<PromoteResult | null>(null);

  // Fetch organizer's approved events
  const { data: events = [], isLoading: eventsLoading } = useQuery<DBEvent[]>({
    queryKey: ["/api/events/my-events"],
    enabled: !!user && user.userType === "organizer",
  });
  const approvedEvents = events.filter((e) => e.moderationStatus === "approved");

  // Fetch connected social accounts
  const {
    data: connected = [],
    isLoading: socialsLoading,
    refetch: refetchSocials,
  } = useQuery<ConnectedSocial[]>({
    queryKey: ["/api/organizer/connected-socials"],
    enabled: !!user && user.userType === "organizer",
  });
  const connectedSet = new Set(connected.map((c) => c.platform));

  const openOAuthPopup = useOAuthPopup(() => {
    refetchSocials();
    toast({ title: "Account connected", description: "Your social account was linked." });
  });

  // Disconnect mutation
  const disconnectMutation = useMutation({
    mutationFn: (platform: string) =>
      apiRequest("POST", "/api/organizer/disconnect-social", { platform }),
    onSuccess: (_data, platform) => {
      toast({ title: "Disconnected", description: `${PLATFORM_LABELS[platform] ?? platform} removed.` });
      queryClient.invalidateQueries({ queryKey: ["/api/organizer/connected-socials"] });
      setSelectedPlatforms((prev) => {
        const next = new Set(prev);
        next.delete(platform);
        return next;
      });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to disconnect account.", variant: "destructive" });
    },
  });

  // Promote mutation
  const promoteMutation = useMutation({
    mutationFn: ({ eventId, platforms }: { eventId: string; platforms: string[] }) =>
      apiRequest("POST", `/api/events/${eventId}/promote`, { platforms }),
    onSuccess: (data: PromoteResult) => {
      setPromoteResults(data);
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
    onError: () => {
      toast({ title: "Promote failed", description: "Something went wrong. Try again.", variant: "destructive" });
    },
  });

  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      next.has(platform) ? next.delete(platform) : next.add(platform);
      return next;
    });
  };

  const canPromote =
    !!selectedEventId &&
    selectedPlatforms.size > 0 &&
    !promoteMutation.isPending;

  // ── Auth guard ────────────────────────────────────────────────────────────────

  if (userLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="max-w-3xl mx-auto px-4 py-10 space-y-4">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (!user || user.userType !== "organizer") {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="max-w-3xl mx-auto px-4 py-24 text-center">
          <div className="flex flex-col items-center gap-4">
            <ShieldOffIcon className="h-10 w-10 text-muted-foreground opacity-50" />
            <h2 className="text-lg font-semibold">Organizer access only</h2>
            <p className="text-muted-foreground text-sm">
              Social promotion is available to event organizer accounts.
            </p>
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  // ── Page ──────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 pb-28 space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MegaphoneIcon className="h-6 w-6 text-primary" />
            Social Promotion
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Blast your event to up to {SOCIAL_PLATFORMS.length} platforms simultaneously via Zernio.
          </p>
        </div>

        {/* Connected accounts */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span>Connected Accounts</span>
              <Badge variant="secondary">{connected.length} / {SOCIAL_PLATFORMS.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {socialsLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
              </div>
            ) : connected.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">
                No accounts connected yet. Connect platforms below to start promoting.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {connected.map((acct) => (
                  <div
                    key={acct.platform}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 bg-muted/30"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`flex-shrink-0 h-7 w-7 rounded-full bg-gradient-to-br ${PLATFORM_COLORS[acct.platform] ?? "from-zinc-400 to-zinc-600"} flex items-center justify-center text-white text-xs font-bold`}
                      >
                        {platformInitial(acct.platform)}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{PLATFORM_LABELS[acct.platform] ?? acct.platform}</p>
                        {acct.handle && (
                          <p className="text-[10px] text-muted-foreground truncate">@{acct.handle}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => disconnectMutation.mutate(acct.platform)}
                      disabled={disconnectMutation.isPending}
                      className="ml-1 flex-shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                      title={`Disconnect ${PLATFORM_LABELS[acct.platform]}`}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <Separator />

            {/* Add more accounts */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Connect a new account</p>
              <div className="flex flex-wrap gap-1.5">
                {SOCIAL_PLATFORMS.filter((p) => !connectedSet.has(p)).map((platform) => (
                  <Button
                    key={platform}
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => openOAuthPopup(platform)}
                  >
                    <LinkIcon className="h-3 w-3" />
                    {PLATFORM_LABELS[platform] ?? platform}
                  </Button>
                ))}
                {SOCIAL_PLATFORMS.every((p) => connectedSet.has(p)) && (
                  <p className="text-xs text-muted-foreground py-1">All platforms connected.</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Promote form */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ZapIcon className="h-4 w-4 text-yellow-500" />
              Promote an Event
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* Event selector */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Select event</label>
              {eventsLoading ? (
                <Skeleton className="h-10 w-full rounded-md" />
              ) : approvedEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
                  No approved events. Events must be approved before they can be promoted.
                </p>
              ) : (
                <Select value={selectedEventId} onValueChange={setSelectedEventId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose an approved event…" />
                  </SelectTrigger>
                  <SelectContent>
                    {approvedEvents.map((evt) => (
                      <SelectItem key={evt.id} value={evt.id}>
                        {evt.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Platform checkboxes — only connected */}
            {connected.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Choose platforms</label>
                  <button
                    className="text-xs text-primary hover:underline"
                    onClick={() =>
                      setSelectedPlatforms(
                        selectedPlatforms.size === connected.length
                          ? new Set()
                          : new Set(connected.map((c) => c.platform)),
                      )
                    }
                  >
                    {selectedPlatforms.size === connected.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {connected.map((acct) => (
                    <label
                      key={acct.platform}
                      className="flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer hover:bg-muted/40 transition-colors"
                    >
                      <Checkbox
                        checked={selectedPlatforms.has(acct.platform)}
                        onCheckedChange={() => togglePlatform(acct.platform)}
                      />
                      <span
                        className={`h-5 w-5 rounded-full bg-gradient-to-br ${PLATFORM_COLORS[acct.platform] ?? "from-zinc-400 to-zinc-600"} flex items-center justify-center text-white text-[10px] font-bold`}
                      >
                        {platformInitial(acct.platform)}
                      </span>
                      <span className="text-sm truncate">{PLATFORM_LABELS[acct.platform] ?? acct.platform}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {connected.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">
                Connect at least one account above to enable promotion.
              </p>
            )}

            <Button
              className="w-full gap-2"
              disabled={!canPromote}
              onClick={() =>
                promoteMutation.mutate({
                  eventId: selectedEventId,
                  platforms: Array.from(selectedPlatforms),
                })
              }
            >
              {promoteMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin" />
              ) : (
                <MegaphoneIcon className="h-4 w-4" />
              )}
              {promoteMutation.isPending
                ? `Posting to ${selectedPlatforms.size} platform${selectedPlatforms.size !== 1 ? "s" : ""}…`
                : `Promote to ${selectedPlatforms.size} platform${selectedPlatforms.size !== 1 ? "s" : ""}`}
            </Button>
          </CardContent>
        </Card>

        {/* Results */}
        {promoteResults && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <GlobeIcon className="h-4 w-4 text-primary" />
                Promotion Results
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-4 text-sm mb-3">
                <span>
                  <span className="font-semibold text-green-500">{promoteResults.postsCreated}</span>
                  {" "}posted
                </span>
                <span className="text-muted-foreground">
                  Cost: <span className="font-medium text-foreground">${promoteResults.totalCostUsd.toFixed(2)}</span>
                </span>
              </div>
              <div className="space-y-1.5">
                {promoteResults.platforms.map((result) => (
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
            </CardContent>
          </Card>
        )}

      </main>
      <BottomNavigation />
    </div>
  );
}
