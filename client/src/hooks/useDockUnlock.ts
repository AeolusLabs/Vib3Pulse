import { useEffect, useRef, useState } from "react";
import { UNLOCK_FAILED, unlockStep, unlockWaitMs, type UnlockPending } from "@/lib/roomShell";

/**
 * The dock mic unlocks room audio with the tap itself (a user gesture). voice.unlock() resolves even when connecting failed, so
 * this follows the voice status to the real outcome (pure rule: `unlockStep`): only then say "Room audio on" and raise a guest's
 * hand, or say it failed. Returns the click handler. Exported for the dev harness.
 */
export function useDockUnlock(
  voice: { status: string; canPublish: boolean; unlock(): Promise<unknown> },
  ctx: { isGuest: boolean; hands: string[]; meId?: string; onRaise(): void; toast(t: { title: string }): unknown },
): () => void {
  const [pending, setPending] = useState<UnlockPending | null>(null);
  const [tick, setTick] = useState(0); // bumped by the timeout so the decision re-runs once it has passed
  // Read at outcome time without being effect deps (they change often and must not re-run the decision).
  const latest = useRef({ ...ctx, canPublish: voice.canPublish });
  latest.current = { ...ctx, canPublish: voice.canPublish };
  useEffect(() => {
    if (!pending) return;
    const r = unlockStep(pending, voice.status, Date.now());
    if (r.outcome === "pending") {
      // unlockStep returns the same object when nothing changed, so this sets state at most once (when `seen` flips).
      if (r.pending !== pending) { setPending(r.pending); return; }
      const t = setTimeout(() => setTick((n) => n + 1), unlockWaitMs(pending, Date.now()) + 50);
      return () => clearTimeout(t);
    }
    setPending(null);
    const c = latest.current;
    if (r.outcome === "failed") { c.toast({ title: UNLOCK_FAILED }); return; }
    if (pending.raise && !c.canPublish && !!c.meId && !c.hands.includes(c.meId)) { c.onRaise(); c.toast({ title: "Room audio on. Hand raised, the host can bring you on the mic." }); }
    else c.toast({ title: "Room audio on." });
  }, [voice.status, pending, tick]);
  return () => {
    setPending({ start: voice.status, seen: false, at: Date.now(), raise: ctx.isGuest && !voice.canPublish });
    void voice.unlock(); // synchronously inside the click: the tap is the gesture the browser needs
  };
}
