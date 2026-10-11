import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";

export interface PublicPerson {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface NightSocialProof {
  going: number;
  friendsCount: number;
  friends: PublicPerson[];
}

export interface VenueReview {
  id: string;
  rating: number;
  reviewText: string;
  createdAt: string;
  user: PublicPerson;
}

/** Going counts per upcoming night; "friends" (mutual follows) is only filled when logged in. */
export function useVenueSocialProof(venueId: string | undefined) {
  const { data: user } = useAuth();
  return useQuery<Record<string, NightSocialProof>>({
    // Keyed by viewer so logging in or out never shows the other state's friend list.
    queryKey: ["venue-social-proof", venueId, user?.id ?? "anon"],
    queryFn: async () => {
      const res = await fetch(`/api/venues/${venueId}/social-proof`, { credentials: "include" });
      if (!res.ok) return {};
      return (await res.json()).nights ?? {};
    },
    enabled: !!venueId,
    staleTime: 30_000,
  });
}

export function useVenueReviews(venueId: string | undefined, limit = 5) {
  return useQuery<VenueReview[]>({
    queryKey: ["venue-reviews", venueId, limit],
    queryFn: async () => {
      const res = await fetch(`/api/venues/${venueId}/reviews?limit=${limit}`, { credentials: "include" });
      if (!res.ok) return [];
      return (await res.json()).reviews ?? [];
    },
    enabled: !!venueId,
    staleTime: 60_000,
  });
}
