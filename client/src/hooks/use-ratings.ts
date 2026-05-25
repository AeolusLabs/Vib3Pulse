import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";

export interface EventRatingStats {
  eventId: string;
  averageRating: number | null;
  totalRatings: number;
  distribution: Record<number, number>;
}

export interface UserEventRating {
  hasRated: boolean;
  rating?: number;
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
  return useQuery<UserEventRating>({
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

export function useSubmitRating(eventId: string, organizerId?: string) {
  return useMutation({
    mutationFn: async (rating: number) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/ratings`, { rating });
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
