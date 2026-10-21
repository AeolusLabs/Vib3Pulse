// The room page's connection to the room channel on the shared /ws socket.
// Pure state handling is in lib/roomReducer.ts (re-exported here); this hook only wires sockets to it.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useWebSocketContext } from "@/providers/WebSocketProvider";
import { useAuth } from "@/hooks/useAuth";
import { initialRoomState, roomReducer, type RoomPhase, type RoomState } from "@/lib/roomReducer";
import type { ChatReply } from "@shared/rooms";
import type { StageAction } from "@shared/stage";
import type { LiveAction } from "@shared/liveScreen";
import type { GameAction, Side } from "@shared/gameScreen";
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
    chat: (text: string, replyTo?: ChatReply) => ws?.send({ type: "room:chat", text, ...(replyTo ? { replyTo } : {}) }) ?? false,
    react: (emoji: string) => ws?.send({ type: "room:react", emoji }) ?? false,
    interact: (targetId: string, kind: "wave" | "reaction", emoji?: string) => ws?.send({ type: "room:interact", targetId, kind, ...(emoji ? { emoji } : {}) }) ?? false,
    setScreen: (screen: string | null) => ws?.send({ type: "room:screen", screen }) ?? false,
    mod: (action: ModAction, targetId: string) => ws?.send({ type: "room:mod", action, targetId }) ?? false,
    /** raise / lower / invite / accept / remove. `targetId` defaults to yourself on the server. */
    stageAction: (action: StageAction, targetId?: string) => ws?.send({ type: "room:stage", action, ...(targetId ? { targetId } : {}) }) ?? false,
    /** ask / withdraw (yourself), grant / revoke / stop (host or co-host name a target; the holder may stop themselves). */
    liveAction: (action: LiveAction, targetId?: string) => ws?.send({ type: "room:live", action, ...(targetId ? { targetId } : {}) }) ?? false,
    /** Gamers live (flag on): ask / withdraw / accept / decline / remove / feature / score / format. The server decides; refusals arrive as room:notice. */
    gameAction: (action: GameAction, extra: { targetId?: string; side?: Side; value?: number } = {}) => ws?.send({ type: "room:game", action, ...extra }) ?? false,
    /** Host or co-host: report a play / pause / seek / end, or `cue` (everyone presses play in `inMs`). */
    sendPlayback: (p: { state: PlaybackState; positionMs: number; inMs?: number }) =>
      ws?.send({ type: "room:playback", ...p, screenVersion: (state.room as { screenVersion?: number } | null)?.screenVersion ?? 0 }) ?? false,
    /** Host: switch live voice on or off for the room. Resolves false if it was refused. */
    setVoice: async (enabled: boolean) => { try { await apiRequest("PUT", `/api/rooms/${roomId}/voice`, { enabled }); return true; } catch { return false; } },
    /** Host: switch live camera + mic streaming on or off. Resolves false if it was refused. */
    setLiveVideo: async (enabled: boolean) => { try { await apiRequest("PUT", `/api/rooms/${roomId}/live-video`, { enabled }); return true; } catch { return false; } },
    /** Host (all three) or co-host (pinned message only): change room settings. Everyone hears room:settings. Null when saved, else the server's message. */
    saveSettings: async (patch: { pinnedMessage?: string | null; slowModeSec?: number; locked?: boolean; /** Gamers live (host): players per side, and how long a dropped player keeps their place. */ gameFormat?: 1 | 2 | 3 | 4 | null; gameDropTimeoutMs?: 30000 | 120000 | 0 }): Promise<string | null> => {
      try { await apiRequest("PATCH", `/api/rooms/${roomId}`, patch); return null; } catch (e) { return (e as Error)?.message || ""; }
    },
    /** Host: make someone a co-host or a guest again. Everyone hears room:mod role. Null when done, else the server's message. */
    setRole: async (targetId: string, role: "cohost" | "guest"): Promise<string | null> => {
      try { await apiRequest("PUT", `/api/rooms/${roomId}/members/${targetId}/role`, { role }); return null; } catch (e) { return (e as Error)?.message || ""; }
    },
    /** Host: end the room for everyone. Everyone hears room:ended. Null when done, else the server's message. */
    endRoom: async (): Promise<string | null> => {
      try { await apiRequest("POST", `/api/rooms/${roomId}/end`); return null; } catch (e) { return (e as Error)?.message || ""; }
    },
    dismissInvite: () => dispatch({ type: "client:dismissInvite" }),
  };
}
