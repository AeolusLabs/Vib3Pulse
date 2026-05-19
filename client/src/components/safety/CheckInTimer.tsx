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
  checkedInAt: string | null;
  alertedAt: string | null;
  createdAt: string;
}

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
      if (h > 0) setLabel(`${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`);
      else if (m > 0) setLabel(`${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`);
      else setLabel(`${String(s).padStart(2, "0")}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return label;
}

export function CheckInTimer() {
  const { toast } = useToast();
  const [customMinutes, setCustomMinutes] = useState("");

  const { data, isLoading } = useQuery<{ timer: SafetyTimer | null }>({
    queryKey: ["/api/safety/timer"],
    refetchInterval: 15_000,
  });

  const timer = data?.timer ?? null;
  const isInGrace = timer?.status === "grace_period";
  const countdownTarget = isInGrace ? timer?.gracePeriodEndsAt : timer?.expiresAt;
  const countdown = useCountdown(timer ? countdownTarget ?? null : null);

  const startMutation = useMutation({
    mutationFn: (durationMinutes: number) =>
      apiRequest("POST", "/api/safety/timer", { durationMinutes, gracePeriodMinutes: 5 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Timer started", description: "Check in before it expires or your buddy will be alerted." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const checkInMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety/timer/checkin"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Checked in", description: "You're marked safe. Timer cancelled." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/safety/timer"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/timer"] });
      toast({ title: "Timer cancelled" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
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
          Check-In Timer
        </CardTitle>
        <CardDescription>
          Set a timer. If you don't check in before the grace period ends, your buddy is alerted automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : timer ? (
          <div className="space-y-4">
            <div className="text-center p-6 border rounded-md bg-muted/30 space-y-2">
              {isInGrace && (
                <Badge variant="destructive" className="mb-1">
                  <ClockIcon className="h-3 w-3 mr-1" />
                  Grace period — check in now!
                </Badge>
              )}
              <p className="text-sm text-muted-foreground">
                {isInGrace ? "Grace period ends in" : "Time remaining"}
              </p>
              <p className="text-3xl font-bold font-mono" data-testid="text-countdown">
                {countdown || "—"}
              </p>
              {!isInGrace && (
                <p className="text-xs text-muted-foreground">
                  +{timer.gracePeriodMinutes}m grace period after this
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => checkInMutation.mutate()}
                disabled={checkInMutation.isPending}
                data-testid="button-checkin"
              >
                <CheckCircleIcon className="h-4 w-4 mr-2" />
                {checkInMutation.isPending ? "Checking in…" : "I'm Safe"}
              </Button>
              <Button
                variant="outline"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                data-testid="button-cancel-timer"
              >
                {cancelMutation.isPending ? "Cancelling…" : "Cancel"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Quick presets:</p>
            <div className="flex flex-wrap gap-2">
              {[30, 60, 120, 240].map((mins) => (
                <Button
                  key={mins}
                  variant="outline"
                  size="sm"
                  onClick={() => startMutation.mutate(mins)}
                  disabled={startMutation.isPending}
                  data-testid={`button-timer-${mins}`}
                >
                  {mins < 60 ? `${mins} min` : `${mins / 60}h`}
                </Button>
              ))}
            </div>
            <Separator />
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="custom-timer" className="text-sm">Custom duration (minutes)</Label>
                <Input
                  id="custom-timer"
                  type="number"
                  min="1"
                  max="1440"
                  placeholder="e.g. 90"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCustomStart()}
                  data-testid="input-custom-timer"
                />
              </div>
              <Button
                onClick={handleCustomStart}
                disabled={startMutation.isPending || !customMinutes}
                data-testid="button-start-custom-timer"
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
