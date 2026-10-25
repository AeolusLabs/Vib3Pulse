// Live spray state on the client, pure: no React, no network, no clock reads (callers pass `now` and `random`).
// The server broadcasts `sprayOn` / `sprayBlockedByAdmin` on room:settings (and room:state) only while ROOMS_SPRAY is on.
// Absent means "unknown": nothing here changes, which is also what keeps a flag-off server free of new UI and requests.

export const SPRAY_JITTER_MAX_MS = 3000;
export const SPRAY_REFETCH_COALESCE_MS = 2000;

export interface SprayFlags { sprayOn?: boolean; sprayBlockedByAdmin?: boolean }

/** The two flags off a room record, with anything that is not a boolean treated as absent. */
export function sprayFlags(room: { [k: string]: unknown } | null | undefined): SprayFlags {
  const out: SprayFlags = {};
  if (room && typeof room.sprayOn === "boolean") out.sprayOn = room.sprayOn;
  if (room && typeof room.sprayBlockedByAdmin === "boolean") out.sprayBlockedByAdmin = room.sprayBlockedByAdmin;
  return out;
}

/** The block the shell gets: the server's block, unless the room says spray is off right now (then null, at once). */
export function sprayVisible<B>(room: { [k: string]: unknown } | null | undefined, block: B | null): B | null {
  return sprayFlags(room).sprayOn === false ? null : block;
}

/** "off" / "on" only when the flag actually changed to that value; an absent flag is never a change. */
export function sprayTransition(prev: boolean | undefined, next: boolean | undefined): "none" | "off" | "on" {
  if (typeof next !== "boolean" || prev === next) return "none";
  return next ? "on" : "off";
}

/**
 * When to run the refetch for an ON signal, in ms from now; null when one is already pending (keep it, never push it later).
 * An ON signal is never dropped: a refetch that ran under 2 s ago only defers this one to lastRefetchAt + 2 s.
 */
export function nextSprayRefetchDelay(now: number, lastRefetchAt: number | null, pending: boolean, jitter: number): number | null {
  if (pending) return null;
  const wait = lastRefetchAt === null ? 0 : Math.max(0, lastRefetchAt + SPRAY_REFETCH_COALESCE_MS - now);
  return Math.max(jitter, wait);
}

/** What a change of the live flag means for the viewer: a toast (or none), and whether to schedule the ON refetch. */
export function sprayToastDecision(
  prev: boolean | undefined, next: boolean | undefined, o: { blockedByAdmin: boolean; isHost: boolean },
): { toast: string | null; schedule: boolean; cancel: boolean } {
  const none = { toast: null, schedule: false, cancel: false };
  if (prev === undefined) return none; // first state of a session is the baseline: never a toast, never an extra request
  const t = sprayTransition(prev, next);
  if (t === "on") return { toast: null, schedule: true, cancel: false };
  if (t === "off") return { toast: !o.isHost || o.blockedByAdmin ? sprayOffMessage(o.blockedByAdmin) : null, schedule: false, cancel: true };
  return none;
}

/** Host line when the room is switched off under them while their own setting is on (platform pause or freeze). */
export function hostSprayLine(r: { sprayOn?: boolean; sprayEnabled?: boolean; sprayBlockedByAdmin?: boolean }): string | null {
  return r.sprayOn === false && r.sprayEnabled === true && r.sprayBlockedByAdmin !== true ? SPRAY_LIVE_COPY.platformOff : null;
}

/** A random 0..3000 ms so a full room does not ask at the same instant. */
export function jitterMs(random: number): number {
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  return Math.floor(r * SPRAY_JITTER_MAX_MS);
}

export const sprayOffMessage = (blockedByAdmin: boolean): string =>
  blockedByAdmin ? "Spray was turned off for this room" : "The host turned spray off";

export const SPRAY_ON_MESSAGE = "Spray is on";

export const SPRAY_SLOT_TIMEOUT_MS = 6000;

/**
 * Keep the 92px gap where the Spray button will land only while that is still expected: spray is on and the viewer has no
 * block yet, the ON refetch has not settled, and we have not waited past the timeout. Once any of those ends the gap closes.
 */
export function spraySlotReserved(o: { possible: boolean; sprayOn: boolean | undefined; hasBlock: boolean; settled: boolean; waitedMs: number }): boolean {
  return o.possible && o.sprayOn === true && !o.hasBlock && !o.settled && o.waitedMs < SPRAY_SLOT_TIMEOUT_MS;
}

/** The "Spray is on" toast: only for a viewer, only while still awaiting the ON refetch, and only if that refetch delivered a block. */
export function sprayButtonToast(awaiting: boolean, hasBlock: boolean, isHost: boolean): string | null {
  return awaiting && hasBlock && !isHost ? SPRAY_ON_MESSAGE : null;
}

export const SPRAY_LIVE_COPY = {
  platformOff: "Spray is switched off by the platform right now. Your setting is kept.",
  adminBlocked: "Spray is turned off by the platform for this room. Only an admin can turn it back on.",
  cooldown: "Wait a few seconds before switching again",
  cooldownSecs: (retryMs: number) => `Wait ${Math.max(1, Math.ceil(retryMs / 1000))} seconds before switching again`,
} as const;

/** The host's switch refusal in plain words, or null when the code is not one of the live-spray ones. */
export function sprayToggleRefusal(f: { status?: number; code?: string; retryMs?: number }): { text: string; adminBlocked: boolean } | null {
  if (f.code === "SPRAY_ADMIN_BLOCKED") return { text: SPRAY_LIVE_COPY.adminBlocked, adminBlocked: true };
  if (f.code === "SPRAY_TOGGLE_COOLDOWN") {
    return { text: typeof f.retryMs === "number" && f.retryMs > 0 ? SPRAY_LIVE_COPY.cooldownSecs(f.retryMs) : SPRAY_LIVE_COPY.cooldown, adminBlocked: false };
  }
  return null;
}
