import UserProfileCard from '../UserProfileCard';
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';

export default function UserProfileCardExample() {
  return (
    <div className="max-w-2xl p-6">
      <UserProfileCard
        name="Sarah Johnson"
        username="sarahj_events"
        bio="Event organizer passionate about wellness and community building. Creating memorable experiences across the city."
        coverImage={yogaEvent}
        followersCount={1247}
        followingCount={389}
        isFollowing={false}
        onFollowToggle={(following) => console.log('Follow toggled:', following)}
      />
    </div>
  );
}
