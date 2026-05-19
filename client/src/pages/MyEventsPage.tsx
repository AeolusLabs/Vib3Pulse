import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import EventCard from "@/components/EventCard";
import CreateEventModal from "@/components/CreateEventModal";
import EventDetailsModal from "@/components/EventDetailsModal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Event } from "@shared/schema";
import { PlusIcon } from "@/components/ui/icons";

export default function MyEventsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const { data: events = [], isLoading } = useQuery<Event[]>({
    queryKey: ["/api/events/my-events"],
  });

  // Fetch RSVP counts (reuse the existing /api/rsvps endpoint — keyed per event)
  const { data: allRsvps = [] } = useQuery<{ eventId: string }[]>({
    queryKey: ["/api/rsvps/all"],
    queryFn: async () => {
      const res = await fetch("/api/rsvps/all", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const rsvpCountFor = (eventId: string) =>
    allRsvps.filter((r) => r.eventId === eventId).length;

  const now = new Date();
  const upcomingEvents = events.filter((e) => new Date(e.eventDate) >= now);
  const pastEvents = events.filter((e) => new Date(e.eventDate) < now);

  const renderGrid = (list: Event[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {list.map((event) => (
        <EventCard
          key={event.id}
          id={event.id}
          title={event.title}
          image={event.imageUrl || ""}
          date={new Date(event.eventDate).toLocaleDateString("en-GB", { month: "short", day: "numeric" })}
          location={event.location}
          organizer={{ name: "You", avatar: "" }}
          price={event.ticketPrice === 0 ? "free" : event.ticketPrice}
          currency={(event as any).currency}
          rsvpCount={rsvpCountFor(event.id)}
          isOwner
          onClick={() => setSelectedEvent(event)}
        />
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-serif font-bold" data-testid="heading-my-events">My Events</h1>
          <Button onClick={() => setCreateOpen(true)} data-testid="button-create-event-page">
            <PlusIcon className="h-4 w-4 mr-2" />
            Create Event
          </Button>
        </div>

        <Tabs defaultValue="upcoming" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2 mb-8">
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">Past</TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading events…</p>
              </div>
            ) : upcomingEvents.length === 0 ? (
              <div className="text-center py-16 space-y-4">
                <p className="text-muted-foreground">No upcoming events</p>
                <Button variant="outline" onClick={() => setCreateOpen(true)}>
                  <PlusIcon className="h-4 w-4 mr-2" />
                  Create your first event
                </Button>
              </div>
            ) : renderGrid(upcomingEvents)}
          </TabsContent>

          <TabsContent value="past">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading events…</p>
              </div>
            ) : pastEvents.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">No past events</p>
              </div>
            ) : renderGrid(pastEvents)}
          </TabsContent>
        </Tabs>
      </main>

      {/* Create modal */}
      <CreateEventModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {/* Detail / manage modal */}
      {selectedEvent && (
        <EventDetailsModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}

      <BottomNavigation onCreateClick={() => setCreateOpen(true)} />
    </div>
  );
}
