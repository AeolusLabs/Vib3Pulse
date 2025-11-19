import { useState } from "react";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import CreateEventModal from "@/components/CreateEventModal";
import UserProfileCard from "@/components/UserProfileCard";
import EventCard from "@/components/EventCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';
import artGallery from '@assets/generated_images/Art_gallery_opening_8b389604.png';
import charityRun from '@assets/generated_images/Charity_run_event_5c615e65.png';

//todo: remove mock functionality
const userEvents = [
  {
    id: '4',
    title: 'Sunrise Yoga in the Park',
    image: yogaEvent,
    date: 'Jul 20',
    location: 'Riverside Park, Portland',
    organizer: { name: 'Sarah Johnson', avatar: '' },
    price: 'free' as const,
    rsvpCount: 67
  },
  {
    id: '5',
    title: 'Contemporary Art Gallery Opening',
    image: artGallery,
    date: 'Aug 15',
    location: 'Modern Art Space, LA',
    organizer: { name: 'Sarah Johnson', avatar: '' },
    price: 25 as const,
    rsvpCount: 123
  }
];

//todo: remove mock functionality
const rsvpEvents = [
  {
    id: '6',
    title: 'Charity 5K Run for Education',
    image: charityRun,
    date: 'Oct 1',
    location: 'City Center, Chicago',
    organizer: { name: 'Community Champions', avatar: '' },
    price: 30 as const,
    rsvpCount: 389
  }
];

//todo: remove mock functionality
const following = [
  { id: '1', name: 'Alex Martinez', username: 'alexm', avatar: '', isOrganizer: false },
  { id: '2', name: 'Live Events Co', username: 'liveevents', avatar: '', isOrganizer: true },
  { id: '3', name: 'Maria Chen', username: 'mariachen', avatar: '', isOrganizer: false },
  { id: '4', name: 'TechForward', username: 'techforward', avatar: '', isOrganizer: true },
];

export default function ProfilePage() {
  const [createEventOpen, setCreateEventOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation
        userType="organizer"
        onCreateEvent={() => setCreateEventOpen(true)}
      />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <UserProfileCard
            name="Sarah Johnson"
            username="sarahj_events"
            bio="Event organizer passionate about wellness and community building. Creating memorable experiences that bring people together and inspire positive change."
            coverImage={yogaEvent}
            followersCount={1247}
            followingCount={389}
            isFollowing={false}
          />
        </div>

        <Tabs defaultValue="events" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="events" data-testid="tab-events">
              Events Created
            </TabsTrigger>
            <TabsTrigger value="rsvps" data-testid="tab-rsvps">
              RSVPs
            </TabsTrigger>
            <TabsTrigger value="following" data-testid="tab-following">
              Following
            </TabsTrigger>
          </TabsList>

          <TabsContent value="events">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {userEvents.map((event) => (
                <EventCard
                  key={event.id}
                  {...event}
                  onClick={() => console.log('Navigate to event:', event.id)}
                />
              ))}
            </div>
            {userEvents.length === 0 && (
              <div className="text-center py-16">
                <p className="text-muted-foreground">No events created yet</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="rsvps">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {rsvpEvents.map((event) => (
                <EventCard
                  key={event.id}
                  {...event}
                  onClick={() => console.log('Navigate to event:', event.id)}
                />
              ))}
            </div>
            {rsvpEvents.length === 0 && (
              <div className="text-center py-16">
                <p className="text-muted-foreground">No RSVPs yet</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="following">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {following.map((user) => (
                <Card key={user.id} className="hover-elevate cursor-pointer" data-testid={`card-user-${user.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-12 w-12">
                        <AvatarImage src={user.avatar} alt={user.name} />
                        <AvatarFallback>
                          {user.name.split(' ').map(n => n[0]).join('')}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate" data-testid="text-user-name">
                          {user.name}
                        </p>
                        <p className="text-sm text-muted-foreground truncate" data-testid="text-username">
                          @{user.username}
                        </p>
                        {user.isOrganizer && (
                          <p className="text-xs text-primary">Event Organizer</p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            {following.length === 0 && (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Not following anyone yet</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <CreateEventModal
        open={createEventOpen}
        onClose={() => setCreateEventOpen(false)}
      />

      <BottomNavigation onCreateClick={() => setCreateEventOpen(true)} />
    </div>
  );
}
