import { format, isToday, isYesterday, isSameYear, isSameDay } from "date-fns";
import type { User } from "@shared/schema";
import type { ChatMessage, ConversationWithDetails } from "./types";

export const personName = (u: Pick<User, "displayName" | "organizationName" | "username">) =>
  u.displayName || u.organizationName || u.username;

export const initialOf = (name: string) => (name.trim()[0] || "?").toUpperCase();

/** The other person in a direct chat. */
export const otherParticipant = (conv: ConversationWithDetails, meId: string) =>
  conv.participants.find((p) => p.userId !== meId);

export const conversationTitle = (conv: ConversationWithDetails, meId: string) =>
  conv.isGroup ? conv.name || "Group" : otherParticipant(conv, meId)?.user ? personName(otherParticipant(conv, meId)!.user) : "Unknown";

/** "Today", "Yesterday", "Fri 10 Oct", or "10 Oct 2025" for another year. */
export function dayLabel(date: Date | string): string {
  const d = new Date(date);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, isSameYear(d, new Date()) ? "EEE d MMM" : "d MMM yyyy");
}

/** Inbox timestamp: time today, "Yesterday", weekday this week, otherwise a short date. */
export function inboxTime(date: Date | string): string {
  const d = new Date(date);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return "Yesterday";
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 7) return format(d, "EEE");
  return format(d, isSameYear(d, new Date()) ? "d MMM" : "d MMM yyyy");
}

export type ThreadItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; message: ChatMessage; first: boolean; last: boolean; showSender: boolean };

const RUN_GAP_MS = 5 * 60 * 1000;

/** Day dividers plus run grouping (same sender, same day, under 5 minutes apart) for bubble corners and sender labels. */
export function buildThread(messages: ChatMessage[], isGroup: boolean): ThreadItem[] {
  const items: ThreadItem[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const created = new Date(m.createdAt);
    if (!prev || !isSameDay(new Date(prev.createdAt), created)) {
      items.push({ kind: "day", key: `day-${m.id}`, label: dayLabel(created) });
    }
    const joinsPrev =
      !!prev && prev.senderId === m.senderId && isSameDay(new Date(prev.createdAt), created) &&
      created.getTime() - new Date(prev.createdAt).getTime() < RUN_GAP_MS;
    const joinsNext =
      !!next && next.senderId === m.senderId && isSameDay(new Date(next.createdAt), created) &&
      new Date(next.createdAt).getTime() - created.getTime() < RUN_GAP_MS;
    items.push({ kind: "msg", key: m.id, message: m, first: !joinsPrev, last: !joinsNext, showSender: isGroup && !joinsPrev });
  });
  return items;
}

/**
 * Seen status for the viewer's last message. Honours the read-receipt setting: if the viewer has
 * receipts off, or (direct chats) the other person does, nothing is shown. In groups only members
 * who have receipts on are counted, so "Seen by 3" never reveals someone who opted out.
 */
export function seenStatus(
  conv: ConversationWithDetails,
  messages: ChatMessage[],
  meId: string,
): { label: string } | null {
  const me = conv.participants.find((p) => p.userId === meId);
  if (me?.user.readReceiptsEnabled === false) return null;
  const last = [...messages].reverse().find((m) => m.senderId === meId && !m.isDeleted);
  if (!last) return null;
  const sentAt = new Date(last.createdAt).getTime();
  const others = conv.participants.filter((p) => p.userId !== meId);
  const seen = others.filter(
    (p) => p.user.readReceiptsEnabled !== false && p.lastReadAt && new Date(p.lastReadAt).getTime() >= sentAt,
  );
  if (seen.length === 0) return null;
  if (!conv.isGroup) return { label: `Seen ${format(new Date(seen[0].lastReadAt as Date), "HH:mm")}` };
  return { label: `Seen by ${seen.length}` };
}
