import StoryCreator from "./StoryCreator";

interface CreateStoryModalProps {
  open: boolean;
  onClose: () => void;
  onCreateStory?: (type: "image" | "text", content: string) => void;
}

export default function CreateStoryModal({ open, onClose, onCreateStory }: CreateStoryModalProps) {
  return <StoryCreator open={open} onClose={onClose} onCreateStory={onCreateStory} />;
}
