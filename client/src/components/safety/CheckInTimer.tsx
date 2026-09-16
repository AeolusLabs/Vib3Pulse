import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

// Includes a day qualifier once it's not "today" relative to whoever is
// looking at it right now — since a check-in set for "tomorrow" naturally
// becomes "today" once that day arrives, this needs no stored day flag, just
// a fresh comparison against the current date at render time.
function formatExpiry(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${time} ${d.toLocaleDateString(undefined, { weekday: "short" })}`;
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function toHHMM(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Round up to the next quarter-hour so a freshly-opened picker doesn't
// default to an odd time like 14:37.
function roundUpToNext15Min(date: Date): Date {
  const d = new Date(date);
  const remainder = d.getMinutes() % 15;
  if (remainder !== 0) d.setMinutes(d.getMinutes() + (15 - remainder));
  d.setSeconds(0, 0);
  return d;
}

// The alarm-clock rule: an "HH:MM" time-of-day means the next real occurrence
// of that clock time — today if it hasn't happened yet, tomorrow if it has
// (or is close enough to "now" to be ambiguous either way).
function resolveTargetDate(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= Date.now() + 60_000) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

const QUICK_OFFSETS = [
  { label: "+30 min", minutes: 30 },
  { label: "+1 hr", minutes: 60 },
  { label: "+2 hr", minutes: 120 },
  { label: "+4 hr", minutes: 240 },
] as const;

export function CheckInTimer() {
  const { toast } = useToast();
  // Defaults to an hour from now, rounded to a clean quarter-hour — an alarm
  // picker with a blank/midnight default feels broken, not empty.
  const [selectedTime, setSelectedTime] = useState(() =>
    toHHMM(roundUpToNext15Min(new Date(Date.now() + 60 * 60_000)))
  );

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

  // Resolved fresh on every render (and again at submit time in
  // handleSetCheckIn) rather than cached, so it can't go stale while the
  // picker sits open — see resolveTargetDate for the today/tomorrow rule.
  const targetDate = selectedTime ? resolveTargetDate(selectedTime) : null;
  const isTargetTomorrow = !!targetDate && targetDate.toDateString() !== new Date().toDateString();

  const handleSetCheckIn = () => {
    if (!selectedTime) return;
    const target = resolveTargetDate(selectedTime);
    const minutes = Math.min(1440, Math.max(1, Math.round((target.getTime() - Date.now()) / 60_000)));
    startMutation.mutate(minutes);
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
          /* Check-in time setup state — alarm-clock style: pick a clock time,
             not a duration. */
          <div className="space-y-5">
            <div className="text-center p-6 rounded-xl space-y-2 border-2 border-primary/20 bg-primary/5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                Check in by
              </p>
              <Input
                type="time"
                value={selectedTime}
                onChange={(e) => setSelectedTime(e.target.value)}
                data-testid="input-checkin-time"
                className="w-auto mx-auto text-center text-4xl font-bold tracking-tight h-auto py-2 border-0 bg-transparent shadow-none focus-visible:ring-1"
                style={{ fontVariantNumeric: "tabular-nums" }}
              />
              {targetDate && (
                <p className="text-xs text-muted-foreground pt-1" data-testid="text-checkin-day">
                  {isTargetTomorrow ? "Tomorrow" : "Today"} at{" "}
                  {targetDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </p>
              )}
            </div>

            <div className="flex items-center justify-center gap-2">
              {QUICK_OFFSETS.map(({ label, minutes }) => (
                <Button
                  key={minutes}
                  variant="outline"
                  size="sm"
                  className="rounded-full h-8 px-3"
                  onClick={() => setSelectedTime(toHHMM(new Date(Date.now() + minutes * 60_000)))}
                  data-testid={`button-quick-${minutes}`}
                  style={{ touchAction: "manipulation" }}
                >
                  {label}
                </Button>
              ))}
            </div>

            <Button
              className="w-full rounded-full gap-2"
              size="lg"
              onClick={handleSetCheckIn}
              disabled={startMutation.isPending || !selectedTime}
              data-testid="button-set-checkin-time"
              style={{ touchAction: "manipulation" }}
            >
              <TimerIcon className="h-4 w-4" />
              {startMutation.isPending ? "Setting…" : "Set Check-In"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
