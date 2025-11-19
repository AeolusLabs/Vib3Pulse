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
import { Calendar, MapPin, Users } from "lucide-react";
import { format } from "date-fns";
import type { Event } from "@shared/schema";

export default function DiscoverPage() {
  const [selectedCategory, setSelectedCategory] = useState("All Events");
  const [searchQuery, setSearchQuery] = useState("");
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const { data: events = [], isLoading } = useQuery<Event[]>({
    queryKey: ["/api/events"],
  });

  const filteredEvents = events.filter(event => {
    const matchesCategory = selectedCategory === "All Events" || event.category === selectedCategory;
    const matchesSearch = event.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         event.location.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation
        userType="organizer"
        onSearch={setSearchQuery}
        onCreateEvent={() => setCreateEventOpen(true)}
      />
      <HeroSection onSearch={setSearchQuery} onCategoryClick={setSelectedCategory} />
      
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <FilterBar
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          onSortChange={(sort) => console.log('Sort changed:', sort)}
        />

        {isLoading ? (
          <div className="text-center py-16">
            <p className="text-muted-foreground">Loading events...</p>
          </div>
        ) : (
          <>
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
