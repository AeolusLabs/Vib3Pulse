import { Calendar, MapPin, Share2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { format } from "date-fns";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import TicketSelector from "@/components/TicketSelector";
import EventCard from "@/components/EventCard";
import type { Event, User } from "@shared/schema";
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';

type EventWithOrganizer = Event & { organizer: User };

export default function EventDetailPage() {
  const [match, params] = useRoute("/event/:id");
  const eventId = params?.id;

  const { data: event, isLoading, error } = useQuery<EventWithOrganizer>({
    queryKey: ["/api/events", eventId],
    enabled: !!eventId,
  });

  const { data: similarEvents } = useQuery<Event[]>({
    queryKey: ["/api/events"],
    select: (events) => {
      if (!event) return [];
      return events
        .filter(e => e.category === event.category && e.id !== event.id)
        .slice(0, 3);
    },
    enabled: !!event,
  });

  if (!match || !eventId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Event not found</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <div className="container mx-auto px-4 py-16 text-center">
          <p className="text-muted-foreground">Loading event details...</p>
        </div>
        <BottomNavigation />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <div className="container mx-auto px-4 py-16 text-center">
          <p className="text-destructive">Failed to load event details</p>
        </div>
        <BottomNavigation />
      </div>
    );
  }

  const eventDate = new Date(event.eventDate);
  const formattedDate = format(eventDate, "EEEE, MMMM d, yyyy");
  const formattedTime = format(eventDate, "h:mm a");
  const organizerInitials = event.organizer.username.slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <div className="relative h-[400px] md:h-[500px] overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/40 to-transparent z-10" />
        <img
          src={event.imageUrl || musicFestival}
          alt={event.title}
          className="w-full h-full object-cover"
        />
      </div>

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 -mt-32 relative z-20">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardContent className="p-6 md:p-8">
                <div className="flex flex-wrap gap-2 mb-4">
                  <Badge variant="default" data-testid="badge-category">{event.category}</Badge>
                  {event.requiresRSVP && (
                    <Badge variant="outline" data-testid="badge-rsvp">RSVP Required</Badge>
                  )}
                </div>

                <h1 className="font-serif text-3xl md:text-4xl font-bold mb-4" data-testid="text-event-title">
                  {event.title}
                </h1>

                <div className="flex items-center gap-4 mb-6 pb-6 border-b">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src="" alt={event.organizer.username} />
                    <AvatarFallback>{organizerInitials}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-semibold" data-testid="text-organizer">{event.organizer.username}</p>
                    <p className="text-sm text-muted-foreground">Event Organizer</p>
                  </div>
                  <Button variant="outline" size="sm" className="ml-auto" data-testid="button-follow-organizer">
                    Follow
                  </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                  <div className="flex items-start gap-3">
                    <Calendar className="h-5 w-5 text-primary mt-0.5" />
                    <div>
                      <p className="font-semibold">Date & Time</p>
                      <p className="text-sm text-muted-foreground" data-testid="text-date">
                        {formattedDate}<br />{formattedTime}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <MapPin className="h-5 w-5 text-primary mt-0.5" />
                    <div>
                      <p className="font-semibold">Location</p>
                      <p className="text-sm text-muted-foreground" data-testid="text-location">
                        {event.location}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="prose prose-sm max-w-none">
                  <h3 className="font-serif text-xl font-semibold mb-3">About This Event</h3>
                  <p className="text-foreground whitespace-pre-wrap" data-testid="text-description">
                    {event.description}
                  </p>
                </div>

                <div className="flex gap-2 mt-6 pt-6 border-t">
                  <Button variant="outline" size="default" data-testid="button-share">
                    <Share2 className="h-4 w-4 mr-2" />
                    Share Event
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-1">
            <TicketSelector
              tiers={[]}
              onPurchase={(selections) => console.log('Purchase:', selections)}
            />
          </div>
        </div>

        {similarEvents && similarEvents.length > 0 && (
          <div className="mt-12 mb-8">
            <h2 className="font-serif text-2xl font-semibold mb-6">Similar Events</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {similarEvents.map((similarEvent) => (
                <EventCard
                  key={similarEvent.id}
                  id={similarEvent.id}
                  title={similarEvent.title}
                  image={similarEvent.imageUrl || musicFestival}
                  date={format(new Date(similarEvent.eventDate), "MMM d")}
                  location={similarEvent.location}
                  organizer={{ name: similarEvent.organizerId, avatar: '' }}
                  price={similarEvent.ticketPrice === 0 ? 'free' as const : similarEvent.ticketPrice}
                  rsvpCount={0}
                  onClick={() => window.location.href = `/event/${similarEvent.id}`}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      <BottomNavigation />
    </div>
  );
}
