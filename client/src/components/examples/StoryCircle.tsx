import StoryCircle from '../StoryCircle';

export default function StoryCircleExample() {
  return (
    <div className="flex gap-4 p-6 bg-background">
      <StoryCircle
        username="Your Story"
        isOwn={true}
        onClick={() => console.log('Create story')}
      />
      <StoryCircle
        username="Live Events"
        hasStory={true}
        isViewed={false}
        onClick={() => console.log('View story')}
      />
      <StoryCircle
        username="Sarah J"
        hasStory={true}
        isViewed={true}
        onClick={() => console.log('View story')}
      />
      <StoryCircle
        username="TechForward"
        hasStory={true}
        isViewed={false}
        onClick={() => console.log('View story')}
      />
    </div>
  );
}
