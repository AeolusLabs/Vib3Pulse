// Pure helpers for the chat-first room shell (dock, People sheet, More sheet). No React, no window.

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
 * The Room safety sheet, adapted from the design pack's ruleList() to the room's age limit. The anonymous-guest lines only
 * appear once a room can allow anonymous guests (phase 2); before that they would describe a feature that doesn't exist.
 * The server enforces every one of these; this is only how they are explained.
 */
export function roomSafetyRules(ageLimit: string, opts: { anonymousAllowed?: boolean } = {}): SafetyRule[] {
  const anon = !!opts.anonymousAllowed;
  let who: string;
  if (ageLimit === "teen") who = "Only people under 18 can be in this room. Adults are blocked, checked on their account.";
  else if (ageLimit === "18+" || ageLimit === "21+") who = `Only adults ${ageLimit === "21+" ? "21 and over " : ""}can be in this room. Under 18s are blocked.`;
  else who = `People ${ageLimit === "16+" ? 16 : 13} and over can join.${anon ? " Adults are not allowed to join anonymously here." : ""}`;
  const rules: SafetyRule[] = [{ tone: "ok", text: who }];
  if (anon) {
    rules.push(
      { tone: "ok", text: "Anonymous guests can read, chat and react." },
      { tone: "no", text: "Anonymous guests can't wave, send private messages, use the mic or the camera." },
      { tone: "eye", text: "Hosts and moderators can still see who an anonymous guest is. Reports and bans follow the account." },
    );
  }
  rules.push({ tone: "eye", text: "Report anyone from their actions, or the whole room from Room options. Our team reads every report." });
  return rules;
}

/** The link Share room copies, or null for invite-only rooms (their link carries a private token; hosts make one in Controls). */
export function shareRoomUrl(origin: string, room: { id: string; visibility: string }): string | null {
  if (room.visibility === "invite") return null;
  return `${origin}/rooms/${encodeURIComponent(room.id)}`;
}
