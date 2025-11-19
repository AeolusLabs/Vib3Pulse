import { useState } from "react";
import Navigation from "@/components/Navigation";
import HeroSection from "@/components/HeroSection";
import FilterBar from "@/components/FilterBar";
import EventCard from "@/components/EventCard";
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';
import foodTasting from '@assets/generated_images/Food_and_wine_tasting_69928d9e.png';
import techConf from '@assets/generated_images/Tech_conference_presentation_2bcf2c35.png';
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';
import artGallery from '@assets/generated_images/Art_gallery_opening_8b389604.png';
import charityRun from '@assets/generated_images/Charity_run_event_5c615e65.png';

//todo: remove mock functionality
const mockEvents = [
  {
    id: '1',
    title: 'Summer Music Festival 2025',
    image: musicFestival,
    date: 'Jul 15',
    location: 'Central Park, New York',
    organizer: { name: 'Live Events Co', avatar: '' },
    price: 45 as const,
    rsvpCount: 234,
    category: 'Music'
  },
  {
    id: '2',
    title: 'Food & Wine Tasting Experience',
    image: foodTasting,
    date: 'Aug 3',
    location: 'Downtown Venue, SF',
    organizer: { name: 'Culinary Arts Group', avatar: '' },
    price: 'free' as const,
    rsvpCount: 89,
    category: 'Food & Drink'
  },
  {
    id: '3',
    title: 'Tech Innovation Summit 2025',
    image: techConf,
    date: 'Sep 12',
    location: 'Convention Center, Austin',
    organizer: { name: 'TechForward', avatar: '' },
    price: 129 as const,
    rsvpCount: 456,
    category: 'Tech'
  },
  {
    id: '4',
    title: 'Sunrise Yoga in the Park',
    image: yogaEvent,
    date: 'Jul 20',
    location: 'Riverside Park, Portland',
    organizer: { name: 'Wellness Warriors', avatar: '' },
    price: 'free' as const,
    rsvpCount: 67,
    category: 'Wellness'
  },
  {
    id: '5',
    title: 'Contemporary Art Gallery Opening',
    image: artGallery,
    date: 'Aug 15',
    location: 'Modern Art Space, LA',
    organizer: { name: 'Art Collective LA', avatar: '' },
    price: 25 as const,
    rsvpCount: 123,
    category: 'Arts'
  },
  {
    id: '6',
    title: 'Charity 5K Run for Education',
    image: charityRun,
    date: 'Oct 1',
    location: 'City Center, Chicago',
    organizer: { name: 'Community Champions', avatar: '' },
    price: 30 as const,
    rsvpCount: 389,
    category: 'Sports'
  },
];

export default function DiscoverPage() {
  const [selectedCategory, setSelectedCategory] = useState("All Events");
  const [searchQuery, setSearchQuery] = useState("");

  //todo: remove mock functionality - replace with real filtering
  const filteredEvents = mockEvents.filter(event => {
    const matchesCategory = selectedCategory === "All Events" || event.category === selectedCategory;
    const matchesSearch = event.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         event.location.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-background">
      <Navigation userType="organizer" onSearch={setSearchQuery} />
      <HeroSection onSearch={setSearchQuery} onCategoryClick={setSelectedCategory} />
      
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <FilterBar
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          onSortChange={(sort) => console.log('Sort changed:', sort)}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredEvents.map((event) => (
            <EventCard
              key={event.id}
              {...event}
              onClick={() => console.log('Navigate to event:', event.id)}
            />
          ))}
        </div>

        {filteredEvents.length === 0 && (
          <div className="text-center py-16">
            <p className="text-muted-foreground text-lg">No events found. Try adjusting your filters.</p>
          </div>
        )}
      </main>
    </div>
  );
}
