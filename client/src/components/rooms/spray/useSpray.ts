// The pay flow for one room (task 5.9). The rules are the pure state machine in lib/sprayUi.ts (sprayFlow); this hook only
// wires it to the network, a clock, the tab's sessionStorage and the room's spray events.
//
// - The idempotency key is made once per intent (start) and sent on every attempt of that intent. A double tap cannot make
//   a second request: `busy` is a ref (set before the first await), and the machine only pays from `confirming`.
// - Every request gives up after 15 s (sprayApi). No answer (network, timeout, 5xx, a garbled 200) is an UNKNOWN outcome:
//   the flow stays `paying` with `unknown`, says "still checking, don't pay again", and replays the SAME key on a timer and
//   when the browser comes back online. A replay never charges twice: the server answers with the first result.
// - Offline when Pay is tapped: nothing is sent, and the line says so.
// - The wait has one deadline, counted from the Pay tap (waitDeadlineMs), whatever is known by then. Past it the flow
//   says "still checking" / "still waiting for your bank" (never a failure) and "Check again" replays the same key.
// - Delivered comes from the room:spray event with this spray's id (everyone sees the same thing), or from the poll.
// - A reload mid-payment: the spray id, the key and the tier/target (nothing secret) are kept in sessionStorage for this
//   tab only, so tracking resumes when the room opens again. Cleared as soon as the spray settles.
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { SprayTier } from "@shared/money";
import type { SprayEvent } from "@/lib/roomReducer";
import { getSprayStatus, postSpray } from "@/lib/sprayApi";
import {
  IDLE, SPRAY_TRACK_KEY, decodeSprayTrack, encodeSprayTrack, inFlight, newIdempotencyKey, outcomeOfPost, outcomeOfStatus,
  pollDelayMs, sprayFlow, waitDeadlineMs, type SprayFlow, type SprayFlowEvent, type SprayIntent,
} from "@/lib/sprayUi";

const online = () => (typeof navigator === "undefined" || navigator.onLine !== false);
const session = () => { try { return window.sessionStorage; } catch { return null; } };

export interface UseSprayOptions {
  /** Invite token for an invite-only room (the spray routes are gated on viewing the room, like tickets). */
  token?: string;
  /** state.sprays from the room reducer: delivered sprays as broadcast. */
  sprays: readonly SprayEvent[];
  /** A spray finished (delivered or refused after money moved): refresh the room limit and today's spend. */
  onSettled?: () => void;
  /** Dev fixture only: start in this state. */
  initial?: SprayFlow;
}

