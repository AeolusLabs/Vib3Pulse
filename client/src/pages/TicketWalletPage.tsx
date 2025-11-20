import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Calendar, MapPin, Ticket } from "lucide-react";
import { format } from "date-fns";
import type { Ticket as TicketType, Event } from "@shared/schema";

type TicketWithEvent = TicketType & { event: Event };

export default function TicketWalletPage() {
  const { data: tickets, isLoading } = useQuery<TicketWithEvent[]>({
    queryKey: ["/api/tickets"],
    queryFn: async () => {
      const response = await fetch("/api/tickets", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Failed to fetch tickets");
      }
      return response.json();
    },
  });

  const now = new Date();
  const upcomingTickets = tickets?.filter(ticket => new Date(ticket.event.eventDate) >= now) || [];
  const pastTickets = tickets?.filter(ticket => new Date(ticket.event.eventDate) < now) || [];

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 max-w-6xl">
        <div className="space-y-4">
          <h1 className="text-3xl font-bold">My Tickets</h1>
          <div className="text-muted-foreground">Loading your tickets...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold" data-testid="heading-ticket-wallet">My Tickets</h1>
          <p className="text-muted-foreground mt-2">View and manage your event tickets</p>
        </div>

        <Tabs defaultValue="upcoming" className="w-full" data-testid="tabs-tickets">
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">
              Upcoming ({upcomingTickets.length})
            </TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">
              Past ({pastTickets.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming" className="space-y-4 mt-6" data-testid="content-upcoming">
            {upcomingTickets.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center text-muted-foreground">
                  <Ticket className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No upcoming tickets</p>
                  <p className="text-sm mt-2">Purchase tickets from the Discover page to see them here</p>
                </CardContent>
              </Card>
            ) : (
              upcomingTickets.map((ticket) => (
                <Card key={ticket.id} className="hover-elevate" data-testid={`ticket-${ticket.id}`}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <CardTitle className="text-xl" data-testid={`ticket-title-${ticket.id}`}>
                          {ticket.event.title}
                        </CardTitle>
                        <CardDescription className="mt-2">
                          <div className="flex items-center gap-2 mt-1">
                            <Calendar className="h-4 w-4" />
                            <span data-testid={`ticket-date-${ticket.id}`}>
                              {format(new Date(ticket.event.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <MapPin className="h-4 w-4" />
                            <span data-testid={`ticket-location-${ticket.id}`}>{ticket.event.location}</span>
                          </div>
                        </CardDescription>
                      </div>
                      <Badge variant="default" data-testid={`ticket-status-${ticket.id}`}>
                        {ticket.status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardFooter className="text-sm text-muted-foreground">
                    Purchased on {format(new Date(ticket.purchaseDate), "MMM d, yyyy")}
                  </CardFooter>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="past" className="space-y-4 mt-6" data-testid="content-past">
            {pastTickets.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center text-muted-foreground">
                  <Ticket className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No past tickets</p>
                </CardContent>
              </Card>
            ) : (
              pastTickets.map((ticket) => (
                <Card key={ticket.id} className="opacity-75" data-testid={`ticket-${ticket.id}`}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <CardTitle className="text-xl" data-testid={`ticket-title-${ticket.id}`}>
                          {ticket.event.title}
                        </CardTitle>
                        <CardDescription className="mt-2">
                          <div className="flex items-center gap-2 mt-1">
                            <Calendar className="h-4 w-4" />
                            <span data-testid={`ticket-date-${ticket.id}`}>
                              {format(new Date(ticket.event.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <MapPin className="h-4 w-4" />
                            <span data-testid={`ticket-location-${ticket.id}`}>{ticket.event.location}</span>
                          </div>
                        </CardDescription>
                      </div>
                      <Badge variant="secondary" data-testid={`ticket-status-${ticket.id}`}>
                        Attended
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardFooter className="text-sm text-muted-foreground">
                    Purchased on {format(new Date(ticket.purchaseDate), "MMM d, yyyy")}
                  </CardFooter>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
