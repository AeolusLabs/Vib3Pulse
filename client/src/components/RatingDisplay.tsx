import { Star } from "lucide-react";

interface RatingDisplayProps {
  averageRating: number | null | undefined;
  totalRatings: number;
  size?: "sm" | "md";
}

export default function RatingDisplay({ averageRating, totalRatings, size = "md" }: RatingDisplayProps) {
  const isSmall = size === "sm";

  if (!averageRating || totalRatings === 0) {
    return (
      <span className={`text-muted-foreground ${isSmall ? "text-xs" : "text-sm"}`}>
        Not rated yet
      </span>
    );
  }

  return (
    <span className={`flex items-center gap-1 ${isSmall ? "text-xs" : "text-sm"}`}>
      <Star className={`fill-yellow-400 text-yellow-400 ${isSmall ? "w-3 h-3" : "w-4 h-4"}`} />
      <span className="font-medium text-foreground">{averageRating.toFixed(1)}</span>
      <span className="text-muted-foreground">({totalRatings})</span>
    </span>
  );
}
