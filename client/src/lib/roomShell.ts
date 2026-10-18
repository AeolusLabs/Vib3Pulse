// Pure helpers for the chat-first room shell (dock, People sheet, More sheet). No React, no window.
import { ROOM_REACTIONS } from "@shared/rooms";

/** The reaction tray offers exactly what the server accepts (it drops anything else). */
export const TRAY_EMOJIS: readonly string[] = ROOM_REACTIONS;

/** The six reactions in the dock's row (and, from task 1.4, the tray). All are in ROOM_REACTIONS, which the server checks. */
export const DOCK_REACTIONS: readonly string[] = ["🔥", "❤️", "😂", "👏", "🎉", "🙌"];

/**
 * Why the dock's camera button can't be used right now (shown as a toast), or undefined when a tap does something:
 * ask or withdraw for someone on the mic, or stop the stream for the person who is live.
 */
export function camLockReason(s: { liveVideo: boolean; phaseLive: boolean; onStage: boolean; isHolder: boolean; cameraOn: boolean }): string | undefined {
  if (!s.liveVideo) return "Live video is off in this room.";
  if (!s.phaseLive) return "Wait for the room to reconnect.";
  if (s.isHolder) return s.cameraOn ? undefined : "You're on the screen. Pick your camera on the screen to go live.";
  if (!s.onStage) return "Only people on the mic can go live. Ask to speak first.";
  return undefined;
}

