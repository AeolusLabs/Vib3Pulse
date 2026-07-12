import { createContext, useContext, useEffect, useRef } from "react";
import { queryClient } from "@/lib/queryClient";

const WebSocketContext = createContext<null>(null);

function buildWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function handleMessage(data: unknown) {
  if (typeof data !== "object" || data === null || !("type" in data)) return;
  const { type } = data as { type: string };

  if (
    type === "new_message" ||
    type === "message_sent" ||
    type === "message_read" ||
    type === "new_conversation_message"
  ) {
    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/messages/unread-count"] });
  }

  if (type === "notification") {
    queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
  }
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryDelayRef = useRef(1000);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    function connect() {
      if (unmountedRef.current) return;

      const ws = new WebSocket(buildWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelayRef.current = 1000;
      };

      ws.onmessage = (event) => {
        try {
          handleMessage(JSON.parse(event.data));
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = (event) => {
        if (unmountedRef.current) return;
        if (event.code === 4001) {
          // Server rejected the session — back off 5 min before retrying
          retryDelayRef.current = 5 * 60 * 1000;
        }
        // Exponential backoff capped at 30 s
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, 30_000);
        setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      wsRef.current?.close();
    };
  }, []);

  return (
    <WebSocketContext.Provider value={null}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocketContext() {
  return useContext(WebSocketContext);
}