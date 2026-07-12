import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import cookie from "cookie";
import session from "express-session";
import { storage } from "./storage";

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
        const rawSid = cookies["connect.sid"];
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
            }
          } catch (error) {
            console.error("Error handling WebSocket message:", error);
          }
        });

        // Handle disconnection
        ws.on("close", () => {
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
