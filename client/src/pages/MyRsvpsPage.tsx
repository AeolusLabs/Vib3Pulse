import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarIcon, MapPin, Users, X } from "lucide-react";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import type { Rsvp, Event } from "@shared/schema";

type RsvpWithEvent = Rsvp & { event: Event };

export default function MyRsvpsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: rsvps, isLoading } = useQuery<RsvpWithEvent[]>({
    queryKey: ["/api/rsvps"],
  });

  const cancelRsvpMutation = useMutation({
    mutationFn: async (eventId: string) => {
      const response = await apiRequest("DELETE", `/api/rsvps/${eventId}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rsvps"] });
      toast({
        title: "RSVP Cancelled",
        description: "Your RSVP has been cancelled successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to cancel RSVP. Please try again.",
        variant: "destructive",
      });
    },
  });

  const now = new Date();
  const upcomingRsvps = rsvps?.filter(rsvp => new Date(rsvp.event.eventDate) >= now) || [];
  const pastRsvps = rsvps?.filter(rsvp => new Date(rsvp.event.eventDate) < now) || [];

  const handleCancelRsvp = (eventId: string, eventTitle: string) => {
    if (window.confirm(`Are you sure you want to cancel your RSVP to "${eventTitle}"?`)) {
      cancelRsvpMutation.mutate(eventId);
    }
  };

  const handleViewEvent = (eventId: string) => {
    navigate(`/event/${eventId}`);
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="container max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-serif font-bold mb-6 flex items-center gap-3" data-testid="heading-my-rsvps">
          <CalendarIcon className="h-7 w-7 text-primary" />
          My RSVPs
        </h1>
        {isLoading ? (
          <div className="text-center py-16">
            <p className="text-muted-foreground">Loading your RSVPs...</p>
          </div>
        ) : !rsvps || rsvps.length === 0 ? (
          <div className="text-center py-16 space-y-4">
            <Users className="h-16 w-16 mx-auto text-muted-foreground opacity-50" />
            <div>
              <h2 className="text-xl font-semibold mb-2">No RSVPs Yet</h2>
              <p className="text-muted-foreground mb-4">
                Browse events and RSVP to free events you're interested in
              </p>
              <Button onClick={() => navigate("/discover")} data-testid="button-discover-events">
                Discover Events
              </Button>
            </div>
          </div>
        ) : (
          <Tabs defaultValue="upcoming" className="w-full">
            <TabsList className="grid w-full max-w-md grid-cols-2 mb-8">
              <TabsTrigger value="upcoming" data-testid="tab-upcoming">
                Upcoming ({upcomingRsvps.length})
              </TabsTrigger>
              <TabsTrigger value="past" data-testid="tab-past">
                Past ({pastRsvps.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="upcoming" className="space-y-4">
              {upcomingRsvps.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-muted-foreground">No upcoming RSVPs</p>
                </div>
              ) : (
                upcomingRsvps.map((rsvp) => (
                  <Card key={rsvp.id} className="hover-elevate" data-testid={`card-rsvp-${rsvp.id}`}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <Badge variant="secondary" data-testid={`badge-status-${rsvp.id}`}>
                              {rsvp.status}
                            </Badge>
                            <Badge variant="outline" data-testid={`badge-free-${rsvp.id}`}>
                              Free Event
                            </Badge>
                          </div>
                          <CardTitle 
                            className="text-xl mb-1 cursor-pointer hover:text-primary transition-colors"
                            onClick={() => handleViewEvent(rsvp.event.id)}
                            data-testid={`text-event-title-${rsvp.id}`}
                          >
                            {rsvp.event.title}
                          </CardTitle>
                          <CardDescription data-testid={`text-event-category-${rsvp.id}`}>
                            {rsvp.event.category}
                          </CardDescription>
                        </div>
                        {rsvp.event.imageUrl && (
                          <img
                            src={rsvp.event.imageUrl}
                            alt={rsvp.event.title}
                            className="w-24 h-24 rounded-md object-cover"
                            data-testid={`img-event-${rsvp.id}`}
                          />
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground" data-testid={`text-event-date-${rsvp.id}`}>
                          <CalendarIcon className="h-4 w-4" />
                          <span>
                            {format(new Date(rsvp.event.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground" data-testid={`text-event-location-${rsvp.id}`}>
                          <MapPin className="h-4 w-4" />
                          <span>{rsvp.event.location}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground text-xs pt-2" data-testid={`text-rsvp-date-${rsvp.id}`}>
                          <span>RSVP'd on {format(new Date(rsvp.rsvpDate), "MMM d, yyyy")}</span>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() => handleViewEvent(rsvp.event.id)}
                          data-testid={`button-view-event-${rsvp.id}`}
                        >
                          View Event
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleCancelRsvp(rsvp.event.id, rsvp.event.title)}
                          disabled={cancelRsvpMutation.isPending}
                          data-testid={`button-cancel-rsvp-${rsvp.id}`}
                        >
                          <X className="h-4 w-4 mr-2" />
                          Cancel RSVP
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            <TabsContent value="past" className="space-y-4">
              {pastRsvps.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-muted-foreground">No past RSVPs</p>
                </div>
              ) : (
                pastRsvps.map((rsvp) => (
                  <Card key={rsvp.id} className="opacity-75" data-testid={`card-past-rsvp-${rsvp.id}`}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <Badge variant="secondary" data-testid={`badge-past-status-${rsvp.id}`}>
                              Completed
                            </Badge>
                            <Badge variant="outline" data-testid={`badge-past-free-${rsvp.id}`}>
                              Free Event
                            </Badge>
                          </div>
                          <CardTitle 
                            className="text-xl mb-1 cursor-pointer hover:text-primary transition-colors"
                            onClick={() => handleViewEvent(rsvp.event.id)}
                            data-testid={`text-past-event-title-${rsvp.id}`}
                          >
                            {rsvp.event.title}
                          </CardTitle>
                          <CardDescription data-testid={`text-past-event-category-${rsvp.id}`}>
                            {rsvp.event.category}
                          </CardDescription>
                        </div>
                        {rsvp.event.imageUrl && (
                          <img
                            src={rsvp.event.imageUrl}
                            alt={rsvp.event.title}
                            className="w-24 h-24 rounded-md object-cover"
                            data-testid={`img-past-event-${rsvp.id}`}
                          />
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-2">
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground" data-testid={`text-past-event-date-${rsvp.id}`}>
                          <CalendarIcon className="h-4 w-4" />
                          <span>
                            {format(new Date(rsvp.event.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground" data-testid={`text-past-event-location-${rsvp.id}`}>
                          <MapPin className="h-4 w-4" />
                          <span>{rsvp.event.location}</span>
                        </div>
                      </div>

                      <Button
                        variant="outline"
                        className="w-full mt-4"
                        onClick={() => handleViewEvent(rsvp.event.id)}
                        data-testid={`button-view-past-event-${rsvp.id}`}
                      >
                        View Event
                      </Button>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>
          </Tabs>
        )}
      </main>

      <BottomNavigation />
    </div>
  );
}
