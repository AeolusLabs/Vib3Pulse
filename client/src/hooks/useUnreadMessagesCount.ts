import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";

export function useUnreadMessagesCount() {
  const { data: user } = useAuth();
  return useQuery<number>({
    queryKey: ["/api/messages/unread-count"],
    queryFn: async () => {
      const response = await fetch("/api/messages/unread-count", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch unread message count");
      const data = await response.json();
      return data.count;
    },
    enabled: !!user,
    staleTime: 15000,
    refetchInterval: !!user ? 30000 : false,
  });
}

