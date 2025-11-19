import { Calendar, MapPin, Clock, Share2, Users } from "lucide-react";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import TicketSelector from "@/components/TicketSelector";
import EventCard from "@/components/EventCard";
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';
import foodTasting from '@assets/generated_images/Food_and_wine_tasting_69928d9e.png';
import techConf from '@assets/generated_images/Tech_conference_presentation_2bcf2c35.png';

//todo: remove mock functionality
const mockTicketTiers = [
  {
    id: 'general',
    name: 'General Admission',
    price: 45,
    description: 'Access to main festival grounds and all stages',
    available: 150
  },
  {
    id: 'vip',
    name: 'VIP Package',
    price: 95,
    description: 'Premium viewing areas, exclusive lounge, complimentary drinks',
    available: 25
  },
  {
    id: 'early',
    name: 'Early Bird Special',
    price: 35,
    description: 'Limited early access discount tickets',
    available: 5
  }
];

//todo: remove mock functionality
const similarEvents = [
  {
    id: '2',
    title: 'Food & Wine Tasting Experience',
    image: foodTasting,
    date: 'Aug 3',
    location: 'Downtown Venue, SF',
    organizer: { name: 'Culinary Arts Group', avatar: '' },
    price: 'free' as const,
    rsvpCount: 89
  },
  {
    id: '3',
    title: 'Tech Innovation Summit 2025',
    image: techConf,
    date: 'Sep 12',
    location: 'Convention Center, Austin',
    organizer: { name: 'TechForward', avatar: '' },
    price: 129 as const,
    rsvpCount: 456
  }
];

export default function EventDetailPage() {
  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation userType="social" />

      <div className="relative h-[400px] md:h-[500px] overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/40 to-transparent z-10" />
        <img
          src={musicFestival}
          alt="Event cover"
          className="w-full h-full object-cover"
        />
      </div>

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 -mt-32 relative z-20">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardContent className="p-6 md:p-8">
                <div className="flex flex-wrap gap-2 mb-4">
                  <Badge variant="default" data-testid="badge-category">Music</Badge>
                  <Badge variant="outline" data-testid="badge-status">234 Going</Badge>
                </div>

                <h1 className="font-serif text-3xl md:text-4xl font-bold mb-4" data-testid="text-event-title">
                  Summer Music Festival 2025
                </h1>

                <div className="flex items-center gap-4 mb-6 pb-6 border-b">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src="" alt="Organizer" />
                    <AvatarFallback>LE</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-semibold" data-testid="text-organizer">Live Events Co</p>
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
                        Saturday, July 15, 2025<br />2:00 PM - 11:00 PM
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <MapPin className="h-5 w-5 text-primary mt-0.5" />
                    <div>
                      <p className="font-semibold">Location</p>
                      <p className="text-sm text-muted-foreground" data-testid="text-location">
                        Central Park, New York<br />Great Lawn Area
                      </p>
                    </div>
                  </div>
                </div>

                <div className="prose prose-sm max-w-none">
                  <h3 className="font-serif text-xl font-semibold mb-3">About This Event</h3>
                  <p className="text-foreground" data-testid="text-description">
                    Join us for an unforgettable day of live music featuring top artists from around the world. 
                    Experience multiple stages with diverse genres including rock, pop, electronic, and indie music. 
                    Food trucks, craft vendors, and interactive art installations will be available throughout the venue.
                  </p>
                  <p className="text-foreground">
                    This year's lineup includes headliners and emerging artists, creating a perfect blend of 
                    established talent and fresh sounds. Bring your friends, enjoy the summer vibes, and create 
                    lasting memories at one of the season's most anticipated events.
                  </p>

                  <h4 className="font-sans font-semibold mt-6 mb-2">What to Bring</h4>
                  <ul className="text-foreground">
                    <li>Valid ID for entry</li>
                    <li>Sunscreen and comfortable shoes</li>
                    <li>Reusable water bottle (refill stations available)</li>
                    <li>Light jacket for evening</li>
                  </ul>
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
              tiers={mockTicketTiers}
              onPurchase={(selections) => console.log('Purchase:', selections)}
            />
          </div>
        </div>

        <div className="mt-12 mb-8">
          <h2 className="font-serif text-2xl font-semibold mb-6">Similar Events</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {similarEvents.map((event) => (
              <EventCard
                key={event.id}
                {...event}
                onClick={() => console.log('Navigate to event:', event.id)}
              />
            ))}
          </div>
        </div>
      </main>

      <BottomNavigation onCreateClick={() => console.log('Create clicked')} />
    </div>
  );
}
