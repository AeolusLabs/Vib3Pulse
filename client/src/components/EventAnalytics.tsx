import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { Skeleton } from "@/components/ui/skeleton";
import { EyeIcon, MousePointerClickIcon, CalendarIcon, TicketIcon, TrendingUpIcon } from "@/components/ui/icons";

interface EventAnalyticsProps {
  eventId: string;
}

interface AnalyticsData {
  views: number;
  clicks: number;
  rsvps: number;
  ticketsSold: number;
  conversionRate: number | null; // null = no views recorded yet
}

export function EventAnalytics({ eventId }: EventAnalyticsProps) {
  const { data: analytics, isLoading } = useQuery<AnalyticsData>({
    queryKey: [`/api/events/${eventId}/analytics`],
    enabled: !!eventId,
  });

  if (isLoading) {
    return (
      <Card data-testid="card-analytics-loading">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUpIcon className="h-5 w-5" />
            Event Analytics
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!analytics) {
    return null;
  }

  const stats = [
    {
      label: "Views",
      value: analytics.views,
      icon: EyeIcon,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
    },
    {
      label: "Clicks",
      value: analytics.clicks,
      icon: MousePointerClickIcon,
      color: "text-green-500",
      bgColor: "bg-green-500/10",
    },
    {
      label: "RSVPs / interested",
      value: analytics.rsvps,
      icon: CalendarIcon,
      color: "text-purple-500",
      bgColor: "bg-purple-500/10",
    },
    {
      label: "Paid tickets",
      value: analytics.ticketsSold,
      icon: TicketIcon,
      color: "text-orange-500",
      bgColor: "bg-orange-500/10",
    },
  ];

  // Computed server-side from distinct people (a free RSVP also issues a ticket, so adding the
  // two columns here would count them twice). null -> "—" rather than a misleading 0%.
  const conversionRate = analytics.conversionRate;

  return (
    <Card data-testid="card-analytics">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUpIcon className="h-5 w-5" />
          Event Analytics
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={`rounded-lg p-4 ${stat.bgColor}`}
              data-testid={`stat-${stat.label.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
                <span className="text-sm text-muted-foreground">{stat.label}</span>
              </div>
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            </div>
          ))}
        </div>
        
        <div className="border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Conversion Rate</span>
            <span className="text-lg font-semibold text-primary" data-testid="text-conversion-rate">
              {conversionRate === null ? "—" : `${conversionRate}%`}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {conversionRate === null
              ? "No views recorded yet. Conversion appears once people start viewing this event."
              : "People who RSVP'd or bought a ticket, as a share of views"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
