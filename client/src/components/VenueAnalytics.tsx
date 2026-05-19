import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { EyeIcon, MousePointerIcon, TicketIcon } from "@/components/ui/icons";

interface VenueAnalyticsProps {
  venueId: string;
}

interface AnalyticsData {
  views: number;
  clicks: number;
  ticketsSold: number;
}

export function VenueAnalytics({ venueId }: VenueAnalyticsProps) {
  const { data: analytics, isLoading } = useQuery<AnalyticsData>({
    queryKey: ["/api/venues", venueId, "analytics"],
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="text-center text-muted-foreground">Loading analytics...</div>
        </CardContent>
      </Card>
    );
  }

  if (!analytics) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">Venue Performance</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <EyeIcon className="h-5 w-5 mx-auto mb-1 text-blue-500" />
            <div className="text-2xl font-bold" data-testid="text-venue-views">{analytics.views}</div>
            <div className="text-xs text-muted-foreground">Views</div>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <MousePointerIcon className="h-5 w-5 mx-auto mb-1 text-green-500" />
            <div className="text-2xl font-bold" data-testid="text-venue-clicks">{analytics.clicks}</div>
            <div className="text-xs text-muted-foreground">Clicks</div>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <TicketIcon className="h-5 w-5 mx-auto mb-1 text-purple-500" />
            <div className="text-2xl font-bold" data-testid="text-venue-tickets">{analytics.ticketsSold}</div>
            <div className="text-xs text-muted-foreground">Tickets</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
