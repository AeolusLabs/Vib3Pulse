import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import cookie from "cookie";
import session from "express-session";
import { storage } from "./storage";
import { startReminderJob } from "./rooms/reminders";
import { startRoomRefundJob } from "./rooms/refunds";
import { startSettlementJob } from "./rooms/settlement";
import { startSprayJob } from "./rooms/sprayJobs";
import { handleRoomMessage, handleSocketClose, rehydrateLiveRooms, startVoiceSweep } from "./rooms/roomSocket";

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Set<AuthenticatedWebSocket>> = new Map();
  private sessionStore: any;

  initialize(server: Server, sessionStore: any) {
    this.sessionStore = sessionStore;
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws'
    });

    this.wss.on("connection", async (ws: AuthenticatedWebSocket, req) => {
      try {
        // Parse cookies and get session
        const cookies = cookie.parse(req.headers.cookie || "");
        // The main session cookie is "vibepulse.sid" (server/index.ts). This used to read "connect.sid", which no browser
        // had, so every socket was rejected with 4001 and nothing real-time worked. connect.sid stays as a fallback.
        const rawSid = cookies["vibepulse.sid"] ?? cookies["connect.sid"];
        const sessionId = rawSid ? decodeURIComponent(rawSid).split("s:")[1]?.split(".")[0] : undefined;

        if (!sessionId) {
          ws.close(4001, "Unauthorized");
          return;
        }

        // Get session from store
        const sessionData = await new Promise<any>((resolve) => {
          this.sessionStore.get(sessionId, (err: any, session: any) => {
            if (err || !session) resolve(null);
            else resolve(session);
          });
        });

        if (!sessionData?.passport?.user) {
          ws.close(4001, "Unauthorized");
          return;
        }

        const userId = sessionData.passport.user;
        // Same rule as HTTP auth (passport.deserializeUser): deleted or suspended accounts get no socket.
        const account = await storage.getUser(userId);
        if (!account || account.deletedAt || (await storage.getActiveSuspension(userId))) {
          ws.close(4001, "Unauthorized");
          return;
        }
        ws.userId = userId;
        ws.isAlive = true;

        // Add client to active connections
        if (!this.clients.has(userId)) {
          this.clients.set(userId, new Set());
        }
        this.clients.get(userId)!.add(ws);

        console.log(`WebSocket: User ${userId} connected`);

        // Send connected status
        ws.send(JSON.stringify({ 
          type: "connected", 
          userId,
          timestamp: new Date().toISOString()
        }));

        // Broadcast online status to others
        this.broadcastUserStatus(userId, "online");

        // Handle ping/pong for connection health
        ws.on("pong", () => {
          ws.isAlive = true;
        });

        // Handle incoming messages
        ws.on("message", async (data) => {
          try {
            const message = JSON.parse(data.toString());
            
            if (message.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
            } else if (typeof message.type === "string" && message.type.startsWith("room:")) {
              await handleRoomMessage(ws, userId, message);
            }
          } catch (error) {
            console.error("Error handling WebSocket message:", error);
          }
        });

        // Handle disconnection
        ws.on("close", () => {
          handleSocketClose(userId, ws).catch((e) => console.error("[rooms] socket close failed:", e));
          if (ws.userId) {
            const userSockets = this.clients.get(ws.userId);
            if (userSockets) {
              userSockets.delete(ws);
              if (userSockets.size === 0) {
                this.clients.delete(ws.userId);
                this.broadcastUserStatus(ws.userId, "offline");
                console.log(`WebSocket: User ${ws.userId} disconnected`);
              }
            }
          }
        });

        ws.on("error", (error) => {
          console.error("WebSocket error:", error);
        });

      } catch (error) {
        console.error("WebSocket connection error:", error);
        ws.close(4000, "Connection error");
      }
    });

    // Set up heartbeat interval
    const heartbeatInterval = setInterval(() => {
      this.wss?.clients.forEach((ws: WebSocket) => {
        const client = ws as AuthenticatedWebSocket;
        if (client.isAlive === false) {
          return client.terminate();
        }
        client.isAlive = false;
        client.ping();
      });
    }, 30000); // 30 seconds

    this.wss.on("close", () => {
      clearInterval(heartbeatInterval);
    });

    // Rooms that were live before a restart have no presence now; end them unless their host comes back.
    rehydrateLiveRooms().catch((e) => console.error("[rooms] rehydrate failed:", e));
    startReminderJob();
    startVoiceSweep();
    // Paid rooms: refunds owed (rooms that never started, unconfirmed refunds) and host payouts. Both guard against a
    // second start, unref their timers and catch every error; they run whatever the paidRooms flag says (money in flight).
    try { startRoomRefundJob(); } catch (e) { console.error("[rooms] refund job failed to start:", e); }
    try { startSettlementJob(); } catch (e) { console.error("[rooms] settlement job failed to start:", e); }
    // Spraying: every 15 s, delivers or reverses paid sprays and finishes refunds, whatever the spray flag says (money in flight).
    try { startSprayJob(); } catch (e) { console.error("[rooms:spray] sweep job failed to start:", e); }

    console.log("WebSocket server initialized on /ws");
  }

  // Broadcast a new message to the recipient
  broadcastMessage(senderId: string, receiverId: string, message: any) {
    const recipientSockets = this.clients.get(receiverId);
    if (recipientSockets) {
      const payload = JSON.stringify({
        type: "new_message",
        message,
        timestamp: new Date().toISOString()
      });

      recipientSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      });
    }

    // Also send to sender's other devices
    const senderSockets = this.clients.get(senderId);
    if (senderSockets) {
      const payload = JSON.stringify({
        type: "message_sent",
        message,
        timestamp: new Date().toISOString()
      });

      senderSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      });
    }
  }

  // Broadcast when a message is marked as read
  broadcastMessageRead(messageId: string, userId: string) {
    const userSockets = this.clients.get(userId);
    if (userSockets) {
      const payload = JSON.stringify({
        type: "message_read",
        messageId,
        timestamp: new Date().toISOString()
      });

      userSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      });
    }
  }

  // Broadcast a new conversation message to all participants
  broadcastToConversation(conversationId: string, participantIds: string[], message: any) {
    const payload = JSON.stringify({
      type: "new_conversation_message",
      conversationId,
      message,
      timestamp: new Date().toISOString(),
    });

    participantIds.forEach((userId) => {
      const userSockets = this.clients.get(userId);
      if (userSockets) {
        userSockets.forEach((socket) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
          }
        });
      }
    });
  }

  // Broadcast typing indicator
  broadcastTyping(senderId: string, receiverId: string, isTyping: boolean) {
    const recipientSockets = this.clients.get(receiverId);
    if (recipientSockets) {
      const payload = JSON.stringify({
        type: "typing",
        userId: senderId,
        isTyping,
        timestamp: new Date().toISOString()
      });

      recipientSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      });
    }
  }

  // Broadcast user online/offline status
  private broadcastUserStatus(userId: string, status: "online" | "offline") {
    // For now, we'll skip broadcasting to everyone
    // Could be optimized to only send to followers or active conversations
    console.log(`User ${userId} is now ${status}`);
  }

  // Check if user is online
  isUserOnline(userId: string): boolean {
    return this.clients.has(userId);
  }

  // Get online users
  getOnlineUsers(): string[] {
    return Array.from(this.clients.keys());
  }

  // Send message to a specific user
  sendToUser(userId: string, payload: any) {
    const userSockets = this.clients.get(userId);
    if (userSockets) {
      const message = JSON.stringify(payload);
      userSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(message);
        }
      });
    }
  }
}

export const wsManager = new WebSocketManager();
