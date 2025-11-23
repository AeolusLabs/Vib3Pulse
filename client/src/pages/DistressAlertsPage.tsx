import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { ArrowLeft, AlertTriangle, MapPin, Calendar } from "lucide-react";
import { format } from "date-fns";

interface DistressAlert {
  id: string;
  userId: string;
  buddyId: string;
  message: string;
  latitude: string | null;
  longitude: string | null;
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

export default function DistressAlertsPage() {
  const { data, isLoading } = useQuery<{ alerts: DistressAlert[] }>({
    queryKey: ["/api/buddy/alerts"],
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
                className={alert.type === "received" ? "border-destructive" : ""}
                data-testid={`card-alert-${alert.id}`}
              >
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <AlertTriangle
                      className={`h-5 w-5 ${alert.type === "received" ? "text-destructive" : "text-yellow-600"}`}
                    />
                    {alert.type === "received" ? "Received Alert" : "Sent Alert"}
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

                  {alert.latitude && alert.longitude && (
                    <div>
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
                    </div>
                  )}
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
