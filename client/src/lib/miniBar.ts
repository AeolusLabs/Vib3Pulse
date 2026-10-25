// Pure decisions for the room mini-bar and the switch dialog (no DOM): npx tsx scripts/test-rooms-unit-minibar.ts
import type { GameView } from "@shared/gameScreen";
import { SIDE_NAME } from "@/lib/gameScreen";
import { leaveNeedsConfirm } from "@/lib/roomSessionRules";

/** "2v2 · Team A 3 - 1 Team B"; null when the room has no match. */
export function matchLine(game: GameView | null): string | null {
  if (!game) return null;
  return `${game.format}v${game.format} · ${SIDE_NAME.A} ${game.score[0]} - ${game.score[1]} ${SIDE_NAME.B}`;
}

/** Shown only while a room is joined, and never on that room's own screen (expanded flag, or its exact route). */
export function miniBarVisible(active: { roomId: string } | null, expanded: boolean, path = ""): boolean {
  if (!active || expanded) return false;
  return path.split(/[?#]/)[0].replace(/\/+$/, "") !== `/rooms/${active.roomId}`;
}

/** Mute only makes sense for someone who can publish audio. */
export const showMute = (canPublish: boolean): boolean => canPublish;

/** Leave from the bar: the host of a live room gets the same plain confirm as the page. */
export const leaveFromBar = (isHost: boolean, roomLive: boolean): "confirm" | "leave" => (leaveNeedsConfirm(isHost, roomLive) ? "confirm" : "leave");

export const LOCK_SCREEN_HELP = "On iPhone, audio can pause when the screen locks.";

/** The words of the switch dialog. A room whose name we do not know yet gets a plain fallback, never a blank. */
export function switchCopy(fromTitle: string | null, toTitle: string | null): { title: string; description: string | null } {
  return {
    title: `Leave ${fromTitle?.trim() || "your current room"} and join this one?`,
    description: toTitle?.trim() ? `You would join ${toTitle.trim()}.` : null,
  };
}

/** A title out of an untyped payload (the socket's room object or a cached room detail). */
export const titleOf = (room: unknown): string | null => {
  const t = (room as { title?: unknown } | null | undefined)?.title;
  return typeof t === "string" && t.trim() ? t : null;
};
