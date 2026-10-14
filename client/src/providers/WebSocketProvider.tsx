import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";

export type WsHandler = (msg: any) => void;
/** `send` is false when the socket is not open. `subscribe` gets every parsed server message plus {type:"ws:open"} / {type:"ws:close"}. */
export interface WebSocketApi {
  send(msg: object): boolean;
  subscribe(handler: WsHandler): () => void;
}

const WebSocketContext = createContext<WebSocketApi | null>(null);

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
  const rejectedRef = useRef(false); // the server refused the session (not logged in): coming back online must not retry
  const unmountedRef = useRef(false);
  const handlersRef = useRef(new Set<WsHandler>());
  // True once the server has authenticated this socket (it answers {type:"connected"}). Anything sent before that is dropped
  // by the server, which only starts listening after its async session lookup.
  const readyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const { data: me } = useAuth();
  const userId = me?.id ?? null;

  const api = useMemo<WebSocketApi>(() => ({
    send(msg) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !readyRef.current) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    subscribe(handler) {
      handlersRef.current.add(handler);
      return () => { handlersRef.current.delete(handler); };
    },
  }), []);

  useEffect(() => {
    const emit = (msg: unknown) => handlersRef.current.forEach((h) => { try { h(msg); } catch { /* a bad subscriber must not break the socket */ } });

    unmountedRef.current = false;

    function connect() {
      if (unmountedRef.current) return;

      const ws = new WebSocket(buildWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelayRef.current = 1000;
        rejectedRef.current = false;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
          if (data?.type === "connected") { readyRef.current = true; emit({ type: "ws:open" }); return; }
          emit(data);
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = (event) => {
        readyRef.current = false;
        if (unmountedRef.current) return;
        emit({ type: "ws:close" });
        if (event.code === 4001) {
          // Server rejected the session — back off 5 min before retrying
          retryDelayRef.current = 5 * 60 * 1000;
          rejectedRef.current = true;
        }
        // Exponential backoff capped at 8 s: on a weak connection that comes and goes, a live room must be rejoined within seconds, not half a minute
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, 8_000);
        timerRef.current = setTimeout(connect, delay);
      };
    }

    connectRef.current = connect;
    connect();

    // The phone says it has a network again (Wi-Fi back, signal back): try now instead of waiting out the back-off.
    const onOnline = () => {
      const ws = wsRef.current;
      if (unmountedRef.current || rejectedRef.current || (ws && ws.readyState <= WebSocket.OPEN)) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      retryDelayRef.current = 1000;
      connect();
    };
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("online", onOnline);
      unmountedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, []);

  // The socket is opened at app start, before anyone has logged in, and the server rejects it (4001) with a 5 minute
  // back-off. Rooms are live, so connect right away when someone logs in; close the socket when they log out.
  useEffect(() => {
    const ws = wsRef.current;
    if (userId) {
      if (ws && ws.readyState === WebSocket.OPEN) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (ws) { ws.onclose = null; ws.close(); }
      retryDelayRef.current = 1000;
      connectRef.current();
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }, [userId]);

  return (
    <WebSocketContext.Provider value={api}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocketContext() {
  return useContext(WebSocketContext);
}