import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";

export interface RatingStats {
  averageRating: number | null;
  totalRatings: number;
  distribution: Record<number, number>;
}

export interface EventRatingStats extends RatingStats {
  eventId: string;
}

export interface VenueRatingStats extends RatingStats {
  venueId: string;
}

export interface UserRating {
  hasRated: boolean;
  rating?: number;
  reviewText?: string | null;
  ratedAt?: string;
}

export interface OrganizerRating {
  organizerId: string;
  averageRating: number | null;
  totalRatings: number;
  eventsRated: number;
}

export function useEventRatings(eventId: string | undefined) {
  return useQuery<EventRatingStats>({
    queryKey: ["event-ratings", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/ratings`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch event ratings");
      return res.json();
    },
    enabled: !!eventId,
    staleTime: 60000,
  });
}

export function useUserEventRating(eventId: string | undefined) {
  return useQuery<UserRating>({
    queryKey: ["user-event-rating", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/user-rating`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch user rating");
      return res.json();
    },
    enabled: !!eventId,
    staleTime: 60000,
  });
}

export function useOrganizerRating(organizerId: string | undefined) {
  return useQuery<OrganizerRating>({
    queryKey: ["organizer-rating", organizerId],
    queryFn: async () => {
      const res = await fetch(`/api/organizers/${organizerId}/rating`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch organizer rating");
      return res.json();
    },
    enabled: !!organizerId,
    staleTime: 60000,
  });
}

// Upsert — submitting again updates the caller's existing rating rather than
// being rejected, so this also covers "edit your rating".
export function useSubmitRating(eventId: string, organizerId?: string) {
  return useMutation({
    mutationFn: async ({ rating, reviewText }: { rating: number; reviewText?: string }) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/ratings`, { rating, reviewText });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event-ratings", eventId] });
      queryClient.invalidateQueries({ queryKey: ["user-event-rating", eventId] });
      if (organizerId) {
        queryClient.invalidateQueries({ queryKey: ["organizer-rating", organizerId] });
      }
    },
  });
}

export function useVenueRatings(venueId: string | undefined) {
  return useQuery<VenueRatingStats>({
    queryKey: ["venue-ratings", venueId],
    queryFn: async () => {
      const res = await fetch(`/api/venues/${venueId}/ratings`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch venue ratings");
      return res.json();
    },
    enabled: !!venueId,
    staleTime: 60000,
  });
}

export function useUserVenueRating(venueId: string | undefined) {
  return useQuery<UserRating>({
    queryKey: ["user-venue-rating", venueId],
    queryFn: async () => {
      const res = await fetch(`/api/venues/${venueId}/user-rating`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch user rating");
      return res.json();
    },
    enabled: !!venueId,
    staleTime: 60000,
  });
}

export function useSubmitVenueRating(venueId: string) {
  return useMutation({
    mutationFn: async ({ rating, reviewText }: { rating: number; reviewText?: string }) => {
      const res = await apiRequest("POST", `/api/venues/${venueId}/ratings`, { rating, reviewText });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["venue-ratings", venueId] });
      queryClient.invalidateQueries({ queryKey: ["user-venue-rating", venueId] });
    },
  });
}
