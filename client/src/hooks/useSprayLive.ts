// Turns the room's live spray flag (room:settings / room:state) into the two things the page does about it: one jittered
// refetch of the room details when spray comes on (the spray block is per-viewer and only the details route has it), and a
// toast when it goes off or the button lands. Nothing runs while the flag is absent, so a flag-off server sees no new requests.
import { useEffect, useRef } from "react";
import { SPRAY_ON_MESSAGE, jitterMs, shouldRefetchSpray, sprayFlags, sprayOffMessage, sprayTransition } from "@/lib/sprayLive";

export interface SprayLiveOptions {
  room: { id: string; [k: string]: unknown } | null;
  /** The Spray button has a block to work with (the live flag already applied). */
  hasBlock: boolean;
  isHost: boolean;
  refetch(): unknown;
  say(message: string): void;
}

export function useSprayLive({ room, hasBlock, isHost, refetch, say }: SprayLiveOptions) {
  const { sprayOn, sprayBlockedByAdmin } = sprayFlags(room);
  const roomId = room?.id ?? null;
  const prev = useRef<boolean | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAt = useRef<number | null>(null);
  const awaitingButton = useRef(false);
  const fns = useRef({ refetch, say, isHost, blocked: false });
  fns.current = { refetch, say, isHost, blocked: sprayBlockedByAdmin === true };

  useEffect(() => {
    prev.current = undefined; awaitingButton.current = false; lastAt.current = null;
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [roomId]);

  useEffect(() => {
    if (sprayOn === undefined) return;
    const before = prev.current;
    prev.current = sprayOn;
    // The first state of a session is the baseline: the live-phase refetch already covers it, and no toast for what was already so.
    if (before === undefined) return;
    const t = sprayTransition(before, sprayOn);
    if (t === "off") {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      awaitingButton.current = false;
      // The host switched it themselves unless an admin did; they do not need telling.
      if (!fns.current.isHost || fns.current.blocked) fns.current.say(sprayOffMessage(fns.current.blocked));
    } else if (t === "on") {
      awaitingButton.current = true;
      if (!shouldRefetchSpray(Date.now(), lastAt.current, timer.current !== null)) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        lastAt.current = Date.now();
        void fns.current.refetch();
      }, jitterMs(Math.random()));
    }
  }, [sprayOn]);

  useEffect(() => {
    if (!hasBlock || !awaitingButton.current) return;
    awaitingButton.current = false;
    if (!fns.current.isHost) fns.current.say(SPRAY_ON_MESSAGE);
  }, [hasBlock]);
}
