import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

const savedKey = (venueId: string) => ["/api/venues", venueId, "saved"] as const;

export function useIsVenueSaved(venueId: string | undefined) {
  const { data: user } = useAuth();
  const query = useQuery<{ saved: boolean }>({
    queryKey: savedKey(venueId ?? ""),
    enabled: !!venueId && !!user,
  });
  return { saved: query.data?.saved ?? false, isLoading: query.isLoading };
}

// Optimistic toggle. Logged-out users are sent to /login instead of hitting the API.
export function useToggleSaveVenue(venueId: string) {
  const { data: user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const mutation = useMutation({
    mutationFn: async (nextSaved: boolean) => {
      await apiRequest(nextSaved ? "PUT" : "DELETE", `/api/venues/${venueId}/save`);
    },
    onMutate: async (nextSaved) => {
      await queryClient.cancelQueries({ queryKey: savedKey(venueId) });
      const previous = queryClient.getQueryData<{ saved: boolean }>(savedKey(venueId));
      queryClient.setQueryData(savedKey(venueId), { saved: nextSaved });
      return { previous };
    },
    onError: (_err, nextSaved, ctx) => {
      queryClient.setQueryData(savedKey(venueId), ctx?.previous ?? { saved: !nextSaved });
      toast({ title: nextSaved ? "Couldn't save venue" : "Couldn't remove venue", description: "Please try again.", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: savedKey(venueId) });
      queryClient.invalidateQueries({ queryKey: ["/api/saved-venues"] });
    },
  });

  const { saved } = useIsVenueSaved(venueId);

  return {
    isPending: mutation.isPending,
    toggle: () => {
      if (!user) {
        toast({ title: "Log in to save venues" });
        navigate(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      mutation.mutate(!saved);
    },
  };
}
