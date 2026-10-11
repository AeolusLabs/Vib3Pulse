import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useVenueReviews } from "@/hooks/use-venue-social";

/** 5-to-1 star bars from the ratings endpoint's `distribution` map. */
export function RatingBreakdown({
  average,
  total,
  distribution,
}: {
  average: number | null | undefined;
  total: number;
  distribution?: Record<number, number>;
}) {
  if (!average || total === 0) return null;
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-5 items-center mb-2" data-testid="rating-breakdown">
      <div className="text-center">
        <b className="block font-serif text-5xl leading-none font-bold">{average.toFixed(1)}</b>
        <span className="text-xs text-muted-foreground">{total} {total === 1 ? "rating" : "ratings"}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {[5, 4, 3, 2, 1].map((star) => {
          const n = distribution?.[star] ?? 0;
          return (
            <div key={star} className="grid grid-cols-[12px_1fr] gap-2 items-center text-xs text-muted-foreground">
              <span className="tabular-nums">{star}</span>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden" role="img" aria-label={`${n} ${star}-star ratings`}>
                <div className="h-full rounded-full bg-primary" style={{ width: `${(n / total) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Written reviews. Only people who checked in to a past night can rate, so each one is a verified attendee. */
export function VenueReviewList({ venueId }: { venueId: string }) {
  const { data: reviews = [] } = useVenueReviews(venueId);
  if (reviews.length === 0) return null;
  return (
    <ul className="list-none p-0 m-0 mb-4" data-testid="list-venue-reviews">
      {reviews.map((r) => {
        const name = r.user.displayName || r.user.username;
        return (
          <li key={r.id} className="border-t py-3.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5">
              <Link href={`/profile/${r.user.username}`}>
                <Avatar className="h-8 w-8">
                  <AvatarImage src={r.user.avatarUrl || ""} alt={name} />
                  <AvatarFallback className="text-xs font-semibold">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
              </Link>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-sm font-semibold truncate">{name}</p>
                <p className="text-xs text-muted-foreground">
                  Attended · {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                </p>
              </div>
              <span className="text-primary tracking-[2px] text-sm" aria-label={`${r.rating} out of 5`}>
                {"★".repeat(r.rating)}
              </span>
            </div>
            <p className="text-[15px] text-muted-foreground break-words">{r.reviewText}</p>
          </li>
        );
      })}
    </ul>
  );
}
