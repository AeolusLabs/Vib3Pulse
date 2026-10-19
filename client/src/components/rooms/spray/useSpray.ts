// The pay flow for one room (task 5.9). The rules are the pure state machine in lib/sprayUi.ts (sprayFlow); this hook only
// wires it to the network, a clock and the room's spray events.
//
// - The idempotency key is made once per intent (start) and sent on every attempt of that intent. A double tap cannot make
//   a second request: `busy` is a ref (set before the first await), and the machine only pays from `confirming`.
// - An unknown outcome (no answer, a 5xx) is retried twice with the SAME key, then shown as a failure whose "Try again"
//   keeps the key: the server answers a replay with the first result and never charges twice.
// - Offline: Pay fails at once with a clear line (nothing is sent). A wait never lasts forever: past waitDeadlineMs the
//   flow fails with STILL_WAITING, and "Check again" replays the same key.
// - Delivered comes from the room:spray event with this spray's id (everyone sees the same thing), or from the poll.
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { SprayTier } from "@shared/money";
import type { SprayEvent } from "@/lib/roomReducer";
import { getSprayStatus, postSpray } from "@/lib/sprayApi";
import {
  IDLE, inFlight, newIdempotencyKey, outcomeOfPost, outcomeOfStatus, pollDelayMs, sprayFlow, waitDeadlineMs,
  type SprayFlow, type SprayFlowEvent,
} from "@/lib/sprayUi";

const online = () => (typeof navigator === "undefined" || navigator.onLine !== false);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  const pay = useCallback(async () => {
    const s = stateRef.current;
    if (busy.current || s.kind !== "confirming") return;
    busy.current = true;
    const intent = s.intent;
    dispatch({ type: "pay", now: Date.now() });
    try {
      if (!online()) { dispatch({ type: "outcome", outcome: { kind: "failed", reason: "OFFLINE", sprayId: null }, now: Date.now() }); return; }
      const send = () => postSpray(roomId, { tier: intent.tier, targetId: intent.targetId, idempotencyKey: intent.key, saveCard: intent.saveCard }, tokenRef.current);
      let r = await send();
      // Unknown outcome: the same request again, the same key. Never a new key here.
      for (let i = 0; i < 2 && !r.ok && (r.status === 0 || r.status >= 500) && online() && alive.current; i++) {
        await sleep(800 * (i + 1));
        r = await send();
      }
      if (!alive.current) return;
      dispatch({ type: "outcome", outcome: outcomeOfPost(r, window.location.origin), now: Date.now() });
    } finally {
      busy.current = false;
    }
  }, [roomId]);

  /** After a failure: the same intent and key when the outcome was unknown, otherwise a new intent with a new key. */
  const retry = useCallback(() => {
    let key = "";
    try { key = newIdempotencyKey(); } catch { /* the machine keeps the failure when no key could be made */ }
    dispatch({ type: "retry", key });
  }, []);

  const close = useCallback(() => dispatch({ type: "close" }), []);

  // Delivered: the room:spray event with this spray's id.
  const sprayId = state.kind === "paying" || state.kind === "action_required" ? state.sprayId : null;
  useEffect(() => {
    if (sprayId && opts.sprays.some((x) => x.id === sprayId)) dispatch({ type: "seen", sprayId });
  }, [sprayId, opts.sprays]);

  // Poll while waiting on a known spray, until it settles or the deadline passes.
  const waitingKind = state.kind === "paying" && state.sprayId ? "paying" : state.kind === "action_required" ? "action_required" : null;
  const since = state.kind === "paying" || state.kind === "action_required" ? state.since : 0;
  useEffect(() => {
    if (!waitingKind || !sprayId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      const elapsed = Date.now() - since;
      if (elapsed > waitDeadlineMs(waitingKind)) {
        dispatch({ type: "outcome", outcome: { kind: "failed", reason: "STILL_WAITING", sprayId }, now: Date.now() });
        return;
      }
      if (online()) {
        const r = await getSprayStatus(roomId, sprayId, tokenRef.current);
        if (stop) return;
        dispatch({ type: "outcome", outcome: outcomeOfStatus(r, sprayId), now: Date.now() });
      }
      timer = setTimeout(() => { void tick(); }, pollDelayMs(Date.now() - since));
    };
    timer = setTimeout(() => { void tick(); }, pollDelayMs(Date.now() - since));
    return () => { stop = true; clearTimeout(timer); };
  }, [roomId, sprayId, waitingKind, since]);

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
