import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import {
  AlertTriangleIcon,
  ClockIcon,
  MapPinIcon,
  TimerIcon,
  CheckCircleIcon,
  XCircleIcon,
} from "@/components/ui/icons";

interface SafetyAlert {
  id: string;
  userId: string;
  buddyId: string;
  alertType: "manual_sos" | "timer_expiry";
  message: string;
  latitude: number | null;
  longitude: number | null;
  locationText: string | null;
  status: "active" | "safe" | "false_alarm";
  timerId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  type: "sent" | "received";
  buddy?: Omit<User, "passwordHash">;
  sender?: Omit<User, "passwordHash">;
}

function alertTypeLabel(alert: SafetyAlert) {
  return alert.alertType === "timer_expiry" ? "Timer Expiry" : "Manual SOS";
}

function statusBadge(status: SafetyAlert["status"]) {
  if (status === "active")
    return (
      <Badge variant="destructive" className="gap-1">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
        </span>
        Active
      </Badge>
    );
  if (status === "safe")
    return (
      <Badge className="bg-green-600 text-white hover:bg-green-700 gap-1">
        <CheckCircleIcon className="h-3 w-3" />
        Safe
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <XCircleIcon className="h-3 w-3" />
      False Alarm
    </Badge>
  );
}

function initials(u: Omit<User, "passwordHash">) {
  return ((u.displayName || u.username) ?? "?").charAt(0).toUpperCase();
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function openMapsLink(lat: number, lng: number) {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

export default function DistressAlertsPage() {
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ alerts: SafetyAlert[] }>({
    queryKey: ["/api/safety/alerts"],
    refetchInterval: (query) => {
      const alerts = (query.state.data as any)?.alerts ?? [];
      return alerts.some((a: SafetyAlert) => a.status === "active") ? 15_000 : 30_000;
    },
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/safety/alerts/${id}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/alerts"] });
      toast({ title: "Marked as safe" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const falseAlarmMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/safety/alerts/${id}/false-alarm`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/alerts"] });
      toast({ title: "Marked as false alarm" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const alerts = data?.alerts ?? [];
  const activeAlerts = alerts.filter((a) => a.status === "active");
  const resolvedAlerts = alerts.filter((a) => a.status !== "active");

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-serif font-bold">Safety Alerts</h1>
          {activeAlerts.length > 0 && (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white">
              {activeAlerts.length}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
          </div>
        ) : alerts.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <AlertTriangleIcon className="h-8 w-8 opacity-30" />
            </div>
            <p className="font-medium">No alerts yet</p>
            <p className="text-sm mt-1 opacity-70">Alerts appear here when your SOS fires or a timer expires.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {activeAlerts.length > 0 && (
              <section className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                  Needs action
                </p>
                {activeAlerts.map((alert, i) => (
                  <ActiveAlertCard
                    key={alert.id}
                    alert={alert}
                    style={{ animationDelay: `${i * 60}ms` }}
                    onResolve={() => resolveMutation.mutate(alert.id)}
                    onFalseAlarm={() => falseAlarmMutation.mutate(alert.id)}
                    resolving={resolveMutation.isPending}
                    falseAlarming={falseAlarmMutation.isPending}
                  />
                ))}
              </section>
            )}

            {resolvedAlerts.length > 0 && (
              <section className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                  History
                </p>
                {resolvedAlerts.map((alert, i) => (
                  <ResolvedAlertCard
                    key={alert.id}
                    alert={alert}
                    style={{ animationDelay: `${i * 50}ms` }}
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </main>
      <BottomNavigation />
    </div>
  );
}

function ActiveAlertCard({
  alert,
  style,
  onResolve,
  onFalseAlarm,
  resolving,
  falseAlarming,
}: {
  alert: SafetyAlert;
  style?: React.CSSProperties;
  onResolve: () => void;
  onFalseAlarm: () => void;
  resolving?: boolean;
  falseAlarming?: boolean;
}) {
  const other = alert.type === "sent" ? alert.buddy : alert.sender;
  const directionLabel = alert.type === "sent" ? "You alerted" : "Alerted by";
  const isSOS = alert.alertType === "manual_sos";

  return (
    <div
      className={[
        "rounded-2xl border-2 p-5 space-y-4",
        isSOS
          ? "border-destructive/30 bg-destructive/5"
          : "border-amber-500/30 bg-amber-500/5",
        "animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both",
      ].join(" ")}
      style={style}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className={[
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            isSOS ? "bg-destructive/15" : "bg-amber-500/15",
          ].join(" ")}>
            {isSOS
              ? <AlertTriangleIcon className="h-4 w-4 text-destructive" />
              : <TimerIcon className="h-4 w-4 text-amber-600" />
            }
          </div>
          <div>
            <p className="font-semibold text-sm">{alertTypeLabel(alert)}</p>
            <p className="text-xs text-muted-foreground">{formatDate(alert.createdAt)}</p>
          </div>
        </div>
        {statusBadge(alert.status)}
      </div>

      {/* Who */}
      {other && (
        <div className="flex items-center gap-2.5">
          <Avatar className="h-8 w-8">
            <AvatarImage src={other.avatarUrl ?? ""} />
            <AvatarFallback className="text-xs">{initials(other)}</AvatarFallback>
          </Avatar>
          <p className="text-sm">
            <span className="text-muted-foreground">{directionLabel}: </span>
            <span className="font-semibold">{other.displayName || other.username}</span>
          </p>
        </div>
      )}

      {/* Message */}
      <p className="text-sm leading-relaxed">{alert.message}</p>

      {/* Location */}
      {alert.latitude !== null && alert.longitude !== null && (
        <a
          href={openMapsLink(alert.latitude, alert.longitude)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-primary hover:underline w-fit"
        >
          <MapPinIcon className="h-3.5 w-3.5" />
          {alert.locationText
            ? alert.locationText
            : `${alert.latitude.toFixed(5)}, ${alert.longitude.toFixed(5)}`}
          <span className="text-muted-foreground">— open in maps</span>
        </a>
      )}

      {/* Actions — only for sent alerts the user can resolve */}
      {alert.type === "sent" && (
        <div className="flex flex-col gap-2 pt-1">
          <Button
            size="lg"
            className="w-full rounded-full gap-2 bg-green-600 hover:bg-green-700 text-white"
            onClick={onResolve}
            disabled={resolving || falseAlarming}
            data-testid="button-im-safe"
          >
            <CheckCircleIcon className="h-4 w-4" />
            {resolving ? "Sending…" : "I'm Safe"}
          </Button>
          <Button
            variant="outline"
            className="w-full rounded-full"
            onClick={onFalseAlarm}
            disabled={resolving || falseAlarming}
          >
            False Alarm
          </Button>
        </div>
      )}
    </div>
  );
}

function ResolvedAlertCard({
  alert,
  style,
}: {
  alert: SafetyAlert;
  style?: React.CSSProperties;
}) {
  const other = alert.type === "sent" ? alert.buddy : alert.sender;
  const directionLabel = alert.type === "sent" ? "You alerted" : "Alerted by";

  return (
    <div
      className="rounded-xl border bg-card p-4 space-y-3 opacity-75 animate-in fade-in duration-300 fill-mode-both"
      style={style}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {alert.alertType === "timer_expiry"
            ? <TimerIcon className="h-3.5 w-3.5 text-amber-500" />
            : <AlertTriangleIcon className="h-3.5 w-3.5 text-destructive/60" />
          }
          <span>{alertTypeLabel(alert)}</span>
          <span>·</span>
          <span>{formatDate(alert.createdAt)}</span>
        </div>
        {statusBadge(alert.status)}
      </div>

      {other && (
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6">
            <AvatarImage src={other.avatarUrl ?? ""} />
            <AvatarFallback className="text-[10px]">{initials(other)}</AvatarFallback>
          </Avatar>
          <p className="text-xs text-muted-foreground">
            {directionLabel}: <span className="font-medium text-foreground">{other.displayName || other.username}</span>
          </p>
        </div>
      )}

      {alert.latitude !== null && alert.longitude !== null && (
        <a
          href={openMapsLink(alert.latitude, alert.longitude)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary w-fit"
        >
          <MapPinIcon className="h-3 w-3" />
          {alert.locationText ?? `${alert.latitude.toFixed(4)}, ${alert.longitude.toFixed(4)}`}
        </a>
      )}
    </div>
  );
}