/** Host first, then co-hosts, then guests on the mic, then everyone else. Order inside each group is kept. */
export function orderPeople<T extends { userId: string; role: "host" | "cohost" | "guest" }>(members: T[], stage: string[]): T[] {
  const onMic = new Set(stage);
  const rank = (m: T) => (m.role === "host" ? 0 : m.role === "cohost" ? 1 : onMic.has(m.userId) ? 2 : 3);
  return members.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

export type SafetyTone = "ok" | "no" | "eye";
export interface SafetyRule { tone: SafetyTone; text: string }

/**
 * The Room safety sheet, adapted from the design pack's ruleList() to the room's age limit.
 * The server enforces every one of these; this is only how they are explained.
 */
export function roomSafetyRules(ageLimit: string): SafetyRule[] {
  let who: string;
  if (ageLimit === "teen") who = "Only people under 18 can be in this room. Adults are blocked, checked on their account.";
  else if (ageLimit === "18+" || ageLimit === "21+") who = `Only adults ${ageLimit === "21+" ? "21 and over " : ""}can be in this room. Under 18s are blocked.`;
  else who = `People ${ageLimit === "16+" ? 16 : 13} and over can join.`;
  const rules: SafetyRule[] = [{ tone: "ok", text: who }];
  rules.push({ tone: "eye", text: "Report anyone from their actions, or the whole room from Room options. Our team reads every report." });
  return rules;
}

/** The link Share room copies, or null for invite-only rooms (their link carries a private token; hosts make one in Controls). */
export function shareRoomUrl(origin: string, room: { id: string; visibility: string }): string | null {
  if (room.visibility === "invite") return null;
  return `${origin}/rooms/${encodeURIComponent(room.id)}`;
}

export type FrameSlot = "root" | "top" | "zone" | "chat" | "chatHeading" | "pin" | "chatBody" | "dock";

/**
 * Class names for every slot of RoomFrame. One element tree serves stack, rail and immersive; only these classes change, so
 * rotating a tablet across 1024 px never unmounts the picture, the composer draft or the chat scroll. Desktop is never immersive.
 */
export function frameSlots(layout: "stack" | "rail", immersive: boolean, opts: { live?: boolean } = {}): Record<FrameSlot, string> {
  if (layout === "rail") {
    return {
      root: "relative grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground",
      top: "col-start-1 row-start-1 min-w-0 px-2 pb-2 pt-3",
      zone: "col-start-1 row-span-2 row-start-2 min-h-0 min-w-0 overflow-y-auto px-4 pb-4",
      chat: "col-start-2 row-span-2 row-start-1 flex min-h-0 flex-col border-l bg-card",
      chatHeading: "px-4 pb-2 pt-4 text-sm font-semibold",
      pin: "px-3 pb-1",
      chatBody: "flex min-h-0 flex-1 flex-col",
      dock: "col-start-2 row-start-3 border-l bg-card",
    };
  }
  if (immersive) {
    return {
      root: "relative h-full min-h-0 overflow-hidden bg-black text-white",
      top: "absolute inset-x-0 top-0 z-[5] min-w-0 bg-gradient-to-b from-black/70 to-transparent px-2 pb-5 pt-[max(0.75rem,env(safe-area-inset-top,0px))]",
      zone: "absolute inset-0 z-0",
      // Chat floats over the lower picture, clear of the right-hand rail (task 1.5).
      chat: "absolute bottom-[calc(76px+env(safe-area-inset-bottom,0px))] left-0 right-16 z-[4] flex h-[30%] min-h-0 flex-col",
      chatHeading: "hidden",
      pin: "hidden",
      chatBody: "flex min-h-0 flex-1 flex-col",
      dock: "absolute inset-x-0 bottom-0 z-[5] bg-gradient-to-t from-black/70 to-transparent pt-3",
    };
  }
  return {
    root: "relative grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground",
    top: "min-w-0 px-2 pb-2 pt-[max(0.75rem,env(safe-area-inset-top,0px))]",
    // Capped so chat is always on screen at 390 x 800; the scene scrolls inside its own box when the room is busy.
    // Live video (compact) gets more: the picture, its controls and the speaker strip, with chat still on screen.
    zone: `${opts.live ? "max-h-[52dvh]" : "max-h-[38dvh]"} min-h-0 min-w-0 overflow-y-auto px-3`,
    chat: "mt-1.5 flex min-h-0 flex-col",
    chatHeading: "hidden",
    pin: "px-3 pb-1",
    chatBody: "flex min-h-0 flex-1 flex-col",
    dock: "border-t bg-card",
  };
}

/**
 * What a tap on the dock's mic does. Audio that is waiting for a tap (or failed) is unlocked by the tap itself, since it is a
 * user gesture. Any other not-ready status (connecting, just switched on) only explains. With the mic it toggles; a guest without it raises or lowers a hand.
 */
export function micTapAction(s: { status: string; canPublish: boolean; canAsk: boolean }): "unlock" | "wait" | "toggle-mic" | "hand" | null {
  if (s.status === "needs-tap" || s.status === "error") return "unlock";
  // Connecting, or voice just switched on and not started yet: keep the button and explain.
  if (s.status !== "listening" && s.status !== "speaking") return "wait";
  if (s.canPublish) return "toggle-mic";
  return s.canAsk ? "hand" : null;
}

/** Enter pressed to confirm an IME composition (Japanese, Chinese, Korean input), which must not send the message. */
export function isImeEnter(e: { key: string; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && (!!e.isComposing || e.keyCode === 229);
}

/** Toast for a failed room report. The server answers a repeat with 409 "You've already reported this". */
export function reportErrorToast(message: string | undefined): { title: string; description?: string } {
  if (message && /already reported/i.test(message)) return { title: "You already reported this room." };
  return { title: "Couldn't send report", description: message };
}

/** What the page says when the unlock tap didn't get the room's audio going. */
export const UNLOCK_FAILED = "Audio couldn't connect. Tap the mic to try again.";

/** How long a tap waits for room audio to come up before it says it failed. */
export const UNLOCK_TIMEOUT_MS = 15_000;

export interface UnlockPending {
  /** Voice status when the tap happened. */
  start: string;
  /** The status has moved since the tap. */
  seen: boolean;
  /** When the tap happened (ms, same clock as `now`). */
  at: number;
  /** Raise the guest's hand once audio is on. */
  raise: boolean;
}

/**
 * Follow an unlock tap to its real outcome. `voice.unlock()` resolves even when connecting failed (the hook catches its own
 * errors), so the page feeds every new voice status here instead of trusting the promise.
 * - Up (listening, speaking) is success, always.
 * - A status equal to the one at tap time is ignored until it has moved once (retrying from "error" starts at "error").
 * - Error or off is failure; so is still waiting after UNLOCK_TIMEOUT_MS.
 * - Otherwise still pending. When nothing changed it returns the SAME `p` object: the page re-runs its effect on every new
 *   pending object, so a fresh copy for an unchanged state would loop forever.
 */
export function unlockStep(p: UnlockPending, status: string, now: number): { outcome: "pending" | "ok" | "failed"; pending: UnlockPending | null } {
  if (status === "listening" || status === "speaking") return { outcome: "ok", pending: null };
  if (now - p.at >= UNLOCK_TIMEOUT_MS) return { outcome: "failed", pending: null };
  if (!p.seen && status === p.start) return { outcome: "pending", pending: p };
  if (status === "error" || status === "off") return { outcome: "failed", pending: null };
  return { outcome: "pending", pending: p.seen ? p : { ...p, seen: true } };
}

/** Milliseconds left before a pending unlock times out (0 when it already has). The page sets one timer for this. */
export function unlockWaitMs(p: UnlockPending, now: number): number {
  return Math.max(0, p.at + UNLOCK_TIMEOUT_MS - now);
}
