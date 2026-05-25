import { useState } from "react";
import { Star } from "lucide-react";
import { useSubmitRating } from "@/hooks/use-ratings";

interface RatingInputProps {
  eventId: string;
  organizerId?: string;
  onSuccess?: () => void;
}

export default function RatingInput({ eventId, organizerId, onSuccess }: RatingInputProps) {
  const [hovered, setHovered] = useState(0);
  const [selected, setSelected] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const submitRating = useSubmitRating(eventId, organizerId);

  if (submitted) {
    return (
      <p className="text-sm text-green-500 font-medium">Thanks for rating!</p>
    );
  }

  const handleClick = (star: number) => {
    setSelected(star);
    submitRating.mutate(star, {
      onSuccess: () => {
        setSubmitted(true);
        onSuccess?.();
      },
      onError: () => {
        setSelected(0);
      },
    });
  };

  const activeStar = hovered || selected;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">Rate this event</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            disabled={submitRating.isPending}
            onClick={() => handleClick(star)}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(0)}
            className="transition-transform hover:scale-110 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={`Rate ${star} star${star !== 1 ? "s" : ""}`}
          >
            <Star
              className={`w-7 h-7 transition-colors ${
                star <= activeStar
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-muted-foreground"
              }`}
            />
          </button>
        ))}
      </div>
      {submitRating.isError && (
        <p className="text-xs text-destructive">
          {submitRating.error?.message ?? "Failed to submit rating"}
        </p>
      )}
    </div>
  );
}
