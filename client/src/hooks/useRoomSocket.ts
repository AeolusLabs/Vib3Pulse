// The room page's connection to the room channel on the shared /ws socket.
// Pure state handling is in lib/roomReducer.ts (re-exported here); this hook only wires sockets to it.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useWebSocketContext } from "@/providers/WebSocketProvider";
import { useAuth } from "@/hooks/useAuth";
import { initialRoomState, roomReducer, type RoomPhase, type RoomState } from "@/lib/roomReducer";
import type { StageAction } from "@shared/stage";
import type { PlaybackState } from "@shared/playback";
import { apiRequest } from "@/lib/queryClient";

export { roomReducer, initialRoomState };
export type { RoomState, RoomPhase };
export type ModAction = "mute" | "unmute" | "kick" | "ban";
export type RoomSocketStatus = "connecting" | "live" | "reconnecting" | "ended" | "denied";

const REACTION_LIFETIME_MS = 4000;

export function useRoomSocket(roomId: string, opts: { inviteToken?: string } = {}) {
  const ws = useWebSocketContext();
  const { data: me } = useAuth();
  const [state, dispatch] = useReducer((s: RoomState, e: Parameters<typeof roomReducer>[1]) => roomReducer(s, e), undefined, () => initialRoomState(me?.id ?? null));
  const wantJoined = useRef(false);
  const token = opts.inviteToken;

  useEffect(() => { dispatch({ type: "client:self", userId: me?.id ?? null }); }, [me?.id]);
  // Kicked, banned, refused or ended: stop wanting in, or every reconnect would try to join again.
  useEffect(() => { if (state.phase === "ended" || state.phase === "denied") wantJoined.current = false; }, [state.phase]);

  const sendJoin = useCallback(() => ws?.send({ type: "room:join", roomId, ...(token ? { inviteToken: token } : {}) }), [ws, roomId, token]);

  const join = useCallback(() => {
    wantJoined.current = true;
    dispatch({ type: "client:connecting" });
    sendJoin(); // if the socket is not open yet, ws:open below sends it
  }, [sendJoin]);

  const leave = useCallback(() => {
    wantJoined.current = false;
    ws?.send({ type: "room:leave" });
    dispatch({ type: "client:reset" });
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    return ws.subscribe((msg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "ws:close") { dispatch({ type: "client:reconnecting" }); return; }
      if (msg.type === "ws:open") { if (wantJoined.current) sendJoin(); return; } // re-join after a reconnect
      if (msg.type.startsWith("room:")) dispatch(msg);
    });
  }, [ws, sendJoin]);

  // Reactions and incoming interactions are animation fuel: drop them once they are old.
  const animating = state.reactions.length > 0 || state.interactions.length > 0;
  useEffect(() => {
    if (!animating) return;
    const t = setInterval(() => dispatch({ type: "client:expire", before: Date.now() - REACTION_LIFETIME_MS }), 1000);
    return () => clearInterval(t);
  }, [animating]);

  useEffect(() => () => { if (wantJoined.current) ws?.send({ type: "room:leave" }); wantJoined.current = false; }, [ws]);

  const status: RoomSocketStatus = state.phase === "idle" ? "connecting" : state.phase;

  return {
    state, status, join, leave,
    chat: (text: string) => ws?.send({ type: "room:chat", text }) ?? false,
    react: (emoji: string) => ws?.send({ type: "room:react", emoji }) ?? false,
    interact: (targetId: string, kind: "wave" | "reaction", emoji?: string) => ws?.send({ type: "room:interact", targetId, kind, ...(emoji ? { emoji } : {}) }) ?? false,
    setScreen: (screen: string | null) => ws?.send({ type: "room:screen", screen }) ?? false,
    mod: (action: ModAction, targetId: string) => ws?.send({ type: "room:mod", action, targetId }) ?? false,
    /** raise / lower / invite / accept / remove. `targetId` defaults to yourself on the server. */
    stageAction: (action: StageAction, targetId?: string) => ws?.send({ type: "room:stage", action, ...(targetId ? { targetId } : {}) }) ?? false,
    /** Host or co-host: report a play / pause / seek / end, or `cue` (everyone presses play in `inMs`). */
    sendPlayback: (p: { state: PlaybackState; positionMs: number; inMs?: number }) =>
      ws?.send({ type: "room:playback", ...p, screenVersion: (state.room as { screenVersion?: number } | null)?.screenVersion ?? 0 }) ?? false,
    /** Host: switch live voice on or off for the room. Resolves false if it was refused. */
    setVoice: async (enabled: boolean) => { try { await apiRequest("PUT", `/api/rooms/${roomId}/voice`, { enabled }); return true; } catch { return false; } },
    dismissInvite: () => dispatch({ type: "client:dismissInvite" }),
  };
}
