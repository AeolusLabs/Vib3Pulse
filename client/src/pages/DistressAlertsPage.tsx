import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ArrowLeft, AlertTriangle, MapPin, Calendar, CheckCircle, XCircle, Shield } from "lucide-react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface DistressAlert {
  id: string;
  userId: string;
  buddyId: string;
  message: string;
  latitude: string | null;
  longitude: string | null;
  status: string;
  resolvedAt: string | null;
  createdAt: string;
  type: "sent" | "received";
  buddy?: {
    id: string;
    username: string;
    displayName: string | null;
  };
  sender?: {
    id: string;
    username: string;
    displayName: string | null;
  };
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge variant="destructive" data-testid="badge-status-active">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Active
        </Badge>
      );
    case "resolved":
      return (
        <Badge variant="default" data-testid="badge-status-resolved">
          <CheckCircle className="h-3 w-3 mr-1" />
          Resolved
        </Badge>
      );
    case "false_alarm":
      return (
        <Badge variant="secondary" data-testid="badge-status-false-alarm">
          <XCircle className="h-3 w-3 mr-1" />
          False Alarm
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export default function DistressAlertsPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ alerts: DistressAlert[] }>({
    queryKey: ["/api/buddy/alerts"],
  });

  const resolveMutation = useMutation({
    mutationFn: async (alertId: string) => {
      return apiRequest("POST", `/api/buddy/alerts/${alertId}/resolve`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buddy/alerts"] });
      toast({
        title: "Marked as safe",
        description: "Your buddy has been notified that you're okay.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to resolve alert",
        variant: "destructive",
      });
    },
  });

  const falseAlarmMutation = useMutation({
    mutationFn: async (alertId: string) => {
      return apiRequest("POST", `/api/buddy/alerts/${alertId}/false-alarm`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buddy/alerts"] });
      toast({
        title: "Marked as false alarm",
        description: "Your buddy has been notified it was a false alarm.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to mark as false alarm",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-4 space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/discover">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              Distress Alert History
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              View sent and received emergency alerts
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center p-8" data-testid="loading-alerts">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em]" />
            <p className="mt-4 text-muted-foreground">Loading alerts...</p>
          </div>
        ) : data?.alerts && data.alerts.length > 0 ? (
          <div className="space-y-4">
            {data.alerts.map((alert) => (
              <Card
                key={alert.id}
                className={alert.type === "received" && alert.status === "active" ? "border-destructive" : ""}
                data-testid={`card-alert-${alert.id}`}
              >
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="flex items-center gap-2 text-lg">
                      <AlertTriangle
                        className={`h-5 w-5 ${alert.type === "received" ? "text-destructive" : "text-yellow-600"}`}
                      />
                      {alert.type === "received" ? "Received Alert" : "Sent Alert"}
                    </span>
                    <StatusBadge status={alert.status || "active"} />
                  </CardTitle>
                  <CardDescription>
                    {alert.type === "received" ? (
                      <>
                        From: <strong>{alert.sender?.displayName || alert.sender?.username}</strong>
                      </>
                    ) : (
                      <>
                        To: <strong>{alert.buddy?.displayName || alert.buddy?.username}</strong>
                      </>
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <p className="text-sm font-medium">Message:</p>
                    <p className="text-sm text-muted-foreground italic" data-testid={`text-message-${alert.id}`}>
                      "{alert.message}"
                    </p>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    {format(new Date(alert.createdAt), "PPpp")}
                  </div>

                  {alert.resolvedAt && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      Resolved: {format(new Date(alert.resolvedAt), "PPpp")}
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    {alert.latitude && alert.longitude && (
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        data-testid={`button-view-location-${alert.id}`}
                      >
                        <a
                          href={`https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <MapPin className="h-4 w-4 mr-2" />
                          View Location on Map
                        </a>
                      </Button>
                    )}

                    {alert.type === "sent" && alert.status === "active" && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => resolveMutation.mutate(alert.id)}
                          disabled={resolveMutation.isPending || falseAlarmMutation.isPending}
                          data-testid={`button-im-safe-${alert.id}`}
                        >
                          <Shield className="h-4 w-4 mr-2" />
                          I'm Safe
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => falseAlarmMutation.mutate(alert.id)}
                          disabled={resolveMutation.isPending || falseAlarmMutation.isPending}
                          data-testid={`button-false-alarm-${alert.id}`}
                        >
                          <XCircle className="h-4 w-4 mr-2" />
                          False Alarm
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card data-testid="no-alerts">
            <CardContent className="p-8 text-center">
              <AlertTriangle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-lg font-medium mb-2">No Alerts</p>
              <p className="text-sm text-muted-foreground">
                You haven't sent or received any distress alerts yet.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
