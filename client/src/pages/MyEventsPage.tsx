import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import EventCard from "@/components/EventCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState } from "react";
import CreateStoryModal from "@/components/CreateStoryModal";
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';
import artGallery from '@assets/generated_images/Art_gallery_opening_8b389604.png';
import charityRun from '@assets/generated_images/Charity_run_event_5c615e65.png';
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';

//todo: remove mock functionality
const upcomingEvents = [
  {
    id: '1',
    title: 'Summer Music Festival 2025',
    image: musicFestival,
    date: 'Jul 15',
    location: 'Golden Gate Park, SF',
    organizer: { name: 'Live Events Co', avatar: '' },
    price: 45 as const,
    rsvpCount: 234
  },
  {
    id: '4',
    title: 'Sunrise Yoga in the Park',
    image: yogaEvent,
    date: 'Jul 20',
    location: 'Riverside Park, Portland',
    organizer: { name: 'Sarah Johnson', avatar: '' },
    price: 'free' as const,
    rsvpCount: 67
  }
];

//todo: remove mock functionality
const pastEvents = [
  {
    id: '5',
    title: 'Contemporary Art Gallery Opening',
    image: artGallery,
    date: 'Jun 15',
    location: 'Modern Art Space, LA',
    organizer: { name: 'Art Collective', avatar: '' },
    price: 25 as const,
    rsvpCount: 123
  },
  {
    id: '6',
    title: 'Charity 5K Run for Education',
    image: charityRun,
    date: 'May 1',
    location: 'City Center, Chicago',
    organizer: { name: 'Community Champions', avatar: '' },
    price: 30 as const,
    rsvpCount: 389
  }
];

export default function MyEventsPage() {
  const [createStoryOpen, setCreateStoryOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation userType="social" onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-serif font-bold mb-6" data-testid="heading-my-events">My Events</h1>

        <Tabs defaultValue="upcoming" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2 mb-8">
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">Past</TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {upcomingEvents.map((event) => (
                <EventCard
                  key={event.id}
                  {...event}
                  onClick={() => console.log('Navigate to event:', event.id)}
                />
              ))}
            </div>
            {upcomingEvents.length === 0 && (
              <div className="text-center py-16">
                <p className="text-muted-foreground">No upcoming events</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="past">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {pastEvents.map((event) => (
                <EventCard
                  key={event.id}
                  {...event}
                  onClick={() => console.log('Navigate to event:', event.id)}
                />
              ))}
            </div>
            {pastEvents.length === 0 && (
              <div className="text-center py-16">
                <p className="text-muted-foreground">No past events</p>
              </div>
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
