import StoriesBar from '../StoriesBar';

const mockStories = [
  { id: '1', username: 'Live Events Co', isViewed: false },
  { id: '2', username: 'Sarah Johnson', isViewed: true },
  { id: '3', username: 'TechForward', isViewed: false },
  { id: '4', username: 'Wellness Warriors', isViewed: false },
  { id: '5', username: 'Art Collective', isViewed: true },
];

export default function StoriesBarExample() {
  return (
    <StoriesBar
      stories={mockStories}
      onStoryClick={(id) => console.log('View story:', id)}
      onCreateStory={() => console.log('Create story')}
    />
  );
}
