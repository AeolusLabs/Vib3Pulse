import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  BarChart3, 
  Users, 
  Ticket, 
  Eye, 
  DollarSign, 
  Calendar,
  TrendingUp,
  PieChart as PieChartIcon,
  Target,
  Award,
  ArrowUpRight,
  ArrowDownRight,
  Minus
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
  ComposedChart,
  Line,
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
  eventBreakdown: { eventId: string; title: string; rsvps: number; tickets: number; views: number; revenue: number; ticketPrice: number }[];
  ticketSalesByAge: { ageGroup: string; tickets: number; revenue: number; percentage: number }[];
  ticketSalesByGender: { gender: string; tickets: number; revenue: number; percentage: number }[];
  averageTicketPrice: number;
  bestSellingEvent: { title: string; tickets: number; revenue: number } | null;
  conversionRate: number;
}

const PURPLE_GRADIENT = ['#8B5CF6', '#A78BFA', '#C4B5FD', '#DDD6FE', '#EDE9FE', '#F5F3FF'];
const GENDER_COLORS = ['#6366F1', '#EC4899', '#8B5CF6', '#94A3B8'];
const EVENT_COLORS = ['#8B5CF6', '#6366F1', '#3B82F6', '#0EA5E9', '#14B8A6', '#10B981', '#84CC16'];

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

  const formatCompactNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
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
      <DialogContent className="max-w-5xl max-h-[90vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-950/30 dark:to-indigo-950/30">
          <DialogTitle className="flex items-center gap-3 text-xl font-serif">
            <div className="p-2 bg-purple-100 dark:bg-purple-900/50 rounded-lg">
              <TrendingUp className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            </div>
            Analytics Dashboard
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-organizer-name">
            Complete ticket sales & performance report for {organizerName}
          </p>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)]">
          <div className="p-6 space-y-6">
            {isLoading ? (
              <div className="space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-28 w-full" />
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
                <p className="text-sm text-muted-foreground mt-2">Please try again later</p>
              </div>
            ) : demographics ? (
              <>
                {/* Primary KPI Cards - Ticket Sales Focus */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="bg-gradient-to-br from-purple-500/10 to-purple-600/5 border-purple-200 dark:border-purple-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Ticket className="h-4 w-4 text-purple-600" />
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Sales</span>
                        </div>
                        {demographics.totalTicketsSold > 0 && (
                          <ArrowUpRight className="h-4 w-4 text-green-500" />
                        )}
                      </div>
                      <p className="text-3xl font-bold text-purple-700 dark:text-purple-400" data-testid="stat-tickets-sold">
                        {formatCompactNumber(demographics.totalTicketsSold)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">tickets sold</p>
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-200 dark:border-emerald-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <DollarSign className="h-4 w-4 text-emerald-600" />
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Revenue</span>
                        </div>
                        {demographics.totalRevenue > 0 && (
                          <ArrowUpRight className="h-4 w-4 text-green-500" />
                        )}
                      </div>
                      <p className="text-3xl font-bold text-emerald-700 dark:text-emerald-400" data-testid="stat-revenue">
                        {formatCurrency(demographics.totalRevenue)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">total earnings</p>
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-200 dark:border-blue-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Target className="h-4 w-4 text-blue-600" />
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Avg. Price</span>
                        </div>
                      </div>
                      <p className="text-3xl font-bold text-blue-700 dark:text-blue-400" data-testid="stat-avg-price">
                        {formatCurrency(demographics.averageTicketPrice)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">per ticket</p>
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-amber-200 dark:border-amber-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-amber-600" />
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Conversion</span>
                        </div>
                        {demographics.conversionRate >= 5 ? (
                          <ArrowUpRight className="h-4 w-4 text-green-500" />
                        ) : demographics.conversionRate > 0 ? (
                          <Minus className="h-4 w-4 text-amber-500" />
                        ) : null}
                      </div>
                      <p className="text-3xl font-bold text-amber-700 dark:text-amber-400" data-testid="stat-conversion">
                        {demographics.conversionRate}%
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">view to sale</p>
                    </CardContent>
                  </Card>
                </div>

                {/* Secondary Stats Row */}
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-4 pb-4 flex items-center gap-4">
                      <div className="p-3 bg-purple-100 dark:bg-purple-900/50 rounded-lg">
                        <Calendar className="h-5 w-5 text-purple-600" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold" data-testid="stat-total-events">{demographics.totalEvents}</p>
                        <p className="text-xs text-muted-foreground">Total Events</p>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4 pb-4 flex items-center gap-4">
                      <div className="p-3 bg-blue-100 dark:bg-blue-900/50 rounded-lg">
                        <Users className="h-5 w-5 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold" data-testid="stat-total-rsvps">{demographics.totalRsvps}</p>
                        <p className="text-xs text-muted-foreground">Total RSVPs</p>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4 pb-4 flex items-center gap-4">
                      <div className="p-3 bg-amber-100 dark:bg-amber-900/50 rounded-lg">
                        <Eye className="h-5 w-5 text-amber-600" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold" data-testid="stat-total-views">{formatCompactNumber(demographics.totalViews)}</p>
                        <p className="text-xs text-muted-foreground">Total Views</p>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Best Selling Event Highlight */}
                {demographics.bestSellingEvent && (
                  <Card className="bg-gradient-to-r from-yellow-50 to-amber-50 dark:from-yellow-950/20 dark:to-amber-950/20 border-yellow-200 dark:border-yellow-800">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-4">
                        <div className="p-3 bg-yellow-100 dark:bg-yellow-900/50 rounded-lg">
                          <Award className="h-6 w-6 text-yellow-600" />
                        </div>
                        <div className="flex-1">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Best Selling Event</p>
                          <p className="font-semibold text-lg">{demographics.bestSellingEvent.title}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-bold text-purple-600">{demographics.bestSellingEvent.tickets}</p>
                          <p className="text-sm text-muted-foreground">tickets • {formatCurrency(demographics.bestSellingEvent.revenue)}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Tabs for Different Analytics Views */}
                <Tabs defaultValue="sales" className="w-full">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="sales" className="gap-2">
                      <Ticket className="h-4 w-4" />
                      Ticket Sales
                    </TabsTrigger>
                    <TabsTrigger value="demographics" className="gap-2">
                      <Users className="h-4 w-4" />
                      Demographics
                    </TabsTrigger>
                    <TabsTrigger value="events" className="gap-2">
                      <Calendar className="h-4 w-4" />
                      Event Performance
                    </TabsTrigger>
                  </TabsList>

                  {/* Ticket Sales Tab */}
                  <TabsContent value="sales" className="space-y-6 mt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Ticket Sales by Event */}
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <BarChart3 className="h-4 w-4 text-purple-600" />
                            Sales by Event
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Ticket sales performance per event
                          </p>
                        </CardHeader>
                        <CardContent>
                          {demographics.eventBreakdown.length > 0 && demographics.eventBreakdown.some(e => e.tickets > 0) ? (
                            <div className="h-72">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart
                                  data={demographics.eventBreakdown.filter(e => e.tickets > 0).slice(0, 7)}
                                  layout="vertical"
                                  margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                                >
                                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} horizontal={true} vertical={false} />
                                  <XAxis type="number" tickFormatter={(v) => formatCompactNumber(v)} />
                                  <YAxis 
                                    type="category" 
                                    dataKey="title" 
                                    tick={{ fontSize: 11 }}
                                    width={100}
                                    tickFormatter={(value) => value.length > 15 ? `${value.slice(0, 15)}...` : value}
                                  />
                                  <Tooltip
                                    contentStyle={{
                                      backgroundColor: 'hsl(var(--card))',
                                      border: '1px solid hsl(var(--border))',
                                      borderRadius: '8px',
                                    }}
                                    formatter={(value: number, name: string) => [
                                      name === 'tickets' ? `${value} tickets` : formatCurrency(value),
                                      name === 'tickets' ? 'Tickets Sold' : 'Revenue'
                                    ]}
                                  />
                                  <Bar 
                                    dataKey="tickets" 
                                    fill="#8B5CF6" 
                                    radius={[0, 4, 4, 0]}
                                    name="tickets"
                                  />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          ) : (
                            <div className="h-72 flex items-center justify-center text-muted-foreground">
                              <div className="text-center">
                                <Ticket className="h-10 w-10 mx-auto mb-2 opacity-50" />
                                <p>No ticket sales yet</p>
                                <p className="text-xs mt-1">Sales data appears when tickets are purchased</p>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      {/* Revenue by Event */}
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <DollarSign className="h-4 w-4 text-emerald-600" />
                            Revenue by Event
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Revenue generated per event
                          </p>
                        </CardHeader>
                        <CardContent>
                          {demographics.eventBreakdown.length > 0 && demographics.eventBreakdown.some(e => e.revenue > 0) ? (
                            <div className="h-72">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart
                                  data={demographics.eventBreakdown.filter(e => e.revenue > 0).slice(0, 7)}
                                  layout="vertical"
                                  margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                                >
                                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} horizontal={true} vertical={false} />
                                  <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} />
                                  <YAxis 
                                    type="category" 
                                    dataKey="title" 
                                    tick={{ fontSize: 11 }}
                                    width={100}
                                    tickFormatter={(value) => value.length > 15 ? `${value.slice(0, 15)}...` : value}
                                  />
                                  <Tooltip
                                    contentStyle={{
                                      backgroundColor: 'hsl(var(--card))',
                                      border: '1px solid hsl(var(--border))',
                                      borderRadius: '8px',
                                    }}
                                    formatter={(value: number) => [formatCurrency(value), 'Revenue']}
                                  />
                                  <Bar 
                                    dataKey="revenue" 
                                    fill="#10B981" 
                                    radius={[0, 4, 4, 0]}
                                    name="revenue"
                                  />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          ) : (
                            <div className="h-72 flex items-center justify-center text-muted-foreground">
                              <div className="text-center">
                                <DollarSign className="h-10 w-10 mx-auto mb-2 opacity-50" />
                                <p>No revenue data yet</p>
                                <p className="text-xs mt-1">Revenue appears when paid tickets are sold</p>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </div>

                    {/* Ticket Sales by Demographics */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Ticket Sales by Age */}
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <BarChart3 className="h-4 w-4 text-indigo-600" />
                            Sales by Age Group
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Which age groups are buying the most tickets
                          </p>
                        </CardHeader>
                        <CardContent>
                          {demographics.ticketSalesByAge.length > 0 ? (
                            <div className="h-64">
                              <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart
                                  data={demographics.ticketSalesByAge}
                                  margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                                >
                                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                                  <XAxis dataKey="ageGroup" tick={{ fontSize: 11 }} />
                                  <YAxis yAxisId="left" tickFormatter={(v) => `${v}`} />
                                  <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => formatCurrency(v)} />
                                  <Tooltip
                                    contentStyle={{
                                      backgroundColor: 'hsl(var(--card))',
                                      border: '1px solid hsl(var(--border))',
                                      borderRadius: '8px',
                                    }}
                                    formatter={(value: number, name: string) => [
                                      name === 'tickets' ? `${value} tickets (${demographics.ticketSalesByAge.find(a => a.tickets === value)?.percentage || 0}%)` : formatCurrency(value),
                                      name === 'tickets' ? 'Tickets' : 'Revenue'
                                    ]}
                                  />
                                  <Legend />
                                  <Bar 
                                    yAxisId="left"
                                    dataKey="tickets" 
                                    fill="#8B5CF6" 
                                    radius={[4, 4, 0, 0]}
                                    name="Tickets"
                                  />
                                  <Line 
                                    yAxisId="right"
                                    type="monotone" 
                                    dataKey="revenue" 
                                    stroke="#10B981" 
                                    strokeWidth={2}
                                    dot={{ fill: '#10B981', strokeWidth: 2 }}
                                    name="Revenue"
                                  />
                                </ComposedChart>
                              </ResponsiveContainer>
                            </div>
                          ) : (
                            <div className="h-64 flex items-center justify-center text-muted-foreground">
                              <div className="text-center">
                                <Users className="h-10 w-10 mx-auto mb-2 opacity-50" />
                                <p>No age data available</p>
                                <p className="text-xs mt-1">Age breakdown appears with ticket purchases</p>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      {/* Ticket Sales by Gender */}
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <PieChartIcon className="h-4 w-4 text-pink-600" />
                            Sales by Gender
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Gender distribution of ticket buyers
                          </p>
                        </CardHeader>
                        <CardContent>
                          {demographics.ticketSalesByGender.length > 0 ? (
                            <div className="h-64">
                              <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                  <Pie
                                    data={demographics.ticketSalesByGender}
                                    cx="50%"
                                    cy="45%"
                                    innerRadius={45}
                                    outerRadius={75}
                                    paddingAngle={3}
                                    dataKey="tickets"
                                    nameKey="gender"
                                    label={({ gender, percentage }) => `${percentage}%`}
                                    labelLine={false}
                                  >
                                    {demographics.ticketSalesByGender.map((entry, index) => (
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
                                      `${value} tickets • ${formatCurrency(props.payload.revenue)}`,
                                      props.payload.gender
                                    ]}
                                  />
                                  <Legend 
                                    verticalAlign="bottom" 
                                    height={36}
                                    formatter={(value, entry: any) => (
                                      <span className="text-sm">
                                        {value}: {entry.payload.tickets} ({entry.payload.percentage}%)
                                      </span>
                                    )}
                                  />
                                </PieChart>
                              </ResponsiveContainer>
                            </div>
                          ) : (
                            <div className="h-64 flex items-center justify-center text-muted-foreground">
                              <div className="text-center">
                                <PieChartIcon className="h-10 w-10 mx-auto mb-2 opacity-50" />
                                <p>No gender data available</p>
                                <p className="text-xs mt-1">Gender breakdown appears with ticket purchases</p>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  </TabsContent>

                  {/* Demographics Tab */}
                  <TabsContent value="demographics" className="space-y-6 mt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Age Distribution */}
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <BarChart3 className="h-4 w-4 text-purple-600" />
                            Audience Age Distribution
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            All attendees by age group (RSVPs + Tickets)
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

                      {/* Gender Distribution */}
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
                                    cy="45%"
                                    innerRadius={45}
                                    outerRadius={75}
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
                  </TabsContent>

                  {/* Event Performance Tab */}
                  <TabsContent value="events" className="space-y-6 mt-6">
                    {demographics.eventBreakdown.length > 0 ? (
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <TrendingUp className="h-4 w-4 text-indigo-600" />
                            Event Performance Matrix
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Detailed performance metrics for each event
                          </p>
                        </CardHeader>
                        <CardContent>
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b bg-muted/50">
                                  <th className="text-left py-3 px-3 font-semibold">Event</th>
                                  <th className="text-right py-3 px-3 font-semibold">Price</th>
                                  <th className="text-right py-3 px-3 font-semibold">Views</th>
                                  <th className="text-right py-3 px-3 font-semibold">RSVPs</th>
                                  <th className="text-right py-3 px-3 font-semibold">Tickets</th>
                                  <th className="text-right py-3 px-3 font-semibold">Revenue</th>
                                  <th className="text-right py-3 px-3 font-semibold">Conv. Rate</th>
                                </tr>
                              </thead>
                              <tbody>
                                {demographics.eventBreakdown.map((event, index) => {
                                  const totalEngagement = event.rsvps + event.tickets;
                                  const conversionRate = event.views > 0 
                                    ? ((totalEngagement / event.views) * 100).toFixed(1) 
                                    : '0';
                                  return (
                                    <tr 
                                      key={event.eventId} 
                                      className={`border-b last:border-0 hover:bg-muted/50 transition-colors ${index % 2 === 0 ? 'bg-background' : 'bg-muted/20'}`}
                                      data-testid={`row-event-${event.eventId}`}
                                    >
                                      <td className="py-3 px-3">
                                        <span className="font-medium line-clamp-1" title={event.title}>{event.title}</span>
                                      </td>
                                      <td className="text-right py-3 px-3">
                                        <span className="text-muted-foreground">{formatCurrency(event.ticketPrice)}</span>
                                      </td>
                                      <td className="text-right py-3 px-3">
                                        <Badge variant="secondary" className="font-mono text-xs">
                                          {formatCompactNumber(event.views)}
                                        </Badge>
                                      </td>
                                      <td className="text-right py-3 px-3">
                                        <Badge variant="secondary" className="font-mono text-xs bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                                          {event.rsvps}
                                        </Badge>
                                      </td>
                                      <td className="text-right py-3 px-3">
                                        <Badge variant="secondary" className="font-mono text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300">
                                          {event.tickets}
                                        </Badge>
                                      </td>
                                      <td className="text-right py-3 px-3">
                                        <Badge variant="secondary" className="font-mono text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                                          {formatCurrency(event.revenue)}
                                        </Badge>
                                      </td>
                                      <td className="text-right py-3 px-3">
                                        <Badge 
                                          variant="secondary" 
                                          className={`font-mono text-xs ${
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
                              <tfoot>
                                <tr className="border-t-2 bg-muted/50 font-semibold">
                                  <td className="py-3 px-3">Total</td>
                                  <td className="text-right py-3 px-3">-</td>
                                  <td className="text-right py-3 px-3">{formatCompactNumber(demographics.totalViews)}</td>
                                  <td className="text-right py-3 px-3">{demographics.totalRsvps}</td>
                                  <td className="text-right py-3 px-3">{demographics.totalTicketsSold}</td>
                                  <td className="text-right py-3 px-3">{formatCurrency(demographics.totalRevenue)}</td>
                                  <td className="text-right py-3 px-3">{demographics.conversionRate}%</td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </CardContent>
                      </Card>
                    ) : (
                      <div className="text-center py-12">
                        <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50 text-muted-foreground" />
                        <p className="text-muted-foreground">No events to display</p>
                        <p className="text-sm text-muted-foreground mt-1">Create events to see performance metrics</p>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>

                {/* Key Insights */}
                <Card className="bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-950/20 dark:to-indigo-950/20 border-purple-200 dark:border-purple-800">
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-purple-100 dark:bg-purple-900/50 rounded-lg shrink-0">
                        <TrendingUp className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-semibold text-purple-900 dark:text-purple-100">Key Performance Insights</h4>
                        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-purple-800 dark:text-purple-200">
                          {demographics.totalEvents > 0 ? (
                            <>
                              <div className="space-y-2">
                                <p className="flex items-center gap-2">
                                  <span className="w-2 h-2 rounded-full bg-purple-500" />
                                  <span>Total reach: <span className="font-semibold">{demographics.totalRsvps + demographics.totalTicketsSold}</span> attendees across <span className="font-semibold">{demographics.totalEvents}</span> event{demographics.totalEvents !== 1 ? 's' : ''}</span>
                                </p>
                                {demographics.ticketSalesByAge.length > 0 && (
                                  <p className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-indigo-500" />
                                    <span>Top buying age: <span className="font-semibold">{demographics.ticketSalesByAge[0]?.ageGroup}</span> ({demographics.ticketSalesByAge[0]?.percentage}% of sales)</span>
                                  </p>
                                )}
                              </div>
                              <div className="space-y-2">
                                {demographics.ticketSalesByGender.length > 0 && (
                                  <p className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-pink-500" />
                                    <span>Top gender: <span className="font-semibold">{demographics.ticketSalesByGender[0]?.gender}</span> ({demographics.ticketSalesByGender[0]?.percentage}% of buyers)</span>
                                  </p>
                                )}
                                {demographics.bestSellingEvent && (
                                  <p className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                                    <span>Best performer: <span className="font-semibold">{demographics.bestSellingEvent.title.slice(0, 25)}{demographics.bestSellingEvent.title.length > 25 ? '...' : ''}</span></span>
                                  </p>
                                )}
                              </div>
                            </>
                          ) : (
                            <p className="col-span-2">Create events to start tracking your audience analytics and sales performance</p>
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
