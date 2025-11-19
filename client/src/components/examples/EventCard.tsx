import EventCard from '../EventCard';
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';
import foodTasting from '@assets/generated_images/Food_and_wine_tasting_69928d9e.png';

export default function EventCardExample() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-6">
      <EventCard
        id="1"
        title="Summer Music Festival 2025"
        image={musicFestival}
        date="Jul 15"
        location="Central Park, New York"
        organizer={{ name: "Live Events Co", avatar: "" }}
        price={45}
        rsvpCount={234}
        onClick={() => console.log('Event clicked')}
      />
      <EventCard
        id="2"
        title="Food & Wine Tasting Experience"
        image={foodTasting}
        date="Aug 3"
        location="Downtown Venue, SF"
        organizer={{ name: "Culinary Arts Group", avatar: "" }}
        price="free"
        rsvpCount={89}
        onClick={() => console.log('Event clicked')}
      />
    </div>
  );
}
