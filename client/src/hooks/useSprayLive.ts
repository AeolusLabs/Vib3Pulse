// Turns the room's live spray flag (room:settings / room:state) into the two things the page does about it: one jittered
// refetch of the room details when spray comes on (the spray block is per-viewer and only the details route has it), and a
// toast when it goes off or the button lands. Nothing runs while the flag is absent, so a flag-off server sees no new requests.
import { useEffect, useRef, useState } from "react";
import { SPRAY_SLOT_TIMEOUT_MS, jitterMs, sprayButtonToast, nextSprayRefetchDelay, sprayFlags, sprayToastDecision } from "@/lib/sprayLive";

export interface SprayLiveOptions {
  room: { id: string; [k: string]: unknown } | null;
  /** The Spray button has a block to work with (the live flag already applied). */
  hasBlock: boolean;
  isHost: boolean;
  refetch(): unknown;
  say(message: string): void;
}

/** True while the Spray button slot should stay reserved: clears when the ON refetch settles (or after 6 s). */
export function useSpraySlot(candidate: boolean, settled: boolean): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (!candidate) return;
    const t = setTimeout(() => setTimedOut(true), SPRAY_SLOT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [candidate]);
  return candidate && !settled && !timedOut;
}

export function useSprayLive({ room, hasBlock, isHost, refetch, say }: SprayLiveOptions) {
  const { sprayOn, sprayBlockedByAdmin } = sprayFlags(room);
  const roomId = room?.id ?? null;
  const prev = useRef<boolean | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAt = useRef<number | null>(null);
  const awaitingButton = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settled, setSettled] = useState(true);
  const fns = useRef({ refetch, say, isHost, blocked: false });
  fns.current = { refetch, say, isHost, blocked: sprayBlockedByAdmin === true };

  useEffect(() => {
    prev.current = undefined; awaitingButton.current = false; lastAt.current = null;
    setSettled(true);
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; if (settleTimer.current) clearTimeout(settleTimer.current); settleTimer.current = null; };
  }, [roomId]);

  useEffect(() => {
    if (sprayOn === undefined) return;
    const before = prev.current;
    prev.current = sprayOn;
    const d = sprayToastDecision(before, sprayOn, { blockedByAdmin: fns.current.blocked, isHost: fns.current.isHost });
    if (d.cancel) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      awaitingButton.current = false;
      setSettled(true);
    }
    if (d.toast) fns.current.say(d.toast);
    if (d.schedule) {
      awaitingButton.current = true;
      setSettled(false);
      const delay = nextSprayRefetchDelay(Date.now(), lastAt.current, timer.current !== null, jitterMs(Math.random()));
      if (delay === null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        lastAt.current = Date.now();
        // The block lands in a later render; give that render a moment, then stop waiting so the toast cannot fire out of context.
        void Promise.resolve(fns.current.refetch()).catch(() => undefined).finally(() => {
          settleTimer.current = setTimeout(() => { awaitingButton.current = false; setSettled(true); }, 300);
        });
      }, delay);
    }
  }, [sprayOn]);

  useEffect(() => {
    const toast = sprayButtonToast(awaitingButton.current, hasBlock, fns.current.isHost);
    if (hasBlock && awaitingButton.current) { awaitingButton.current = false; setSettled(true); }
    if (toast) fns.current.say(toast);
  }, [hasBlock]);
  return { settled };
}
