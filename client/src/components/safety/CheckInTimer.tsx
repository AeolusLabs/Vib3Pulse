import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { TimerIcon, CheckCircleIcon, ClockIcon } from "@/components/ui/icons";

interface SafetyTimer {
  id: string;
  durationMinutes: number;
  expiresAt: string;
  gracePeriodMinutes: number;
  gracePeriodEndsAt: string;
  status: "active" | "grace_period" | "alerted" | "checked_in" | "cancelled";
  lastStageNotified: number; // 0=none, 1=T+0, 2=T+10, 3=T+20, 4=alerted(T+25)
  snoozeCount: number;
  checkedInAt: string | null;
  alertedAt: string | null;
  createdAt: string;
}

// Graduated escalation stages (fixed per PRD — not user-configurable).
// Stage boundaries are offsets from expiresAt; stage 0 is "not expired yet".
const STAGE_INFO: Record<number, { label: string; border: string; badgeClass: string } | null> = {
  0: null,
  1: { label: "Quick check-in", border: "border-blue-500/40 bg-blue-500/5", badgeClass: "bg-blue-600 text-white" },
  2: { label: "Still there?", border: "border-amber-500/40 bg-amber-500/5", badgeClass: "bg-amber-600 text-white" },
  3: { label: "Last chance", border: "border-destructive/40 bg-destructive/5", badgeClass: "bg-destructive text-white" },
};

