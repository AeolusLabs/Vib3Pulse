import { useState } from "react";
import { X, Image as ImageIcon, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface CreateStoryModalProps {
  open: boolean;
  onClose: () => void;
  onCreateStory?: (type: "image" | "text", content: string) => void;
}

const colorOptions = [
  { name: "Purple", value: "hsl(262 80% 87%)" },
  { name: "Blue", value: "hsl(220 100% 84%)" },
  { name: "Green", value: "hsl(127 63% 49%)" },
  { name: "Pink", value: "hsl(340 70% 60%)" },
  { name: "Orange", value: "hsl(30 70% 60%)" },
];

export default function CreateStoryModal({ open, onClose, onCreateStory }: CreateStoryModalProps) {
  const [textContent, setTextContent] = useState("");
  const [selectedColor, setSelectedColor] = useState(colorOptions[0].value);

  const handleCreateText = () => {
    if (textContent.trim()) {
      onCreateStory?.("text", textContent);
      console.log('Created text story:', textContent, 'color:', selectedColor);
      setTextContent("");
      onClose();
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        onCreateStory?.("image", reader.result as string);
        console.log('Created image story');
        onClose();
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">Create Your Story</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="text" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="text" data-testid="tab-text-story">
              <Type className="h-4 w-4 mr-2" />
              Text
            </TabsTrigger>
            <TabsTrigger value="image" data-testid="tab-image-story">
              <ImageIcon className="h-4 w-4 mr-2" />
              Image
            </TabsTrigger>
          </TabsList>

          <TabsContent value="text" className="space-y-4">
            <div
              className="w-full h-64 rounded-md flex items-center justify-center p-6"
              style={{ backgroundColor: selectedColor }}
            >
              <p className="text-xl font-serif font-semibold text-center text-primary-foreground">
                {textContent || "Your text will appear here..."}
              </p>
            </div>

            <Textarea
              placeholder="What's on your mind?"
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              className="resize-none"
              rows={3}
              data-testid="textarea-story-content"
            />

            <div>
              <p className="text-sm font-semibold mb-2">Background Color</p>
              <div className="flex gap-2">
                {colorOptions.map((color) => (
                  <button
                    key={color.value}
                    className={`w-10 h-10 rounded-full border-2 ${
                      selectedColor === color.value ? "border-primary" : "border-transparent"
                    }`}
                    style={{ backgroundColor: color.value }}
                    onClick={() => setSelectedColor(color.value)}
                    data-testid={`button-color-${color.name.toLowerCase()}`}
                  />
                ))}
              </div>
            </div>

            <Button
              onClick={handleCreateText}
              className="w-full"
              disabled={!textContent.trim()}
              data-testid="button-post-text-story"
            >
              Post Story
            </Button>
          </TabsContent>

          <TabsContent value="image" className="space-y-4">
            <div className="border-2 border-dashed rounded-md p-8 text-center">
              <ImageIcon className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-4">
                Upload an image for your story
              </p>
              <label htmlFor="story-image-upload">
                <Button variant="outline" asChild data-testid="button-upload-image">
                  <span>Choose Image</span>
                </Button>
              </label>
              <input
                id="story-image-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageUpload}
              />
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