export function useSpray(roomId: string, opts: UseSprayOptions) {
  const [state, dispatch] = useReducer((s: SprayFlow, e: SprayFlowEvent) => sprayFlow(s, e), opts.initial ?? IDLE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const tokenRef = useRef(opts.token);
  tokenRef.current = opts.token;
  const settledRef = useRef(opts.onSettled);
  settledRef.current = opts.onSettled;

  /** Open the confirm step for this tier and person: a new intent, so a new key. Ignored while a payment is in flight. */
  const start = useCallback((tier: SprayTier, targetId: string): boolean => {
    if (inFlight(stateRef.current) || busy.current) return false;
    let key: string;
    try { key = newIdempotencyKey(); } catch { return false; }
    dispatch({ type: "start", tier, targetId, key });
    return true;
  }, []);

  const setSaveCard = useCallback((on: boolean) => dispatch({ type: "saveCard", on }), []);

  /** One POST of this intent with its own key. Never overlaps another (busy), never a new key. */
  const send = useCallback(async (intent: SprayIntent) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await postSpray(roomId, { tier: intent.tier, targetId: intent.targetId, idempotencyKey: intent.key, saveCard: intent.saveCard }, tokenRef.current);
      if (!alive.current) return;
      const cur = stateRef.current;
      // Only an answer for the intent that is still in flight counts (the machine also ignores other spray ids).
      if (!inFlight(cur) || cur.intent.key !== intent.key) return;
      dispatch({ type: "outcome", outcome: outcomeOfPost(r, window.location.origin), now: Date.now() });
    } finally {
      busy.current = false;
    }
  }, [roomId]);

  const pay = useCallback(() => {
    const s = stateRef.current;
    if (busy.current || s.kind !== "confirming") return;
    const intent = s.intent;
    dispatch({ type: "pay", now: Date.now() });
    if (!online()) {
      // Nothing leaves the device: say so plainly. Trying again later reuses the same key.
      dispatch({ type: "outcome", outcome: { kind: "failed", reason: "NOT_SENT", sprayId: null }, now: Date.now() });
      return;
    }
    void send(intent);
  }, [send]);

  /** After a failure: the same intent and key when the outcome was unknown, otherwise a new intent with a new key. */
  const retry = useCallback(() => {
    let key = "";
    try { key = newIdempotencyKey(); } catch { /* the machine keeps the failure when no key could be made */ }
    dispatch({ type: "retry", key });
  }, []);

  /** Hide or drop the flow. While money is in flight (paying or the bank page) the machine keeps it: only the sheet hides. */
  const close = useCallback(() => dispatch({ type: "close" }), []);

  // ---------------------------------------------------------------- resume after a reload (this tab only)
  useEffect(() => {
    if (opts.initial || stateRef.current.kind !== "idle") return;
    const store = session();
    let raw: string | null = null;
    try { raw = store?.getItem(SPRAY_TRACK_KEY) ?? null; } catch { raw = null; }
    // Another room's record is left alone (that room resumes it); an expired or malformed one is simply ignored.
    const t = decodeSprayTrack(raw, roomId, Date.now());
    if (!t) return;
    dispatch({ type: "resume", intent: { tier: t.tier, targetId: t.targetId, key: t.key, saveCard: false }, sprayId: t.sprayId, since: t.since });
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the tracking record in step: written while a known spray is in flight, removed once it settles or is dropped.
  const trackRecord = encodeSprayTrack(roomId, state);
  useEffect(() => {
    const store = session();
    if (!store || opts.initial) return;
    try {
      if (trackRecord) store.setItem(SPRAY_TRACK_KEY, trackRecord);
      else if (!inFlight(stateRef.current)) {
        const cur = store.getItem(SPRAY_TRACK_KEY);
        if (cur && decodeSprayTrack(cur, roomId, Date.now()) !== null) store.removeItem(SPRAY_TRACK_KEY);
      }
    } catch { /* kept in memory only */ }
  }, [trackRecord, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- delivered: the room:spray event with this spray's id
  const sprayId = state.kind === "paying" || state.kind === "action_required" ? state.sprayId : null;
  useEffect(() => {
    if (sprayId && opts.sprays.some((x) => x.id === sprayId)) dispatch({ type: "seen", sprayId });
  }, [sprayId, opts.sprays]);

  // ---------------------------------------------------------------- one deadline from the Pay tap
  const flightKind = state.kind === "paying" || state.kind === "action_required" ? state.kind : null;
  const since = state.kind === "paying" || state.kind === "action_required" ? state.since : 0;
  useEffect(() => {
    if (!flightKind) return;
    const left = since + waitDeadlineMs(flightKind) - Date.now();
    const t = setTimeout(() => {
      const cur = stateRef.current;
      if (cur.kind !== flightKind) return;
      dispatch({ type: "outcome", outcome: { kind: "failed", reason: flightKind === "paying" ? "STILL_CHECKING" : "STILL_WAITING", sprayId: cur.sprayId }, now: Date.now() });
    }, Math.max(0, left));
    return () => clearTimeout(t);
  }, [flightKind, since]);

  // ---------------------------------------------------------------- no answer yet: replay the SAME key
  const replayKey = state.kind === "paying" && state.unknown && !state.sprayId ? state.intent.key : null;
  useEffect(() => {
    if (!replayKey) return;
    const s0 = stateRef.current;
    if (s0.kind !== "paying") return;
    const intent = s0.intent;
    const from = s0.since;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void go(); }, pollDelayMs(Date.now() - from)); };
    const go = async () => {
      if (stop) return;
      if (online()) await send(intent);
      if (stop) return;
      const cur = stateRef.current;
      if (cur.kind === "paying" && cur.unknown && !cur.sprayId) schedule();
    };
    const onOnline = () => { clearTimeout(timer); void go(); };
    schedule();
    window.addEventListener("online", onOnline);
    return () => { stop = true; clearTimeout(timer); window.removeEventListener("online", onOnline); };
  }, [replayKey, send]);

  // ---------------------------------------------------------------- a known spray: poll until it settles (or the deadline)
  const polling = (state.kind === "paying" && !!state.sprayId) || state.kind === "action_required";
  useEffect(() => {
    if (!polling || !sprayId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      if (online()) {
        const r = await getSprayStatus(roomId, sprayId, tokenRef.current);
        if (stop) return;
        dispatch({ type: "outcome", outcome: outcomeOfStatus(r, sprayId), now: Date.now() });
      }
      timer = setTimeout(() => { void tick(); }, pollDelayMs(Date.now() - since));
    };
    timer = setTimeout(() => { void tick(); }, pollDelayMs(Date.now() - since));
    const onOnline = () => { clearTimeout(timer); void tick(); };
    window.addEventListener("online", onOnline);
    return () => { stop = true; clearTimeout(timer); window.removeEventListener("online", onOnline); };
  }, [roomId, sprayId, polling, since]);

  // Coming back to the tab (after the bank's page): ask at once instead of waiting for the next tick.
  const bankId = state.kind === "action_required" ? state.sprayId : null;
  useEffect(() => {
    if (!bankId) return;
    const id = bankId;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !online()) return;
      void getSprayStatus(roomId, id, tokenRef.current).then((r) => { if (alive.current) dispatch({ type: "outcome", outcome: outcomeOfStatus(r, id), now: Date.now() }); });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [roomId, bankId]);

  // Money may have moved (or a reservation was released): refresh the limits once per settled spray.
  const settledKey = state.kind === "delivered" ? `d:${state.sprayId}` : state.kind === "failed" && state.sprayId ? `f:${state.sprayId}:${state.reason}` : null;
  useEffect(() => { if (settledKey) settledRef.current?.(); }, [settledKey]);

  return { state, start, setSaveCard, pay, retry, close };
}

export type SprayController = ReturnType<typeof useSpray>;
