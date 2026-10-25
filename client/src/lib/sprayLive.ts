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

/** Ask for the room again only if none is scheduled and none ran in the last 2 s (lastRefetchAt null: never ran). */
export function shouldRefetchSpray(now: number, lastRefetchAt: number | null, scheduled: boolean): boolean {
  if (scheduled) return false;
  return lastRefetchAt === null || now - lastRefetchAt >= SPRAY_REFETCH_COALESCE_MS;
}

/** A random 0..3000 ms so a full room does not ask at the same instant. */
export function jitterMs(random: number): number {
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  return Math.floor(r * SPRAY_JITTER_MAX_MS);
}

export const sprayOffMessage = (blockedByAdmin: boolean): string =>
  blockedByAdmin ? "Spray was turned off for this room" : "The host turned spray off";

export const SPRAY_ON_MESSAGE = "Spray is on";

export const SPRAY_LIVE_COPY = {
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
