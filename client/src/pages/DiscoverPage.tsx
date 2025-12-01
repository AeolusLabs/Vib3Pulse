import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import HeroSection from "@/components/HeroSection";
import FilterBar from "@/components/FilterBar";
import EventDetailsModal from "@/components/EventDetailsModal";
import CreateEventModal from "@/components/CreateEventModal";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Users, Sparkles, Building2, Music } from "lucide-react";
import { format, isPast } from "date-fns";
import { Link } from "wouter";
import type { Event, Venue } from "@shared/schema";

export default function DiscoverPage() {
  const [selectedCategory, setSelectedCategory] = useState("All Events");
  const [searchQuery, setSearchQuery] = useState("");
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const { data: events = [], isLoading } = useQuery<Event[]>({
    queryKey: ["/api/events"],
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  const { data: promotedEvents = [] } = useQuery<Event[]>({
    queryKey: ["/api/events/promoted"],
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  const { data: promotedVenues = [] } = useQuery<Venue[]>({
    queryKey: ["/api/venues/promoted"],
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  const isEventUpcoming = (event: Event) => {
    const eventDate = new Date(event.eventDate);
    return !isPast(eventDate);
  };

  const filteredEvents = events
    .filter(isEventUpcoming)
    .filter(event => {
      const matchesCategory = selectedCategory === "All Events" || event.category === selectedCategory;
      const matchesSearch = event.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           event.location.toLowerCase().includes(searchQuery.toLowerCase());
      const isNotPromoted = !promotedEvents.some(pe => pe.id === event.id);
      return matchesCategory && matchesSearch && isNotPromoted;
    });

  const filteredPromotedEvents = promotedEvents
    .filter(isEventUpcoming)
    .filter(event => {
      const matchesCategory = selectedCategory === "All Events" || event.category === selectedCategory;
      const matchesSearch = event.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           event.location.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation
        onSearch={setSearchQuery}
        onCreateEvent={() => setCreateEventOpen(true)}
      />
      <HeroSection onSearch={setSearchQuery} onCategoryClick={setSelectedCategory} />
      
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-4">
          <FilterBar
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
            onSortChange={(sort) => console.log('Sort changed:', sort)}
          />
        </div>

        {isLoading ? (
          <div className="text-center py-16">
            <p className="text-muted-foreground">Loading events...</p>
          </div>
        ) : (
          <>
            {filteredPromotedEvents.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="h-5 w-5 text-purple-500" />
                  <h2 className="text-xl font-semibold">Featured Events</h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="featured-events-grid">
                  {filteredPromotedEvents.map((event) => (
                    <Card 
                      key={event.id} 
                      className="hover-elevate cursor-pointer overflow-hidden border-2 border-purple-300 bg-gradient-to-br from-purple-50/50 to-pink-50/50 dark:from-purple-950/20 dark:to-pink-950/20"
                      onClick={() => setSelectedEvent(event)}
                      data-testid={`featured-event-card-${event.id}`}
                    >
                      {event.imageUrl && (
                        <div className="aspect-video w-full overflow-hidden relative">
                          <img 
                            src={event.imageUrl} 
                            alt={event.title}
                            className="w-full h-full object-cover"
                          />
                          <Badge className="absolute top-2 right-2 bg-gradient-to-r from-purple-500 to-pink-500 text-white">
                            <Sparkles className="h-3 w-3 mr-1" />
                            Featured
                          </Badge>
                        </div>
                      )}
                      <CardHeader className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-semibold text-lg line-clamp-2">
                            {event.title}
                          </h3>
                          <Badge variant="secondary">
                            {event.category}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Calendar className="h-4 w-4" />
                          <span>
                            {format(new Date(event.eventDate), "MMM d, yyyy 'at' h:mm a")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <MapPin className="h-4 w-4" />
                          <span className="line-clamp-1">
                            {event.location}
                          </span>
                        </div>
                      </CardContent>
                      <CardFooter className="flex items-center justify-between gap-2">
                        {event.ticketPrice === 0 ? (
                          <Badge variant="default" className="text-base">
                            Free
                          </Badge>
                        ) : (
                          <span className="font-semibold text-lg">
                            ${(event.ticketPrice / 100).toFixed(2)}
                          </span>
                        )}
                        <Button 
                          size="sm" 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedEvent(event);
                          }}
                        >
                          View Details
                        </Button>
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {promotedVenues.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Building2 className="h-5 w-5 text-purple-500" />
                  <h2 className="text-xl font-semibold">Featured Venues</h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" data-testid="featured-venues-grid">
                  {promotedVenues.map((venue) => (
                    <Link key={venue.id} href={`/venue/${venue.id}`}>
                      <Card 
                        className="hover-elevate cursor-pointer overflow-hidden border-2 border-purple-300 bg-gradient-to-br from-purple-50/50 to-pink-50/50 dark:from-purple-950/20 dark:to-pink-950/20"
                        data-testid={`featured-venue-card-${venue.id}`}
                      >
                        {(venue.coverImageUrl || venue.imageUrl) && (
                          <div className="aspect-video w-full overflow-hidden relative">
                            <img 
                              src={venue.coverImageUrl || venue.imageUrl || ""}
                              alt={venue.name}
                              className="w-full h-full object-cover"
                            />
                            <Badge className="absolute top-2 right-2 bg-gradient-to-r from-purple-500 to-pink-500 text-white">
                              <Sparkles className="h-3 w-3 mr-1" />
                              Featured
                            </Badge>
                          </div>
                        )}
                        <CardHeader className="space-y-1 pb-2">
                          <h3 className="font-semibold text-base line-clamp-1" data-testid={`venue-name-${venue.id}`}>
                            {venue.name}
                          </h3>
                          <Badge variant="secondary" className="w-fit text-xs">
                            {venue.category}
                          </Badge>
                        </CardHeader>
                        <CardContent className="space-y-1 pb-3">
                          {venue.city && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <MapPin className="h-3 w-3" />
                              <span className="line-clamp-1">{venue.city}</span>
                            </div>
                          )}
                          {venue.musicTypes && Array.isArray(venue.musicTypes) && venue.musicTypes.length > 0 && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Music className="h-3 w-3" />
                              <span className="line-clamp-1">{venue.musicTypes.slice(0, 2).join(", ")}</span>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="events-grid">
              {filteredEvents.map((event) => (
                <Card 
                  key={event.id} 
                  className="hover-elevate cursor-pointer overflow-hidden"
                  onClick={() => setSelectedEvent(event)}
                  data-testid={`event-card-${event.id}`}
                >
                  {event.imageUrl && (
                    <div className="aspect-video w-full overflow-hidden">
                      <img 
                        src={event.imageUrl} 
                        alt={event.title}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                  <CardHeader className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-semibold text-lg line-clamp-2" data-testid={`event-title-${event.id}`}>
                        {event.title}
                      </h3>
                      <Badge variant="secondary" data-testid={`event-category-${event.id}`}>
                        {event.category}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Calendar className="h-4 w-4" />
                      <span data-testid={`event-date-${event.id}`}>
                        {format(new Date(event.eventDate), "MMM d, yyyy 'at' h:mm a")}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      <span className="line-clamp-1" data-testid={`event-location-${event.id}`}>
                        {event.location}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Users className="h-4 w-4" />
                      <span>{event.ticketsAvailable} tickets available</span>
                    </div>
                  </CardContent>
                  <CardFooter className="flex items-center justify-between gap-2">
                    {event.ticketPrice === 0 ? (
                      <Badge variant="default" className="text-base" data-testid={`event-price-${event.id}`}>
                        Free
                      </Badge>
                    ) : (
                      <span className="font-semibold text-lg" data-testid={`event-price-${event.id}`}>
                        ${(event.ticketPrice / 100).toFixed(2)}
                      </span>
                    )}
                    <Button 
                      size="sm" 
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedEvent(event);
                      }}
                      data-testid={`button-view-event-${event.id}`}
                    >
                      View Details
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>

            {filteredEvents.length === 0 && (
              <div className="text-center py-16">
                <p className="text-lg text-muted-foreground">No events found</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Try adjusting your filters or search terms
                </p>
              </div>
            )}
          </>
        )}
      </main>

      <BottomNavigation />
      
      <CreateEventModal
        open={createEventOpen}
        onClose={() => setCreateEventOpen(false)}
      />

      {selectedEvent && (
        <EventDetailsModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}
