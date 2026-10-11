import type { User, Conversation, ConversationParticipant, ConversationMessage, Story } from "@shared/schema";

// Row from GET /api/conversations (unreadCount is per current user) and GET /api/conversations/:id.
export type ConversationWithDetails = Conversation & {
  participants: Array<ConversationParticipant & { user: User }>;
  unreadCount: number;
};

export type ChatMessage = ConversationMessage & {
  sender: User;
  replyTo?: (ConversationMessage & { sender: User }) | null;
  story?: Story & { user: User };
};

// "Event chat" auto-dissolves this many days after the event (see startEventGroupDissolveJob on the server).
export const EVENT_CHAT_CLOSES_AFTER_DAYS = 7;

// Matches MAX_GROUP_MEMBERS in server/routes/messages-routes.ts, enforced there.
export const MAX_GROUP_MEMBERS = 50;
