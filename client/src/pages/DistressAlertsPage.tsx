import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

import type { User } from "@shared/schema";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { AlertTriangleIcon, ClockIcon, MapPinIcon, TimerIcon, CheckCircleIcon, XCircleIcon } from "@/components/ui/icons";

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
  if (status === "active") return <Badge variant="destructive"><ClockIcon className="h-3 w-3 mr-1" />Active</Badge>;
  if (status === "safe") return <Badge variant="default"><CheckCircleIcon className="h-3 w-3 mr-1" />Safe</Badge>;
  return <Badge variant="secondary"><XCircleIcon className="h-3 w-3 mr-1" />False Alarm</Badge>;
}

function initials(u: Omit<User, "passwordHash">) {
  return ((u.displayName || u.username) ?? "?").charAt(0).toUpperCase();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function DistressAlertsPage() {
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ alerts: SafetyAlert[] }>({
    queryKey: ["/api/safety/alerts"],
    refetchInterval: 30_000,
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
        <h1 className="text-3xl font-serif font-bold">Safety Alerts</h1>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
          </div>
        ) : alerts.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <AlertTriangleIcon className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No alerts yet</p>
          </div>
        ) : (
          <div className="space-y-6">
            {activeAlerts.length > 0 && (
              <section className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Active</p>
                {activeAlerts.map((alert) => (
                  <AlertCard
                    key={alert.id}
                    alert={alert}
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
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">History</p>
                {resolvedAlerts.map((alert) => (
                  <AlertCard key={alert.id} alert={alert} />
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

function AlertCard({
  alert,
  onResolve,
  onFalseAlarm,
  resolving,
  falseAlarming,
}: {
  alert: SafetyAlert;
  onResolve?: () => void;
  onFalseAlarm?: () => void;
  resolving?: boolean;
  falseAlarming?: boolean;
}) {
  const other = alert.type === "sent" ? alert.buddy : alert.sender;
  const directionLabel = alert.type === "sent" ? "You alerted" : "Alerted by";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            {alert.alertType === "timer_expiry" ? (
              <TimerIcon className="h-4 w-4 text-orange-500" />
            ) : (
              <AlertTriangleIcon className="h-4 w-4 text-destructive" />
            )}
            {alertTypeLabel(alert)}
          </div>
          {statusBadge(alert.status)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {other && (
          <div className="flex items-center gap-2">
            <Avatar className="h-7 w-7">
              <AvatarImage src={other.avatarUrl ?? ""} />
              <AvatarFallback className="text-xs">{initials(other)}</AvatarFallback>
            </Avatar>
            <div className="text-sm">
              <span className="text-muted-foreground">{directionLabel}: </span>
              <span className="font-medium">{other.displayName || other.username}</span>
            </div>
          </div>
        )}

        <p className="text-sm">{alert.message}</p>

        {(alert.latitude !== null && alert.longitude !== null) && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPinIcon className="h-3.5 w-3.5" />
            {alert.locationText
              ? alert.locationText
              : `${alert.latitude.toFixed(5)}, ${alert.longitude.toFixed(5)}`}
          </div>
        )}

        <p className="text-xs text-muted-foreground">{formatDate(alert.createdAt)}</p>

        {alert.status === "active" && alert.type === "sent" && onResolve && onFalseAlarm && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={onResolve} disabled={resolving || falseAlarming}>
              <CheckCircleIcon className="h-3.5 w-3.5 mr-1" />
              I'm Safe
            </Button>
            <Button variant="outline" size="sm" onClick={onFalseAlarm} disabled={resolving || falseAlarming}>
              False Alarm
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