function useCountdown(targetIso: string | null) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (!targetIso) { setLabel(""); return; }
    const tick = () => {
      const diff = new Date(targetIso).getTime() - Date.now();
      if (diff <= 0) { setLabel("00:00"); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      if (h > 0) setLabel(`${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
      else setLabel(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return label;
}

function formatExpiry(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

const DURATION_PRESETS = [30, 60, 120, 240] as const;

export function CheckInTimer() {
  const { toast } = useToast();
  const [customMinutes, setCustomMinutes] = useState("");

  const { data, isLoading } = useQuery<{ timer: SafetyTimer | null }>({
    queryKey: ["/api/safety/timer"],
    refetchInterval: 15_000,
  });

  const timer = data?.timer ?? null;
  const stage = timer?.status === "grace_period" ? Math.max(timer.lastStageNotified, 1) : 0;
  const stageInfo = STAGE_INFO[stage];

  // Stage 1 counts down to the T+10 boundary, stage 2 to T+20, stage 3 to the
  // final T+25 alert deadline (gracePeriodEndsAt). Stage 0 counts down to expiry.
  const countdownTarget = !timer ? null
    : stage === 0 ? timer.expiresAt
    : stage === 1 ? addMinutes(timer.expiresAt, 10)
    : stage === 2 ? addMinutes(timer.expiresAt, 20)
    : timer.gracePeriodEndsAt;
  const countdown = useCountdown(countdownTarget);

  const startMutation = useMutation({
    mutationFn: (durationMinutes: number) =>
      apiRequest("POST", "/api/safety/timer", { durationMinutes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Check-in time set", description: "Check in before it expires or your buddy will be alerted." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const checkInMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety/timer/checkin"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Checked in", description: "You're marked safe." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/safety/timer"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Check-in time cancelled" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const snoozeMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety/timer/snooze"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Snoozed", description: "Extended by 30 minutes." });
    },
    onError: (e: any) => toast({ title: "Couldn't snooze", description: e.message, variant: "destructive" }),
  });

  const extendMutation = useMutation({
    mutationFn: (hours: 1 | 2 | 4) => apiRequest("POST", "/api/safety/timer/extend", { hours }),
    onSuccess: (_data, hours) => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Check-in time extended", description: `Added ${hours} hour${hours === 1 ? "" : "s"}.` });
    },
    onError: (e: any) => toast({ title: "Couldn't extend", description: e.message, variant: "destructive" }),
  });

  const handleCustomStart = () => {
    const mins = parseInt(customMinutes, 10);
    if (isNaN(mins) || mins < 1 || mins > 1440) {
      toast({ title: "Invalid duration", description: "Enter between 1 and 1440 minutes.", variant: "destructive" });
      return;
    }
    startMutation.mutate(mins);
    setCustomMinutes("");
  };

  return (
    <Card data-testid="card-checkin-timer">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TimerIcon className="h-5 w-5" />
          Check-In Time
        </CardTitle>
        <CardDescription>
          Set a time to check in by. If you don't, we'll nudge you a few times before your buddy is alerted automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : timer ? (
          /* Active timer state */
          <div className="space-y-4">
            <div
              className={[
                "text-center p-6 rounded-xl space-y-1 border-2 transition-colors duration-500",
                stageInfo ? stageInfo.border : "border-primary/20 bg-primary/5",
              ].join(" ")}
            >
              {stageInfo && (
                <Badge className={`mb-2 gap-1 ${stageInfo.badgeClass}`}>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                  </span>
                  {stageInfo.label}
                </Badge>
              )}
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                {stage === 0 ? "Time remaining" : stage === 3 ? "Buddy alerted in" : "Next check-in in"}
              </p>
              {/* Large mono countdown — tabular-nums prevents layout shift */}
              <p
                className="text-5xl font-bold tracking-tight"
                style={{ fontVariantNumeric: "tabular-nums", fontFeatureSettings: '"tnum"' }}
                data-testid="text-countdown"
              >
                {countdown || "—"}
              </p>
              <p className="text-xs text-muted-foreground pt-1">
                {stage === 0
                  ? `Expires ${formatExpiry(timer.expiresAt)}`
                  : `Buddy alerted at ${formatExpiry(timer.gracePeriodEndsAt)}`
                }
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                className="flex-1 rounded-full gap-2"
                size="lg"
                onClick={() => checkInMutation.mutate()}
                disabled={checkInMutation.isPending}
                data-testid="button-checkin"
                style={{ touchAction: "manipulation" }}
              >
                <CheckCircleIcon className="h-4 w-4" />
                {checkInMutation.isPending ? "Checking in…" : "I'm Safe"}
              </Button>
              <Button
                variant="outline"
                className="rounded-full"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                data-testid="button-cancel-timer"
                style={{ touchAction: "manipulation" }}
              >
                {cancelMutation.isPending ? "…" : "Cancel"}
              </Button>
            </div>

            {timer.snoozeCount < 3 ? (
              <Button
                variant="ghost"
                className="w-full rounded-full gap-2 text-muted-foreground"
                onClick={() => snoozeMutation.mutate()}
                disabled={snoozeMutation.isPending}
                data-testid="button-snooze-timer"
                style={{ touchAction: "manipulation" }}
              >
                <ClockIcon className="h-4 w-4" />
                {snoozeMutation.isPending ? "Snoozing…" : `I'm fine, extend by 30 min (${3 - timer.snoozeCount} left)`}
              </Button>
            ) : (
              <p className="text-center text-xs text-muted-foreground">No more snoozes for this check-in</p>
            )}

            <div className="flex items-center justify-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Extend by</span>
              {([1, 2, 4] as const).map((h) => (
                <Button
                  key={h}
                  variant="outline"
                  size="sm"
                  className="rounded-full h-8 px-3"
                  onClick={() => extendMutation.mutate(h)}
                  disabled={extendMutation.isPending}
                  data-testid={`button-extend-${h}h`}
                  style={{ touchAction: "manipulation" }}
                >
                  +{h}h
                </Button>
              ))}
            </div>
          </div>
        ) : (
          /* Timer setup state */
          <div className="space-y-5">
            {/* Duration presets — staggered entry */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                Duration
              </p>
              <div className="grid grid-cols-4 gap-2">
                {DURATION_PRESETS.map((mins, i) => (
                  <Button
                    key={mins}
                    variant="outline"
                    size="sm"
                    onClick={() => startMutation.mutate(mins)}
                    disabled={startMutation.isPending}
                    data-testid={`button-timer-${mins}`}
                    style={{
                      touchAction: "manipulation",
                      animationDelay: `${i * 50}ms`,
                    }}
                    className="flex flex-col h-auto py-2.5 rounded-xl animate-in fade-in fill-mode-both duration-200"
                  >
                    <span className="text-base font-semibold leading-none">
                      {mins < 60 ? mins : mins / 60}
                    </span>
                    <span className="text-[10px] text-muted-foreground mt-0.5">
                      {mins < 60 ? "min" : "hr"}
                    </span>
                  </Button>
                ))}
              </div>
            </div>

            <Separator />

            {/* Custom duration */}
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="custom-timer" className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                  Custom
                </Label>
                <Input
                  id="custom-timer"
                  type="number"
                  min="1"
                  max="1440"
                  placeholder="e.g. 90 min"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCustomStart()}
                  data-testid="input-custom-timer"
                  className="rounded-xl"
                />
              </div>
              <Button
                onClick={handleCustomStart}
                disabled={startMutation.isPending || !customMinutes}
                data-testid="button-start-custom-timer"
                className="rounded-full"
                style={{ touchAction: "manipulation" }}
              >
                Start
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
