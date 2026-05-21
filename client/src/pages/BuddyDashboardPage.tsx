import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import {
  ShieldIcon,
  TimerIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  XCircleIcon,
} from "@/components/ui/icons";

interface ProtectedUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface SafetyTimer {
  id: string;
  durationMinutes: number;
  expiresAt: string;
  gracePeriodMinutes: number;
  gracePeriodEndsAt: string;
  status: "active" | "grace_period" | "alerted" | "checked_in" | "cancelled";
}

interface SafetyAlert {
  id: string;
  alertType: "manual_sos" | "timer_expiry";
  status: "active" | "safe" | "false_alarm";
  message: string;
  createdAt: string;
}

interface WatchingEntry {
  buddyRecord: { id: string; confirmationStatus: string };
  protectedUser: ProtectedUser;
  activeTimer: SafetyTimer | null;
  recentAlerts: SafetyAlert[];
}

function useCountdown(targetIso: string | null): string {
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

function initials(user: ProtectedUser): string {
  return ((user.displayName || user.username) ?? "?").charAt(0).toUpperCase();
}

function formatAlertDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function WatchingCard({ entry, index }: { entry: WatchingEntry; index: number }) {
  const { protectedUser, activeTimer, recentAlerts } = entry;
  const isInGrace = activeTimer?.status === "grace_period";
  const countdownTarget = isInGrace ? activeTimer?.gracePeriodEndsAt : activeTimer?.expiresAt;
  const countdown = useCountdown(activeTimer ? (countdownTarget ?? null) : null);
  const hasActiveAlert = recentAlerts.some((a) => a.status === "active");

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <Card
        className={[
          "overflow-hidden transition-colors duration-300",
          isInGrace
            ? "border-destructive/40"
            : hasActiveAlert
            ? "border-amber-500/40"
            : "",
        ].join(" ")}
      >
        {/* Grace period urgent banner */}
        {isInGrace && (
          <div className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-destructive/20">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
            </span>
            <p className="text-xs font-semibold text-destructive">
              Grace period — needs to check in now!
            </p>
          </div>
        )}

        <CardHeader className="pb-3 pt-4">
          {/* Person row */}
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10 shrink-0">
              <AvatarImage src={protectedUser.avatarUrl ?? ""} />
              <AvatarFallback className="text-sm font-medium">
                {initials(protectedUser)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">
                {protectedUser.displayName || protectedUser.username}
              </p>
              <p className="text-xs text-muted-foreground">Protected user</p>
            </div>
            {isInGrace && (
              <Badge variant="destructive" className="shrink-0 text-[10px] gap-1">
                <AlertTriangleIcon className="h-3 w-3" />
                Urgent
              </Badge>
            )}
            {hasActiveAlert && !isInGrace && (
              <Badge variant="destructive" className="shrink-0 text-[10px] gap-1 bg-amber-600 hover:bg-amber-700">
                <AlertTriangleIcon className="h-3 w-3" />
                Alert
              </Badge>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pb-4">
          {/* Timer section */}
          {activeTimer ? (
            <div
              className={[
                "rounded-xl p-3 space-y-1 border",
                isInGrace
                  ? "bg-destructive/5 border-destructive/20"
                  : "bg-primary/5 border-primary/10",
              ].join(" ")}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <TimerIcon
                    className={`h-3.5 w-3.5 ${isInGrace ? "text-destructive" : "text-primary"}`}
                  />
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                    {isInGrace ? "Grace ends in" : "Time remaining"}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {isInGrace
                    ? `Alert fires ${new Date(activeTimer.gracePeriodEndsAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                    : `Expires ${new Date(activeTimer.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                  }
                </p>
              </div>
              <p
                className={`text-3xl font-bold tracking-tight ${isInGrace ? "text-destructive" : ""}`}
                style={{ fontVariantNumeric: "tabular-nums", fontFeatureSettings: '"tnum"' }}
              >
                {countdown || "—"}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TimerIcon className="h-4 w-4 opacity-40" />
              <span>No active timer</span>
            </div>
          )}

          {/* Recent alerts */}
          {recentAlerts.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                Recent alerts
              </p>
              <div className="space-y-1.5">
                {recentAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 bg-muted/40"
                  >
                    <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                      {alert.alertType === "timer_expiry" ? (
                        <TimerIcon className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      ) : (
                        <AlertTriangleIcon className="h-3.5 w-3.5 text-destructive shrink-0" />
                      )}
                      <span className="font-medium text-foreground truncate">
                        {alert.alertType === "timer_expiry" ? "Timer expiry" : "SOS alert"}
                      </span>
                      <span className="shrink-0 opacity-50">·</span>
                      <span className="shrink-0">{formatAlertDate(alert.createdAt)}</span>
                    </div>
                    <div className="shrink-0">
                      {alert.status === "active" ? (
                        <Badge variant="destructive" className="text-[10px] gap-1 py-0">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
                          </span>
                          Active
                        </Badge>
                      ) : alert.status === "safe" ? (
                        <Badge className="bg-green-600 text-white hover:bg-green-700 text-[10px] gap-1 py-0">
                          <CheckCircleIcon className="h-2.5 w-2.5" />
                          Safe
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] gap-1 py-0">
                          <XCircleIcon className="h-2.5 w-2.5" />
                          False alarm
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No alerts state */}
          {recentAlerts.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircleIcon className="h-4 w-4 text-green-500 opacity-70" />
              <span>No recent alerts</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function BuddyDashboardPage() {
  const { data, isLoading } = useQuery<{ watching: WatchingEntry[] }>({
    queryKey: ["/api/safety/watching-over"],
    refetchInterval: 30_000,
  });

  const watching = data?.watching ?? [];
  const urgentCount = watching.filter(
    (e) => e.activeTimer?.status === "grace_period" || e.recentAlerts.some((a) => a.status === "active")
  ).length;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Page header */}
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-serif font-bold">Watching Over</h1>
          {urgentCount > 0 && (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white animate-pulse">
              {urgentCount}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground -mt-4">
          People who have added you as their safety buddy.
        </p>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-44 w-full rounded-xl" />
            <Skeleton className="h-44 w-full rounded-xl" />
          </div>
        ) : watching.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <ShieldIcon className="h-8 w-8 opacity-30" />
            </div>
            <p className="font-medium">No one is relying on you yet</p>
            <p className="text-sm mt-1 opacity-70 max-w-xs mx-auto">
              When someone adds you as their safety buddy and you confirm by SMS, they'll appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {watching.map((entry, i) => (
              <WatchingCard key={entry.buddyRecord.id} entry={entry} index={i} />
            ))}
          </div>
        )}
      </main>
      <BottomNavigation />
    </div>
  );
}