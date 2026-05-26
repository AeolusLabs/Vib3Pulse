import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useEffect } from "react";
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

export function useMessageCountWebSocket() {
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "new_message" || data.type === "message_read") {
          queryClient.invalidateQueries({ queryKey: ["/api/messages/unread-count"] });
        }
      } catch {
        // ignore malformed messages
      }
    };

    return () => ws.close();
  }, []);
}
