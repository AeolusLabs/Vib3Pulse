// Pure rules for the app-level room session (no DOM, no socket): npx tsx scripts/test-rooms-unit-roomsession.ts
// One joined room per user per tab. The provider (roomSession.tsx) runs the effects this file decides.

export interface ActiveRef { roomId: string; token: string | null }

/** Same room: attach (no second join). Another room while one is live: ask first. Nothing live: start. */
export function sessionAction(prev: ActiveRef | null, next: ActiveRef): "attach" | "confirm" | "start" {
  if (!prev) return "start";
  return prev.roomId === next.roomId ? "attach" : "confirm";
}

/** The session is over for good: the room ended, the server refused us, or we were removed. "reconnecting" is NOT an end. */
export function shouldEnd(phase: string, reason?: string): boolean {
  return phase === "ended" || phase === "denied" || reason === "KICKED" || reason === "BANNED";
}

export type SessionEffect = "join" | "leave" | "hangUp";

export interface SessionState {
  active: ActiveRef | null;
  /** Ended, denied or kicked: the final state stays readable for the page, but this is no longer a live session. */
  ended: boolean;
  /** Mirrors the socket hook's wantJoined: true while a reconnect should rejoin. */
  wantJoined: boolean;
  minimised: boolean;
  pendingSwitch: { from: string; to: string; next: ActiveRef } | null;
}

export const initialSession: SessionState = { active: null, ended: false, wantJoined: false, minimised: false, pendingSwitch: null };

export type SessionEvent =
  | { type: "open"; next: ActiveRef }
  | { type: "confirmSwitch" }
  | { type: "cancelSwitch" }
  | { type: "minimise" }
  | { type: "leave" }
  | { type: "signOut" }
  | { type: "phase"; phase: string; reason?: string };

export interface SessionStep { state: SessionState; effects: SessionEffect[]; result?: "attached" | "needs-confirm" }

const start = (next: ActiveRef): SessionState => ({ active: next, ended: false, wantJoined: true, minimised: false, pendingSwitch: null });

export function sessionStep(s: SessionState, e: SessionEvent): SessionStep {
  const live = s.active && !s.ended ? s.active : null;
  switch (e.type) {
    case "open": {
      const action = sessionAction(live, e.next);
      if (action === "attach") return { state: { ...s, minimised: false }, effects: [], result: "attached" };
      if (action === "confirm") return { state: { ...s, pendingSwitch: { from: live!.roomId, to: e.next.roomId, next: e.next } }, effects: [], result: "needs-confirm" };
      // An ended room's last state is still held for the page: starting over clears it with one leave.
      return { state: start(e.next), effects: s.active ? ["leave", "hangUp", "join"] : ["join"], result: "attached" };
    }
    case "confirmSwitch":
      if (!s.pendingSwitch) return { state: s, effects: [] };
      return { state: start(s.pendingSwitch.next), effects: ["leave", "hangUp", "join"] };
    case "cancelSwitch":
      return { state: { ...s, pendingSwitch: null }, effects: [] };
    case "minimise":
      return { state: s.active ? { ...s, minimised: true } : s, effects: [] }; // the session lives on
    case "leave":
    case "signOut":
      if (!s.active) return { state: { ...initialSession }, effects: [] };
      return { state: { ...initialSession }, effects: ["leave", "hangUp"] };
    case "phase":
      if (!live || !shouldEnd(e.phase, e.reason)) return { state: s, effects: [] };
      return { state: { ...s, ended: true, wantJoined: false, pendingSwitch: null }, effects: ["hangUp"] }; // the server already dropped us: no room:leave
  }
}

/** Back arrow / Leave on the page: a host's explicit Leave on a live room needs the plain confirm. */
export function leaveNeedsConfirm(isHost: boolean, roomLive: boolean): boolean {
  return isHost && roomLive;
}

export const HOST_LEAVE_CONFIRM = "You're hosting this live room. Leave and end your seat?";
