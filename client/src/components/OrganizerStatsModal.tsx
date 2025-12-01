import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  BarChart3, 
  Users, 
  Ticket, 
  Eye, 
  DollarSign, 
  Calendar,
  TrendingUp,
  PieChart as PieChartIcon
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

interface OrganizerStatsModalProps {
  organizerId: string;
  organizerName: string;
}

interface DemographicsData {
  totalEvents: number;
  totalRsvps: number;
  totalTicketsSold: number;
  totalViews: number;
  totalRevenue: number;
  ageDistribution: { ageGroup: string; count: number; percentage: number }[];
  genderDistribution: { gender: string; count: number; percentage: number }[];
  eventBreakdown: { eventId: string; title: string; rsvps: number; tickets: number; views: number }[];
}

const AGE_COLORS = ['#8B5CF6', '#A78BFA', '#C4B5FD', '#DDD6FE', '#EDE9FE', '#F5F3FF'];
const GENDER_COLORS = ['#6366F1', '#EC4899', '#8B5CF6', '#94A3B8'];

export function OrganizerStatsModal({ organizerId, organizerName }: OrganizerStatsModalProps) {
  const [open, setOpen] = useState(false);

  const { data: demographics, isLoading, error } = useQuery<DemographicsData>({
    queryKey: [`/api/organizers/${organizerId}/demographics`],
    enabled: open,
  });

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button 
          variant="outline" 
          size="sm"
          className="gap-2"
          data-testid="button-view-stats"
        >
          <BarChart3 className="h-4 w-4" />
          View Stats
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-950/30 dark:to-indigo-950/30">
          <DialogTitle className="flex items-center gap-3 text-xl font-serif">
            <div className="p-2 bg-purple-100 dark:bg-purple-900/50 rounded-lg">
              <TrendingUp className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            </div>
            Analytics Dashboard
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-organizer-name">
            Complete event performance report for {organizerName}
          </p>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)]">
          <div className="p-6 space-y-6">
            {isLoading ? (
              <div className="space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-24 w-full" />
                  ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Skeleton className="h-80 w-full" />
                  <Skeleton className="h-80 w-full" />
                </div>
              </div>
            ) : error ? (
              <div className="text-center py-12">
                <p className="text-destructive">Failed to load analytics data</p>
              </div>
            ) : demographics ? (
              <>
                {/* KPI Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <Card className="bg-gradient-to-br from-purple-500/10 to-purple-600/5 border-purple-200 dark:border-purple-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Calendar className="h-4 w-4 text-purple-600" />
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Events</span>
                      </div>
                      <p className="text-2xl font-bold text-purple-700 dark:text-purple-400" data-testid="stat-total-events">
                        {demographics.totalEvents}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-200 dark:border-blue-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Users className="h-4 w-4 text-blue-600" />
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">RSVPs</span>
                      </div>
                      <p className="text-2xl font-bold text-blue-700 dark:text-blue-400" data-testid="stat-total-rsvps">
                        {demographics.totalRsvps}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-green-500/10 to-green-600/5 border-green-200 dark:border-green-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Ticket className="h-4 w-4 text-green-600" />
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tickets</span>
                      </div>
                      <p className="text-2xl font-bold text-green-700 dark:text-green-400" data-testid="stat-tickets-sold">
                        {demographics.totalTicketsSold}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-amber-200 dark:border-amber-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Eye className="h-4 w-4 text-amber-600" />
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Views</span>
                      </div>
                      <p className="text-2xl font-bold text-amber-700 dark:text-amber-400" data-testid="stat-total-views">
                        {demographics.totalViews}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-200 dark:border-emerald-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-2 mb-2">
                        <DollarSign className="h-4 w-4 text-emerald-600" />
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Revenue</span>
                      </div>
                      <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400" data-testid="stat-revenue">
                        {formatCurrency(demographics.totalRevenue)}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* Demographics Charts */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Age Distribution Chart */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <BarChart3 className="h-4 w-4 text-purple-600" />
                        Audience Age Distribution
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                        Breakdown of attendees by age group
                      </p>
                    </CardHeader>
                    <CardContent>
                      {demographics.ageDistribution.length > 0 ? (
                        <div className="h-64">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                              data={demographics.ageDistribution}
                              layout="vertical"
                              margin={{ top: 5, right: 30, left: 60, bottom: 5 }}
                            >
                              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                              <XAxis type="number" tickFormatter={(v) => `${v}`} />
                              <YAxis 
                                type="category" 
                                dataKey="ageGroup" 
                                tick={{ fontSize: 12 }}
                                width={70}
                              />
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: 'hsl(var(--card))',
                                  border: '1px solid hsl(var(--border))',
                                  borderRadius: '8px',
                                }}
                                formatter={(value: number, name: string, props: any) => [
                                  `${value} (${props.payload.percentage || 0}%)`,
                                  'Attendees'
                                ]}
                              />
                              <Bar 
                                dataKey="count" 
                                fill="#8B5CF6" 
                                radius={[0, 4, 4, 0]}
                                name="Attendees"
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <div className="h-64 flex items-center justify-center text-muted-foreground">
                          <div className="text-center">
                            <Users className="h-10 w-10 mx-auto mb-2 opacity-50" />
                            <p>No demographic data available</p>
                            <p className="text-xs mt-1">Data appears when users RSVP or purchase tickets</p>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Gender Distribution Chart */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <PieChartIcon className="h-4 w-4 text-pink-600" />
                        Audience Gender Distribution
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                        Gender breakdown of your event attendees
                      </p>
                    </CardHeader>
                    <CardContent>
                      {demographics.genderDistribution.length > 0 ? (
                        <div className="h-64">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie
                                data={demographics.genderDistribution}
                                cx="50%"
                                cy="50%"
                                innerRadius={50}
                                outerRadius={80}
                                paddingAngle={4}
                                dataKey="count"
                                nameKey="gender"
                                label={({ gender, percentage }) => `${gender}: ${percentage}%`}
                                labelLine={false}
                              >
                                {demographics.genderDistribution.map((entry, index) => (
                                  <Cell 
                                    key={`cell-${index}`} 
                                    fill={GENDER_COLORS[index % GENDER_COLORS.length]} 
                                  />
                                ))}
                              </Pie>
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: 'hsl(var(--card))',
                                  border: '1px solid hsl(var(--border))',
                                  borderRadius: '8px',
                                }}
                                formatter={(value: number, name: string, props: any) => [
                                  `${value} (${props.payload.percentage || 0}%)`,
                                  props.payload.gender
                                ]}
                              />
                              <Legend 
                                verticalAlign="bottom" 
                                height={36}
                                formatter={(value) => <span className="text-sm">{value}</span>}
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <div className="h-64 flex items-center justify-center text-muted-foreground">
                          <div className="text-center">
                            <PieChartIcon className="h-10 w-10 mx-auto mb-2 opacity-50" />
                            <p>No demographic data available</p>
                            <p className="text-xs mt-1">Data appears when users RSVP or purchase tickets</p>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Event Performance Breakdown */}
                {demographics.eventBreakdown.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <TrendingUp className="h-4 w-4 text-indigo-600" />
                        Event Performance Breakdown
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                        Detailed metrics for each event
                      </p>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left py-3 px-2 font-medium text-muted-foreground">Event</th>
                              <th className="text-right py-3 px-2 font-medium text-muted-foreground">Views</th>
                              <th className="text-right py-3 px-2 font-medium text-muted-foreground">RSVPs</th>
                              <th className="text-right py-3 px-2 font-medium text-muted-foreground">Tickets</th>
                              <th className="text-right py-3 px-2 font-medium text-muted-foreground">Conversion</th>
                            </tr>
                          </thead>
                          <tbody>
                            {demographics.eventBreakdown.map((event) => {
                              const totalEngagement = event.rsvps + event.tickets;
                              const conversionRate = event.views > 0 
                                ? ((totalEngagement / event.views) * 100).toFixed(1) 
                                : '0';
                              return (
                                <tr 
                                  key={event.eventId} 
                                  className="border-b last:border-0 hover:bg-muted/50 transition-colors"
                                  data-testid={`row-event-${event.eventId}`}
                                >
                                  <td className="py-3 px-2">
                                    <span className="font-medium line-clamp-1">{event.title}</span>
                                  </td>
                                  <td className="text-right py-3 px-2">
                                    <Badge variant="secondary" className="font-mono">
                                      {event.views}
                                    </Badge>
                                  </td>
                                  <td className="text-right py-3 px-2">
                                    <Badge variant="secondary" className="font-mono bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                                      {event.rsvps}
                                    </Badge>
                                  </td>
                                  <td className="text-right py-3 px-2">
                                    <Badge variant="secondary" className="font-mono bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                                      {event.tickets}
                                    </Badge>
                                  </td>
                                  <td className="text-right py-3 px-2">
                                    <Badge 
                                      variant="secondary" 
                                      className={`font-mono ${
                                        parseFloat(conversionRate) >= 10 
                                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                                          : parseFloat(conversionRate) >= 5
                                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
                                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                                      }`}
                                    >
                                      {conversionRate}%
                                    </Badge>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Summary Insights */}
                <Card className="bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-950/20 dark:to-indigo-950/20 border-purple-200 dark:border-purple-800">
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-purple-100 dark:bg-purple-900/50 rounded-lg shrink-0">
                        <TrendingUp className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                      </div>
                      <div>
                        <h4 className="font-semibold text-purple-900 dark:text-purple-100">Key Insights</h4>
                        <div className="mt-2 space-y-1 text-sm text-purple-800 dark:text-purple-200">
                          {demographics.totalEvents > 0 ? (
                            <>
                              <p>
                                Total audience reach: <span className="font-semibold">{demographics.totalRsvps + demographics.totalTicketsSold}</span> attendees across <span className="font-semibold">{demographics.totalEvents}</span> event{demographics.totalEvents !== 1 ? 's' : ''}
                              </p>
                              {demographics.ageDistribution.length > 0 && demographics.ageDistribution[0]?.percentage > 0 && (
                                <p>
                                  Primary audience: <span className="font-semibold">{demographics.ageDistribution[0]?.ageGroup}</span> age group ({demographics.ageDistribution[0]?.percentage}% of attendees)
                                </p>
                              )}
                              {demographics.totalViews > 0 ? (
                                <p>
                                  Overall conversion rate: <span className="font-semibold">
                                    {(((demographics.totalRsvps + demographics.totalTicketsSold) / demographics.totalViews) * 100).toFixed(1)}%
                                  </span>
                                </p>
                              ) : (demographics.totalRsvps > 0 || demographics.totalTicketsSold > 0) ? (
                                <p>
                                  Your events have attracted <span className="font-semibold">{demographics.totalRsvps + demographics.totalTicketsSold}</span> engaged attendees
                                </p>
                              ) : (
                                <p>Promote your events to attract more attendees and gather analytics</p>
                              )}
                            </>
                          ) : (
                            <p>Create events to start tracking your audience analytics</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
