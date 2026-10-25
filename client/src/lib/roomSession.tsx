// The app-level room session: one joined room per user per tab. The socket and voice hooks live here, not in the page,
// so the room (and its audio) keeps running while the user moves around the app. Decisions are in roomSessionRules.ts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import { useRoomVoice, type RoomVoice } from "@/hooks/useRoomVoice";
import { initialSession, sessionStep, type ActiveRef, type SessionEvent, type SessionState } from "@/lib/roomSessionRules";

type RoomSocket = ReturnType<typeof useRoomSocket>;
export interface OpenOpts { inviteToken?: string; enabledVoice: boolean; /** The lane's own room id when the URL is a lane parent: voice joins that one. */ voiceRoomId?: string }

export interface RoomSession {
  /** The live joined room; null when nothing is joined or the session has ended. */
  active: { roomId: string; token: string | null } | null;
  /** The socket and voice of the joined room. They stay readable after it ended/was refused (so its page can say why), until leave() or the next open. */
  sock: RoomSocket | null;
  voice: RoomVoice | null;
  /** The room id `sock` and `voice` belong to (null when they are null). */
  viewing: string | null;
  open(roomId: string, opts: OpenOpts): "attached" | "needs-confirm";
  confirmSwitch(): void;
  cancelSwitch(): void;
  pendingSwitch: { from: string; to: string } | null;
  /** Keep the session running and let the user go elsewhere. */
  minimise(): void;
  /** The only explicit end: one room:leave, voice hangUp, microphone released. */
  leave(): void;
  /** True while the joined room's own screen is open (its page sets this); the mini-bar hides then. */
  expanded: boolean;
  setExpanded(on: boolean): void;
}

const NOOP: RoomSession = {
  active: null, sock: null, voice: null, viewing: null, open: () => "needs-confirm", confirmSwitch() {}, cancelSwitch() {},
  pendingSwitch: null, minimise() {}, leave() {}, expanded: false, setExpanded() {},
};
const Ctx = createContext<RoomSession>(NOOP);
export const useRoomSession = () => useContext(Ctx);

interface Extra { voiceRoomId: string | null; enabledVoice: boolean }

export function RoomSessionProvider({ children }: { children: ReactNode }) {
  const { data: me } = useAuth();
  const [st, setSt] = useState<SessionState>(initialSession);
  const stRef = useRef(st);
  const [extra, setExtra] = useState<Extra>({ voiceRoomId: null, enabledVoice: true });
  const pendingExtra = useRef<Extra | null>(null);
  const [joinSeq, setJoinSeq] = useState(0);
  const [expanded, setExpandedState] = useState(false);

  const roomId = st.active?.roomId ?? "";
  const token = st.active?.token ?? undefined;
  const sock = useRoomSocket(roomId, { inviteToken: token });
  const { state } = sock;
  const sockRef = useRef(sock);
  sockRef.current = sock;
  const live = !!st.active && !st.ended;
  // "reconnecting" counts as live: a blip in the app connection must not hang up the media.
  const voice = useRoomVoice(extra.voiceRoomId ?? roomId, {
    enabled: live && extra.enabledVoice && state.voiceEnabled && (state.phase === "live" || state.phase === "reconnecting"),
    inviteToken: token, onCameraLost: () => sockRef.current.liveAction("stop"), game: !!state.game,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const apply = useCallback((e: SessionEvent) => {
    const r = sessionStep(stRef.current, e);
    stRef.current = r.state;
    setSt(r.state);
    for (const fx of r.effects) {
      if (fx === "leave") sockRef.current.leave();
      else if (fx === "hangUp") voiceRef.current.hangUp();
      else setJoinSeq((n) => n + 1); // the join waits for the render that carries the new room id
    }
    return r.result;
  }, []);

  // join() reads the room id of the render it runs in, which is why it is an effect and not part of apply().
  useEffect(() => { if (joinSeq > 0) sockRef.current.join(); }, [joinSeq]);

  useEffect(() => { apply({ type: "phase", phase: state.phase, reason: state.error ?? undefined }); }, [state.phase, state.error, apply]);
  useEffect(() => { if (me === null && stRef.current.active) apply({ type: "signOut" }); }, [me, apply]);
  // The provider going away (the app closing) is the one teardown left besides leave().
  useEffect(() => () => {
    if (stRef.current.active && !stRef.current.ended) { sockRef.current.leave(); voiceRef.current.hangUp(); }
  }, []);

  const open = useCallback((id: string, opts: OpenOpts) => {
    const ex: Extra = { voiceRoomId: opts.voiceRoomId ?? null, enabledVoice: opts.enabledVoice };
    const result = apply({ type: "open", next: { roomId: id, token: opts.inviteToken ?? null } }) ?? "needs-confirm";
    if (result === "needs-confirm") pendingExtra.current = ex; else setExtra(ex);
    return result;
  }, [apply]);
  const confirmSwitch = useCallback(() => {
    if (pendingExtra.current) setExtra(pendingExtra.current);
    pendingExtra.current = null;
    apply({ type: "confirmSwitch" });
  }, [apply]);
  const cancelSwitch = useCallback(() => { pendingExtra.current = null; apply({ type: "cancelSwitch" }); }, [apply]);
  const minimise = useCallback(() => { apply({ type: "minimise" }); }, [apply]);
  const leave = useCallback(() => { apply({ type: "leave" }); }, [apply]);
  // Closing the room's page on a refused/ended session drops its stale final state, so coming back starts fresh.
  const setExpanded = useCallback((on: boolean) => {
    setExpandedState(on);
    if (!on && stRef.current.ended) apply({ type: "leave" });
  }, [apply]);

  const value = useMemo<RoomSession>(() => ({
    active: st.active && !st.ended ? st.active : null,
    sock: st.active ? sock : null,
    voice: st.active ? voice : null,
    viewing: st.active?.roomId ?? null,
    open, confirmSwitch, cancelSwitch, minimise, leave,
    pendingSwitch: st.pendingSwitch ? { from: st.pendingSwitch.from, to: st.pendingSwitch.to } : null,
    expanded, setExpanded,
  }), [st, sock, voice, open, confirmSwitch, cancelSwitch, minimise, leave, expanded]);

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  );
}
