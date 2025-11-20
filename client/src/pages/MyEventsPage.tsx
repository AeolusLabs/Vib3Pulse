import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import EventCard from "@/components/EventCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState } from "react";
import CreateStoryModal from "@/components/CreateStoryModal";
import { useQuery } from "@tanstack/react-query";
import type { Event } from "@shared/schema";
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';

export default function MyEventsPage() {
  const [createStoryOpen, setCreateStoryOpen] = useState(false);

  const { data: events = [], isLoading } = useQuery<Event[]>({
    queryKey: ["/api/events/my-events"],
  });

  const now = new Date();
  const upcomingEvents = events.filter(event => new Date(event.eventDate) >= now);
  const pastEvents = events.filter(event => new Date(event.eventDate) < now);

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-serif font-bold mb-6" data-testid="heading-my-events">My Events</h1>

        <Tabs defaultValue="upcoming" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2 mb-8">
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">Past</TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading events...</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {upcomingEvents.map((event) => (
                    <EventCard
                      key={event.id}
                      id={event.id}
                      title={event.title}
                      image={event.imageUrl || yogaEvent}
                      date={new Date(event.eventDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      location={event.location}
                      organizer={{ name: 'You', avatar: '' }}
                      price={event.ticketPrice === 0 ? 'free' as const : event.ticketPrice}
                      rsvpCount={0}
                      onClick={() => console.log('Navigate to event:', event.id)}
                    />
                  ))}
                </div>
                {upcomingEvents.length === 0 && (
                  <div className="text-center py-16">
                    <p className="text-muted-foreground">No upcoming events</p>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="past">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading events...</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {pastEvents.map((event) => (
                    <EventCard
                      key={event.id}
                      id={event.id}
                      title={event.title}
                      image={event.imageUrl || yogaEvent}
                      date={new Date(event.eventDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      location={event.location}
                      organizer={{ name: 'You', avatar: '' }}
                      price={event.ticketPrice === 0 ? 'free' as const : event.ticketPrice}
                      rsvpCount={0}
                      onClick={() => console.log('Navigate to event:', event.id)}
                    />
                  ))}
                </div>
                {pastEvents.length === 0 && (
                  <div className="text-center py-16">
                    <p className="text-muted-foreground">No past events</p>
                  </div>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <CreateStoryModal
        open={createStoryOpen}
        onClose={() => setCreateStoryOpen(false)}
        onCreateStory={(type, content) => console.log('Story created:', type, content)}
      />

      <BottomNavigation onCreateClick={() => setCreateStoryOpen(true)} />
    </div>
  );
}
