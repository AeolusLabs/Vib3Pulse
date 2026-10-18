// Pure rules that tie the room shell pieces together in RoomShell (task 1.7). No React, no DOM.
// Tested in scripts/test-rooms-unit-integration.ts.
import { validateChatReply, type ChatReply } from "@shared/rooms";
import { liveMeta } from "@/lib/videoViewState";
import type { VideoView } from "@/lib/roomLayout";

/**
 * Classes for a room sheet's close button: a 44 px round target in the top right corner, always visible, a focus ring
 * that shows. Passed to the shared Sheet's `closeClassName`, so other pages keep their own close button.
 */
export const ROOM_SHEET_CLOSE = "right-2 top-2 grid h-11 w-11 place-items-center rounded-full opacity-100 [&>svg]:h-5 [&>svg]:w-5";

/**
 * Live video counts as "live" for the views once someone holds the screen (even while their connection is held after a drop).
 * Before that there is no picture to fill the screen with, so the room keeps its avatars and the compact layout.
 */
export function videoIsLive(s: { liveVideo: boolean; holder: string | null; linkScreens?: boolean }): boolean {
  return s.liveVideo && !s.linkScreens && s.holder !== null;
}

/** The frame is immersive only on phones and tablets (stack), with a live picture, in the immersive view. Desktop never is. */
export function shellImmersive(s: { layout: "stack" | "rail"; live: boolean; view: VideoView }): boolean {
  return s.layout === "stack" && s.live && s.view === "immersive";
}

/**
 * What the composer sends as the reply quote for a chat line. The server compares the quote with its own copy cut the same
 * way (trimmed, 120 characters), so the client cuts it identically. Always addressed by userId.
 */
export function replyFromItem(item: { userId: string; text: string }): ChatReply | null {
  return validateChatReply({ userId: item.userId, text: item.text });
}

/** The top bar's second line. Immersive shows who is live (or reconnecting) and how many watch; otherwise the host line. */
export function topBarSubtitle(s: { immersive: boolean; holderName: string | null; count: number; away: boolean; self?: boolean }): string | undefined {
  if (!s.immersive) return undefined;
  if (s.self) return `${s.away ? "You're reconnecting" : "You're live"}, ${s.count} watching`;
  return liveMeta(s.holderName, s.count, s.away);
}

/** One status line at a time: something aimed at you, then a server notice, then the reaction slow-down line. */
export function statusLine(incoming: string | null, notice: string | null, gate: string | null): string | null {
  return incoming ?? notice ?? gate;
}

/** The fullscreen strip's chat notice: the server notice, else the reaction slow-down line (taps there go through the same gate). */
export function stripNotice(notice: string | null, gate: string | null): string | null {
  return notice ?? gate;
}

/** A chat author picked by userId. Null when they left (the line outlives them); the page then says so instead of opening a sheet. */
export function memberById<M extends { userId: string }>(members: readonly M[], userId: string): M | null {
  return members.find((m) => m.userId === userId) ?? null;
}

/**
 * A tap on a chat author's name. In the member list: open their actions. Not in it but seen in the room before: they left.
 * Never seen (the list the server sent did not include them): don't claim they left, just say it couldn't open.
 */
export function authorPick<M extends { userId: string }>(members: readonly M[], seen: (userId: string) => boolean, userId: string): { kind: "open"; member: M } | { kind: "left" } | { kind: "unknown" } {
  const member = memberById(members, userId);
  if (member) return { kind: "open", member };
  return seen(userId) ? { kind: "left" } : { kind: "unknown" };
}

/** Where focus goes when a sheet opened from another sheet closes: the top bar button that started the chain. */
export function returnFocusTestId(origin: "more" | "people" | null): string | null {
  return origin === "more" ? "room-more" : origin === "people" ? "room-people" : null;
}

/**
 * Classes for the top bar and dock wrappers in immersive. Hidden chrome fades (opacity only) and stops taking taps, but
 * comes straight back while focus is inside it, so a keyboard user never lands on invisible controls.
 */
export function chromeClasses(immersive: boolean, hidden: boolean): string {
  if (!immersive) return "";
  const base = "transition-opacity duration-200 ease-out motion-reduce:transition-none";
  return hidden ? `${base} pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100` : `${base} opacity-100`;
}

/**
 * Whether the page shows the live room. A failed refetch of the room details does not count: the last details are kept and
 * the socket is still live, so unmounting would throw away the draft, local mutes, the view and open sheets for nothing.
 */
export function showsShell(s: { isLoading: boolean; hasDetail: boolean; roomStatus: string; canJoin: boolean; phase: string }): boolean {
  return !s.isLoading && s.hasDetail && s.canJoin && s.roomStatus !== "ended" && s.roomStatus !== "scheduled"
    && (s.phase === "live" || s.phase === "reconnecting");
}
