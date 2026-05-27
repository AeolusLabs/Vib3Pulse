import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import HeroSection from "@/components/HeroSection";
import FilterBar from "@/components/FilterBar";
import EventDetailsModal from "@/components/EventDetailsModal";
import CreateEventModal from "@/components/CreateEventModal";
import UnifiedShareModal, { type ShareData } from "@/components/UnifiedShareModal";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { format, isPast } from "date-fns";
import { Link, useSearch } from "wouter";
import { useGeolocation } from "@/hooks/useGeolocation";
import type { Event, Venue } from "@shared/schema";
import { CalendarIcon, MapPinIcon, UsersIcon, SparklesIcon, Building2Icon, MusicIcon, ClockIcon, TrendingUpIcon, Navigation2Icon, Loader2Icon, XCircleIcon, RefreshCwIcon, Share2Icon, TicketIcon } from "@/components/ui/icons";

interface EventWithDistance extends Event {
  distance?: number | null;
  minPrice?: number;
  maxPrice?: number;
}

interface VenueWithDistance extends Venue {
  distance?: number | null;
}

export default function DiscoverPage() {
  const [selectedCategory, setSelectedCategory] = useState("All Events");
  const [searchQuery, setSearchQuery] = useState("");
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [activeShareData, setActiveShareData] = useState<ShareData | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  
  // Parse query parameters for shared event/venue
  const searchString = useSearch();
  const urlParams = new URLSearchParams(searchString);
  const sharedEventId = urlParams.get("event");
  const sharedVenueId = urlParams.get("venue");

  const handleShareEvent = (event: Event, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveShareData({
      type: "event",
      id: event.id,
      title: event.title,
      imageUrl: event.imageUrl,
    });
  };

  const handleShareVenue = (venue: Venue, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveShareData({
      type: "venue",
      id: venue.id,
      name: venue.name,
      imageUrl: (venue as any).coverImageUrl || venue.imageUrl,
    });
  };

  const { 
    latitude, 
    longitude, 
    city, 
    loading: locationLoading, 
    error: locationError,
    permissionStatus,
    requestLocation,
    clearLocation,
    hasLocation,
    formatDistance 
  } = useGeolocation();

  // Request location on mount if not already granted
  useEffect(() => {
    if (permissionStatus === "prompt" || permissionStatus === "unknown") {
      // Don't auto-request, let user click the button
    }
  }, [permissionStatus]);

  // Scroll to and highlight shared event/venue when loaded from URL params
  // Prioritize venue if both exist (edge case), but typically only one should be present
  useEffect(() => {
    // Determine which param to use - prefer venue for venue links, event for event links
    // If somehow both exist, venue takes precedence (arbitrary but consistent)
    let targetId: string | null = null;
    let type: "event" | "venue" | null = null;
    
    if (sharedVenueId) {
      targetId = sharedVenueId;
      type = "venue";
    } else if (sharedEventId) {
      targetId = sharedEventId;
      type = "event";
    }
    
    if (!targetId || !type) return;

    // Try different possible element IDs
    const possibleIds = type === "event" 
      ? [`event-card-${targetId}`, `featured-event-card-${targetId}`]
      : [`featured-venue-card-${targetId}`, `venue-card-${targetId}`];
    
    // Set highlight state (also used for auto-clearing after 5s)
    setHighlightedId(targetId);
    
    // Retry finding and scrolling to element (content might take time to load)
    let attempts = 0;
    const maxAttempts = 20;
    let highlightTimeoutId: ReturnType<typeof setTimeout> | null = null;
    
    const tryScroll = () => {
      for (const elementId of possibleIds) {
        const element = document.querySelector(`[data-testid="${elementId}"]`);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
          return true;
        }
      }
      return false;
    };
    
    const scrollInterval = setInterval(() => {
      attempts++;
      if (tryScroll()) {
        clearInterval(scrollInterval);
        // Only start the removal timer AFTER element is found
        highlightTimeoutId = setTimeout(() => setHighlightedId(null), 5000);
      } else if (attempts >= maxAttempts) {
        clearInterval(scrollInterval);
        // Also clear highlight if element never found
        setHighlightedId(null);
      }
    }, 300);

    return () => {
      clearInterval(scrollInterval);
      if (highlightTimeoutId) {
        clearTimeout(highlightTimeoutId);
      }
    };
  }, [sharedEventId, sharedVenueId]);

  // Standard events query
  const { data: events = [], isLoading } = useQuery<Event[]>({
    queryKey: ["/api/events"],
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  // Nearby events (when location available)
  const { data: nearbyEvents = [] } = useQuery<EventWithDistance[]>({
    queryKey: ["/api/events/nearby", latitude, longitude],
    queryFn: async () => {
      if (!latitude || !longitude) return [];
      const response = await fetch(`/api/events/nearby?lat=${latitude}&lon=${longitude}`);
      if (!response.ok) return [];
      return response.json();
    },
    enabled: hasLocation,
    refetchInterval: 60000,
  });

  // Happening now events (when location available)
  const { data: happeningNowEvents = [] } = useQuery<EventWithDistance[]>({
    queryKey: ["/api/events/happening-now", latitude, longitude],
    queryFn: async () => {
      if (!latitude || !longitude) return [];
      const response = await fetch(`/api/events/happening-now?lat=${latitude}&lon=${longitude}&hours=3`);
      if (!response.ok) return [];
      return response.json();
    },
    enabled: hasLocation,
    refetchInterval: 60000,
  });

  // Trending in city events (when city detected)
  const { data: trendingEvents = [] } = useQuery<Event[]>({
    queryKey: ["/api/events/trending-in-city", city],
    queryFn: async () => {
      if (!city) return [];
      const response = await fetch(`/api/events/trending-in-city?city=${encodeURIComponent(city)}`);
      if (!response.ok) return [];
      return response.json();
    },
    enabled: !!city,
    refetchInterval: 60000,
  });

  const { data: promotedEvents = [] } = useQuery<Event[]>({
    queryKey: ["/api/events/promoted"],
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  const { data: promotedVenues = [] } = useQuery<VenueWithDistance[]>({
    queryKey: ["/api/venues/promoted"],
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  const { data: allVenues = [] } = useQuery<Venue[]>({
    queryKey: ["/api/venues"],
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  const { data: upcomingVenueEvents = [] } = useQuery<Array<any>>({
    queryKey: ["/api/venue-events/upcoming"],
    queryFn: async () => {
      const res = await fetch("/api/venue-events/upcoming");
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  });

  // Nearby venues (when location available)
  const { data: nearbyVenues = [] } = useQuery<VenueWithDistance[]>({
    queryKey: ["/api/venues/nearby", latitude, longitude],
    queryFn: async () => {
      if (!latitude || !longitude) return [];
      const response = await fetch(`/api/venues/nearby?lat=${latitude}&lon=${longitude}&maxDistance=50`);
      if (!response.ok) return [];
      return response.json();
    },
    enabled: hasLocation,
    refetchInterval: 60000,
  });

  const isEventUpcoming = (event: Event) => {
    const eventDate = new Date(event.eventDate);
    return !isPast(eventDate);
  };

  // Use nearby events if location available, otherwise regular events
  const baseEvents = hasLocation && nearbyEvents.length > 0 ? nearbyEvents : events;

  const filteredEvents = baseEvents
    .filter(isEventUpcoming)
    .filter(event => {
      const matchesCategory = selectedCategory === "All Events" || event.category === selectedCategory;
      const q = searchQuery.toLowerCase();
      const matchesSearch = event.title.toLowerCase().includes(q) ||
                           event.location.toLowerCase().includes(q) ||
                           (event.category ?? "").toLowerCase().includes(q) ||
                           (event.description ?? "").toLowerCase().includes(q);
      const isNotPromoted = !promotedEvents.some(pe => pe.id === event.id);
      return matchesCategory && matchesSearch && isNotPromoted;
    });

  const filteredPromotedEvents = promotedEvents
    .filter(isEventUpcoming)
    .filter(event => {
      const matchesCategory = selectedCategory === "All Events" || event.category === selectedCategory;
      const q = searchQuery.toLowerCase();
      const matchesSearch = event.title.toLowerCase().includes(q) ||
                           event.location.toLowerCase().includes(q) ||
                           (event.category ?? "").toLowerCase().includes(q) ||
                           (event.description ?? "").toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });

  // Filter promoted venues - prefer nearby if available
  const displayVenues = hasLocation && nearbyVenues.length > 0 
    ? nearbyVenues.filter(v => promotedVenues.some(pv => pv.id === v.id))
    : promotedVenues;

  const renderDistanceBadge = (distance: number | null | undefined) => {
    if (distance === null || distance === undefined) return null;
    return (
      <Badge variant="outline" className="text-xs bg-purple-50 dark:bg-purple-950/30 border-purple-200">
        <Navigation2Icon className="h-3 w-3 mr-1" />
        {formatDistance(distance)}
      </Badge>
    );
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={setSearchQuery} />
      <HeroSection onSearch={setSearchQuery} onCategoryClick={setSelectedCategory} />
      
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Location Banner - Prompt state */}
        {!hasLocation && permissionStatus !== "denied" && (
          <div className="mb-6 p-4 rounded-lg bg-gradient-to-r from-purple-100 to-pink-100 dark:from-purple-950/40 dark:to-pink-950/40 border border-purple-200 dark:border-purple-800">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-purple-200 dark:bg-purple-800">
                  <MapPinIcon className="h-5 w-5 text-purple-600 dark:text-purple-300" />
                </div>
                <div>
                  <p className="font-medium text-sm">Enable Location</p>
                  <p className="text-xs text-muted-foreground">See events and venues near you</p>
                </div>
              </div>
              <Button 
                size="sm" 
                onClick={requestLocation}
                disabled={locationLoading}
                data-testid="button-enable-location"
              >
                {locationLoading ? (
                  <>
                    <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
                    Getting location...
                  </>
                ) : (
                  <>
                    <Navigation2Icon className="h-4 w-4 mr-2" />
                    Enable Location
                  </>
                )}
              </Button>
            </div>
            {locationError && (
              <p className="text-xs text-destructive mt-2">{locationError}</p>
            )}
          </div>
        )}

        {/* Location Banner - Denied state */}
        {permissionStatus === "denied" && (
          <div className="mb-6 p-4 rounded-lg bg-gradient-to-r from-amber-100 to-orange-100 dark:from-amber-950/40 dark:to-orange-950/40 border border-amber-300 dark:border-amber-800">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-amber-200 dark:bg-amber-800">
                  <XCircleIcon className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                </div>
                <div>
                  <p className="font-medium text-sm">Location Access Denied</p>
                  <p className="text-xs text-muted-foreground">
                    To see nearby events, please enable location in your browser settings and refresh the page.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={clearLocation}
                  data-testid="button-clear-location"
                >
                  <RefreshCwIcon className="h-4 w-4 mr-2" />
                  Reset & Try Again
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Location Active Badge */}
        {hasLocation && city && (
          <div className="mb-4 flex items-center gap-2">
            <Badge variant="outline" className="bg-green-50 dark:bg-green-950/30 border-green-300 text-green-700 dark:text-green-400">
              <Navigation2Icon className="h-3 w-3 mr-1" />
              Showing events near {city}
            </Badge>
          </div>
        )}

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
            {/* Happening Near Me Now Section */}
            {hasLocation && happeningNowEvents.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <ClockIcon className="h-5 w-5 text-orange-500" />
                  <h2 className="text-xl font-semibold">Happening Near You Now</h2>
                  <Badge variant="secondary" className="text-xs">Within 3 hours</Badge>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="happening-now-grid">
                  {happeningNowEvents.slice(0, 3).map((event) => (
                    <Card 
                      key={event.id} 
                      className="hover-elevate cursor-pointer overflow-hidden border-2 border-orange-300 bg-gradient-to-br from-orange-50/50 to-yellow-50/50 dark:from-orange-950/20 dark:to-yellow-950/20"
                      onClick={() => setSelectedEvent(event)}
                      data-testid={`happening-now-card-${event.id}`}
                    >
                      {event.imageUrl && (
                        <div className="aspect-video w-full overflow-hidden relative">
                          <img 
                            src={event.imageUrl} 
                            alt={event.title}
                            className="w-full h-full object-cover"
                          />
                          <Badge className="absolute top-2 right-2 bg-gradient-to-r from-orange-500 to-yellow-500 text-white">
                            <ClockIcon className="h-3 w-3 mr-1" />
                            Soon
                          </Badge>
                        </div>
                      )}
                      <CardHeader className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-semibold text-lg line-clamp-2">
                            {event.title}
                          </h3>
                          {renderDistanceBadge(event.distance)}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <CalendarIcon className="h-4 w-4" />
                          <span>
                            {format(new Date(event.eventDate), "h:mm a 'today'")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <MapPinIcon className="h-4 w-4" />
                          <span className="line-clamp-1">{event.location}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Trending in Your City Section */}
            {city && trendingEvents.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUpIcon className="h-5 w-5 text-blue-500" />
                  <h2 className="text-xl font-semibold">Trending in {city}</h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="trending-city-grid">
                  {trendingEvents.filter(isEventUpcoming).slice(0, 3).map((event) => (
                    <Card 
                      key={event.id} 
                      className="hover-elevate cursor-pointer overflow-hidden border-2 border-blue-300 bg-gradient-to-br from-blue-50/50 to-cyan-50/50 dark:from-blue-950/20 dark:to-cyan-950/20"
                      onClick={() => setSelectedEvent(event)}
                      data-testid={`trending-card-${event.id}`}
                    >
                      {event.imageUrl && (
                        <div className="aspect-video w-full overflow-hidden relative">
                          <img 
                            src={event.imageUrl} 
                            alt={event.title}
                            className="w-full h-full object-cover"
                          />
                          <Badge className="absolute top-2 right-2 bg-gradient-to-r from-blue-500 to-cyan-500 text-white">
                            <TrendingUpIcon className="h-3 w-3 mr-1" />
                            Trending
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
                          <CalendarIcon className="h-4 w-4" />
                          <span>
                            {format(new Date(event.eventDate), "MMM d, yyyy 'at' h:mm a")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <MapPinIcon className="h-4 w-4" />
                          <span className="line-clamp-1">{event.location}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Featured Events */}
            {filteredPromotedEvents.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <SparklesIcon className="h-5 w-5 text-purple-500" />
                  <h2 className="text-xl font-semibold">Featured Events</h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="featured-events-grid">
                  {filteredPromotedEvents.map((event) => {
                    const isFeaturedEventHighlighted = sharedEventId === String(event.id) || highlightedId === String(event.id);
                    return (
                    <Card 
                      key={event.id} 
                      className={`hover-elevate cursor-pointer overflow-hidden border-2 border-purple-300 bg-gradient-to-br from-purple-50/50 to-pink-50/50 dark:from-purple-950/20 dark:to-pink-950/20 transition-all duration-500 ${isFeaturedEventHighlighted ? 'ring-4 ring-primary ring-offset-2 scale-[1.02]' : ''}`}
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
                            <SparklesIcon className="h-3 w-3 mr-1" />
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
                          <CalendarIcon className="h-4 w-4" />
                          <span>
                            {format(new Date(event.eventDate), "MMM d, yyyy 'at' h:mm a")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <MapPinIcon className="h-4 w-4" />
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
                            {(() => {
                              const eventWithPrices = event as EventWithDistance;
                              const minPrice = eventWithPrices.minPrice ?? event.ticketPrice;
                              const maxPrice = eventWithPrices.maxPrice ?? event.ticketPrice;
                              if (minPrice === maxPrice) {
                                return `£${(minPrice / 100).toFixed(2)}`;
                              }
                              return `£${(minPrice / 100).toFixed(2)} - £${(maxPrice / 100).toFixed(2)}`;
                            })()}
                          </span>
                        )}
                        <div className="flex items-center gap-2">
                          <Button 
                            size="icon"
                            variant="ghost"
                            onClick={(e) => handleShareEvent(event, e)}
                            data-testid={`button-share-featured-event-${event.id}`}
                          >
                            <Share2Icon className="h-4 w-4" />
                          </Button>
                          <Button 
                            size="sm" 
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedEvent(event);
                            }}
                          >
                            View Details
                          </Button>
                        </div>
                      </CardFooter>
                    </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Featured Venues */}
            {displayVenues.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Building2Icon className="h-5 w-5 text-purple-500" />
                  <h2 className="text-xl font-semibold">Featured Venues</h2>
                  {hasLocation && (
                    <Badge variant="outline" className="text-xs">Sorted by distance</Badge>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" data-testid="featured-venues-grid">
                  {displayVenues.map((venue) => {
                    // Use sharedVenueId directly for initial highlight (more reliable than async state)
                    const isHighlighted = sharedVenueId === String(venue.id) || highlightedId === String(venue.id);
                    return (
                    <Link key={venue.id} href={`/venue/${venue.id}`}>
                      <Card 
                        className={`hover-elevate cursor-pointer overflow-hidden border-2 border-purple-300 bg-gradient-to-br from-purple-50/50 to-pink-50/50 dark:from-purple-950/20 dark:to-pink-950/20 transition-all duration-500 ${isHighlighted ? 'ring-4 ring-primary ring-offset-2 scale-[1.02]' : ''}`}
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
                              <SparklesIcon className="h-3 w-3 mr-1" />
                              Featured
                            </Badge>
                          </div>
                        )}
                        <CardHeader className="space-y-1 pb-2">
                          <div className="flex items-start justify-between gap-1">
                            <h3 className="font-semibold text-base line-clamp-1" data-testid={`venue-name-${venue.id}`}>
                              {venue.name}
                            </h3>
                            {renderDistanceBadge((venue as VenueWithDistance).distance)}
                          </div>
                          <Badge variant="secondary" className="w-fit text-xs">
                            {venue.category}
                          </Badge>
                        </CardHeader>
                        <CardContent className="space-y-1 pb-2">
                          {venue.city && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <MapPinIcon className="h-3 w-3" />
                              <span className="line-clamp-1">{venue.city}</span>
                            </div>
                          )}
                          {venue.musicTypes && Array.isArray(venue.musicTypes) && venue.musicTypes.length > 0 && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <MusicIcon className="h-3 w-3" />
                              <span className="line-clamp-1">{venue.musicTypes.slice(0, 2).join(", ")}</span>
                            </div>
                          )}
                        </CardContent>
                        <CardFooter className="pt-0 pb-3 flex justify-end">
                          <Button 
                            size="icon"
                            variant="ghost"
                            onClick={(e) => handleShareVenue(venue, e)}
                            data-testid={`button-share-venue-${venue.id}`}
                          >
                            <Share2Icon className="h-4 w-4" />
                          </Button>
                        </CardFooter>
                      </Card>
                    </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Upcoming Events (regular + venue events combined, sorted by date) */}
            {(filteredEvents.length > 0 || upcomingVenueEvents.length > 0) && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <TicketIcon className="h-5 w-5 text-purple-500" />
                  <h2 className="text-xl font-semibold">Upcoming Events</h2>
                  <span className="text-sm text-muted-foreground">
                    ({filteredEvents.length + upcomingVenueEvents.length})
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="upcoming-events-grid">
                  {[
                    ...filteredEvents.map(e => ({ kind: 'event' as const, date: new Date(e.eventDate), data: e })),
                    ...upcomingVenueEvents.map((e: any) => ({ kind: 'venueEvent' as const, date: new Date(e.date), data: e })),
                  ]
                    .sort((a, b) => a.date.getTime() - b.date.getTime())
                    .map((item) => {
                      if (item.kind === 'event') {
                        const event = item.data;
                        const isEventHighlighted = sharedEventId === String(event.id) || highlightedId === String(event.id);
                        return (
                          <Card
                            key={`event-${event.id}`}
                            className={`hover-elevate cursor-pointer overflow-hidden transition-all duration-500 ${isEventHighlighted ? 'ring-4 ring-primary ring-offset-2 scale-[1.02]' : ''}`}
                            onClick={() => setSelectedEvent(event)}
                            data-testid={`upcoming-event-card-${event.id}`}
                          >
                            {event.imageUrl && (
                              <div className="aspect-video w-full overflow-hidden">
                                <img src={event.imageUrl} alt={event.title} className="w-full h-full object-cover" />
                              </div>
                            )}
                            <CardHeader className="space-y-1 pb-2">
                              <div className="flex items-start justify-between gap-2">
                                <h3 className="font-semibold text-base line-clamp-2">{event.title}</h3>
                                <Badge variant="secondary" className="text-xs">{event.category}</Badge>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-1 pb-3">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <CalendarIcon className="h-3 w-3" />
                                <span>{format(new Date(event.eventDate), "EEE, MMM d 'at' h:mm a")}</span>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <MapPinIcon className="h-3 w-3" />
                                <span className="line-clamp-1">{event.location}</span>
                              </div>
                              <div className="flex items-center justify-between pt-1">
                                {event.ticketPrice === 0 ? (
                                  <Badge variant="default" className="text-sm">Free</Badge>
                                ) : (
                                  <span className="font-semibold text-sm">
                                    £{(event.ticketPrice / 100).toFixed(2)}
                                  </span>
                                )}
                                <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); handleShareEvent(event, e); }}>
                                  <Share2Icon className="h-3 w-3" />
                                </Button>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      } else {
                        const event = item.data;
                        const imgSrc = event.imageUrl || event.venue?.coverImageUrl || event.venue?.imageUrl;
                        return (
                          <Link key={`ve-${event.id}`} href={`/venue-events/${event.id}`}>
                            <Card className="hover-elevate cursor-pointer overflow-hidden transition-all duration-200" data-testid={`venue-event-card-${event.id}`}>
                              {imgSrc ? (
                                <div className="aspect-video w-full overflow-hidden relative">
                                  <img src={imgSrc} alt={event.name} className="w-full h-full object-cover" />
                                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                                </div>
                              ) : (
                                <div className="aspect-video w-full bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-950/30 dark:to-pink-950/30 flex items-center justify-center">
                                  <TicketIcon className="h-10 w-10 text-purple-300" />
                                </div>
                              )}
                              <CardHeader className="space-y-1 pb-2">
                                <h3 className="font-semibold text-base line-clamp-1">{event.name}</h3>
                                {event.venue?.name && (
                                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                                    <Building2Icon className="h-3 w-3" />{event.venue.name}
                                  </p>
                                )}
                              </CardHeader>
                              <CardContent className="space-y-1 pb-3">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <CalendarIcon className="h-3 w-3" />
                                  <span>{format(new Date(event.date), "EEE, MMM d 'at' h:mm a")}</span>
                                </div>
                                {(event.venue?.address || event.venue?.city) && (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <MapPinIcon className="h-3 w-3" />
                                    <span className="line-clamp-1">{event.venue.address || event.venue.city}</span>
                                  </div>
                                )}
                                <div className="flex items-center justify-between pt-1">
                                  <span className="font-semibold text-sm">£{(event.coverPriceCents / 100).toFixed(2)}</span>
                                  {event.capacity && (
                                    <span className="text-xs text-muted-foreground">{event.capacity - event.ticketsSold} left</span>
                                  )}
                                </div>
                              </CardContent>
                            </Card>
                          </Link>
                        );
                      }
                    })}
                </div>
              </div>
            )}

            {/* All Events (sorted by proximity if location available) */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-4">
                <CalendarIcon className="h-5 w-5 text-muted-foreground" />
                <h2 className="text-xl font-semibold">
                  {hasLocation ? "Events Near You" : "All Events"}
                </h2>
                {hasLocation && (
                  <Badge variant="outline" className="text-xs">Sorted by distance</Badge>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="events-grid">
              {filteredEvents.map((event) => {
                const isEventHighlighted = sharedEventId === String(event.id) || highlightedId === String(event.id);
                return (
                <Card
                  key={event.id}
                  className={`hover-elevate cursor-pointer overflow-hidden transition-all duration-500 ${isEventHighlighted ? 'ring-4 ring-primary ring-offset-2 scale-[1.02]' : ''}`}
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
                    {hasLocation && (event as EventWithDistance).distance !== undefined && (
                      <div className="flex items-center">
                        {renderDistanceBadge((event as EventWithDistance).distance)}
                      </div>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CalendarIcon className="h-4 w-4" />
                      <span data-testid={`event-date-${event.id}`}>
                        {format(new Date(event.eventDate), "MMM d, yyyy 'at' h:mm a")}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPinIcon className="h-4 w-4" />
                      <span className="line-clamp-1" data-testid={`event-location-${event.id}`}>
                        {event.location}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <UsersIcon className="h-4 w-4" />
                      <span>{event.ticketsAvailable} tickets available</span>
                    </div>
                  </CardContent>
                  <CardFooter className="flex items-center justify-between gap-2">
                    {event.externalTicketUrl ? (
                      <Badge variant="default" className="bg-blue-500 text-base" data-testid={`event-price-${event.id}`}>
                        External
                      </Badge>
                    ) : event.ticketPrice === 0 ? (
                      <Badge variant="default" className="text-base" data-testid={`event-price-${event.id}`}>
                        Free
                      </Badge>
                    ) : (
                      <span className="font-semibold text-lg" data-testid={`event-price-${event.id}`}>
                        {(() => {
                          const eventWithPrices = event as EventWithDistance;
                          const minPrice = eventWithPrices.minPrice ?? event.ticketPrice;
                          const maxPrice = eventWithPrices.maxPrice ?? event.ticketPrice;
                          if (minPrice === maxPrice) {
                            return `£${(minPrice / 100).toFixed(2)}`;
                          }
                          return `£${(minPrice / 100).toFixed(2)} - £${(maxPrice / 100).toFixed(2)}`;
                        })()}
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={(e) => handleShareEvent(event, e)}
                        data-testid={`button-share-event-${event.id}`}
                      >
                        <Share2Icon className="h-4 w-4" />
                      </Button>
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
                    </div>
                  </CardFooter>
                </Card>
                );
              })}
            </div>

            {filteredEvents.length === 0 && (
              <div className="text-center py-16">
                <p className="text-lg text-muted-foreground">No events found</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Try adjusting your filters or search terms
                </p>
              </div>
            )}

            {/* All Venues */}
            {allVenues.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Building2Icon className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-xl font-semibold">All Venues</h2>
                  <span className="text-sm text-muted-foreground">({allVenues.length})</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" data-testid="all-venues-grid">
                  {allVenues.map((venue) => {
                    const isHighlighted = sharedVenueId === String(venue.id) || highlightedId === String(venue.id);
                    return (
                      <Link key={venue.id} href={`/venue/${venue.id}`}>
                        <Card
                          className={`hover-elevate cursor-pointer overflow-hidden transition-all duration-500 ${isHighlighted ? 'ring-4 ring-primary ring-offset-2 scale-[1.02]' : ''}`}
                          data-testid={`venue-card-${venue.id}`}
                        >
                          {(venue.coverImageUrl || venue.imageUrl) ? (
                            <div className="aspect-video w-full overflow-hidden relative">
                              <img
                                src={venue.coverImageUrl || venue.imageUrl || ""}
                                alt={venue.name}
                                className="w-full h-full object-cover"
                              />
                            </div>
                          ) : (
                            <div className="aspect-video w-full bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-950/30 dark:to-pink-950/30 flex items-center justify-center">
                              <Building2Icon className="h-10 w-10 text-purple-300" />
                            </div>
                          )}
                          <CardHeader className="space-y-1 pb-2">
                            <div className="flex items-start justify-between gap-1">
                              <h3 className="font-semibold text-base line-clamp-1" data-testid={`all-venue-name-${venue.id}`}>
                                {venue.name}
                              </h3>
                            </div>
                            <Badge variant="secondary" className="w-fit text-xs">
                              {venue.category}
                            </Badge>
                          </CardHeader>
                          <CardContent className="space-y-1 pb-3">
                            {venue.city && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <MapPinIcon className="h-3 w-3" />
                                <span className="line-clamp-1">{venue.city}</span>
                              </div>
                            )}
                            {venue.musicTypes && Array.isArray(venue.musicTypes) && venue.musicTypes.length > 0 && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <MusicIcon className="h-3 w-3" />
                                <span className="line-clamp-1">{venue.musicTypes.slice(0, 2).join(", ")}</span>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
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

      {activeShareData && (
        <UnifiedShareModal
          open={!!activeShareData}
          onClose={() => setActiveShareData(null)}
          shareData={activeShareData}
        />
      )}
    </div>
  );
}
