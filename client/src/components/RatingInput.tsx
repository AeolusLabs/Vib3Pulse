import { useState } from "react";
import { Star } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface RatingInputProps {
  label?: string;
  initialRating?: number;
  initialReviewText?: string | null;
  submitLabel?: string;
  isPending?: boolean;
  errorMessage?: string | null;
  onSubmit: (rating: number, reviewText?: string) => void;
  onCancel?: () => void;
}

// Pure presentational — the caller owns the mutation (useSubmitRating for
// events, useSubmitVenueRating for venues), so this one component covers
// both "rate for the first time" and "edit your existing rating".
export default function RatingInput({
  label = "Rate this",
  initialRating = 0,
  initialReviewText,
  submitLabel = "Submit rating",
  isPending = false,
  errorMessage,
  onSubmit,
  onCancel,
}: RatingInputProps) {
  const [hovered, setHovered] = useState(0);
  const [selected, setSelected] = useState(initialRating);
  const [reviewText, setReviewText] = useState(initialReviewText ?? "");

  const activeStar = hovered || selected;

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            disabled={isPending}
            onClick={() => setSelected(star)}
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

      <Textarea
        value={reviewText}
        onChange={(e) => setReviewText(e.target.value)}
        placeholder="Share your experience (optional)"
        rows={3}
        maxLength={500}
        className="text-sm resize-none"
        disabled={isPending}
        data-testid="input-review-text"
      />

      {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={selected === 0 || isPending}
          onClick={() => onSubmit(selected, reviewText.trim() || undefined)}
          data-testid="button-submit-rating"
        >
          {isPending ? "Submitting…" : submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
