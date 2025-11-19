import FeedPost from '../FeedPost';
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';

export default function FeedPostExample() {
  return (
    <div className="p-6 max-w-2xl space-y-4">
      <FeedPost
        id="1"
        author={{
          name: "Live Events Co",
          username: "liveeventsco",
          isOrganizer: true
        }}
        content="🎵 Excited to announce our Summer Music Festival lineup! Get your tickets now before they sell out. This is going to be epic! #MusicFestival #LiveMusic"
        image={musicFestival}
        timestamp="2h ago"
        likes={234}
        comments={45}
        isLiked={false}
      />

      <FeedPost
        id="2"
        author={{
          name: "Sarah Johnson",
          username: "sarahj"
        }}
        content="Just got my tickets for the yoga retreat next month! Can't wait to disconnect and recharge 🧘‍♀️✨"
        timestamp="5h ago"
        likes={89}
        comments={12}
        isLiked={true}
      />
    </div>
  );
}
