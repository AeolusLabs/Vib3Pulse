import StoryViewer from '../StoryViewer';
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';
import techConf from '@assets/generated_images/Tech_conference_presentation_2bcf2c35.png';

const mockSlides = [
  {
    id: '1',
    type: 'image' as const,
    content: musicFestival,
    timestamp: '2h ago'
  },
  {
    id: '2',
    type: 'text' as const,
    content: 'Join us this Saturday for an unforgettable experience! 🎵',
    backgroundColor: 'hsl(262 80% 87%)',
    timestamp: '2h ago'
  },
  {
    id: '3',
    type: 'image' as const,
    content: techConf,
    timestamp: '2h ago'
  }
];

export default function StoryViewerExample() {
  return (
    <StoryViewer
      username="Live Events Co"
      slides={mockSlides}
      onClose={() => console.log('Close story')}
      onNext={() => console.log('Next story')}
      onPrevious={() => console.log('Previous story')}
    />
  );
}
