import CreateStoryModal from '../CreateStoryModal';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export default function CreateStoryModalExample() {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-6">
      <Button onClick={() => setOpen(true)}>Open Create Story</Button>
      <CreateStoryModal
        open={open}
        onClose={() => setOpen(false)}
        onCreateStory={(type, content) => console.log('Story created:', type, content)}
      />
    </div>
  );
}
