import { useState, useEffect } from "react";
import { X, ChevronLeft, ChevronRight, Heart, Send } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

interface StorySlide {
  id: string;
  type: "image" | "text";
  content: string;
  backgroundColor?: string;
  timestamp: string;
}

interface StoryViewerProps {
  username: string;
  avatar?: string;
  slides: StorySlide[];
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
}

export default function StoryViewer({
  username,
  avatar,
  slides,
  onClose,
  onNext,
  onPrevious,
}: StoryViewerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [replyText, setReplyText] = useState("");

  const SLIDE_DURATION = 5000;

  useEffect(() => {
    if (isPaused) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        const newProgress = prev + (100 / SLIDE_DURATION) * 100;
        if (newProgress >= 100) {
          if (currentSlide < slides.length - 1) {
            setCurrentSlide((curr) => curr + 1);
            return 0;
          } else {
            onNext?.();
            return 100;
          }
        }
        return newProgress;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [currentSlide, slides.length, isPaused, onNext]);

  const handlePrevious = () => {
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
      setProgress(0);
    } else {
      onPrevious?.();
    }
  };

  const handleNext = () => {
    if (currentSlide < slides.length - 1) {
      setCurrentSlide(currentSlide + 1);
      setProgress(0);
    } else {
      onNext?.();
    }
  };

  const handleReply = () => {
    console.log('Reply sent:', replyText);
    setReplyText("");
  };

  const currentStory = slides[currentSlide];

  return (
    <div className="fixed inset-0 bg-background z-50 flex items-center justify-center">
      <div className="relative w-full h-full max-w-md mx-auto bg-card">
        {/* Progress bars */}
        <div className="absolute top-0 left-0 right-0 z-20 flex gap-1 p-2">
          {slides.map((_, index) => (
            <div key={index} className="flex-1 h-0.5 bg-background/30 rounded-full overflow-hidden">
              <Progress
                value={index === currentSlide ? progress : index < currentSlide ? 100 : 0}
                className="h-full"
              />
            </div>
          ))}
        </div>

        {/* Header */}
        <div className="absolute top-0 left-0 right-0 z-20 pt-6 px-4 pb-8 bg-gradient-to-b from-background/80 to-transparent">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Avatar className="h-10 w-10 border-2 border-background">
                <AvatarImage src={avatar} alt={username} />
                <AvatarFallback>
                  {username.split(' ').map(n => n[0]).join('')}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-semibold text-sm text-card-foreground" data-testid="text-story-username">
                  {username}
                </p>
                <p className="text-xs text-muted-foreground">{currentStory.timestamp}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="text-card-foreground hover:bg-background/20"
              data-testid="button-close-story"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Story content */}
        <div
          className="h-full flex items-center justify-center cursor-pointer"
          onMouseDown={() => setIsPaused(true)}
          onMouseUp={() => setIsPaused(false)}
          onTouchStart={() => setIsPaused(true)}
          onTouchEnd={() => setIsPaused(false)}
        >
          {currentStory.type === "image" ? (
            <img
              src={currentStory.content}
              alt="Story"
              className="w-full h-full object-cover"
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center p-8"
              style={{ backgroundColor: currentStory.backgroundColor || "hsl(var(--primary))" }}
            >
              <p className="text-2xl font-serif font-semibold text-center text-primary-foreground">
                {currentStory.content}
              </p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="absolute inset-0 z-10 flex">
          <button
            className="flex-1 cursor-pointer"
            onClick={handlePrevious}
            data-testid="button-previous-story"
          />
          <button
            className="flex-1 cursor-pointer"
            onClick={handleNext}
            data-testid="button-next-story"
          />
        </div>

        {/* Reply input */}
        <div className="absolute bottom-0 left-0 right-0 z-20 p-4 bg-gradient-to-t from-background/80 to-transparent">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Reply to story..."
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleReply()}
              className="flex-1 bg-background/50 backdrop-blur-sm"
              data-testid="input-story-reply"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => console.log('Like story')}
              className="text-card-foreground hover:bg-background/20"
              data-testid="button-like-story"
            >
              <Heart className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleReply}
              disabled={!replyText}
              className="text-card-foreground hover:bg-background/20"
              data-testid="button-send-reply"
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Navigation arrows for desktop */}
        <div className="hidden md:block">
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20"
            onClick={handlePrevious}
          >
            <ChevronLeft className="h-8 w-8" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-1/2 -translate-y-1/2 z-20"
            onClick={handleNext}
          >
            <ChevronRight className="h-8 w-8" />
          </Button>
        </div>
      </div>
    </div>
  );
}
