// Pure hype-bar maths for the room dock. No React, no timers: the caller owns the clock.

export const HYPE = { perReaction: 12, perHeart: 6, decayPerSec: 3, max: 100 } as const;

const clean = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Add one event. Reaching `max` bursts once and resets to 0. `now` is accepted for a stable signature; the maths ignores it. */
export function hypeNext(value: number, event: "reaction" | "heart", _now?: number): { value: number; burst: boolean } {
  const next = clean(value) + (event === "heart" ? HYPE.perHeart : HYPE.perReaction);
  return next >= HYPE.max ? { value: 0, burst: true } : { value: next, burst: false };
}

/** Let the bar drain by `decayPerSec` for `dtSec` seconds. A negative or non-numeric dt changes nothing; the result is never below 0. */
export function hypeDecay(value: number, dtSec: number): number {
  const v = clean(value);
  const dt = clean(dtSec);
  return Math.max(0, v - HYPE.decayPerSec * dt);
}

/**
 * Client-side reaction limiter, a little stricter than the server's bucket (3 per second, burst 3) so the server's
 * RATE_LIMITED notice should never fire. A blocked tap is simply not sent.
 */
export const REACT_GATE = { ratePerSec: 2.5, burst: 3 } as const;
export interface ReactGateState { tokens: number; at: number }

export function reactGate(s: ReactGateState, now: number): { ok: boolean; state: ReactGateState } {
  const at = Number.isFinite(s.at) ? s.at : now;
  const dt = Math.max(0, (now - at) / 1000); // a clock that went backwards refills nothing
  const have = Number.isFinite(s.tokens) ? s.tokens : REACT_GATE.burst;
  const tokens = Math.min(REACT_GATE.burst, have + dt * REACT_GATE.ratePerSec);
  const nowOrAt = Math.max(now, at);
  if (tokens >= 1) return { ok: true, state: { tokens: tokens - 1, at: nowOrAt } };
  return { ok: false, state: { tokens, at: nowOrAt } };
}

/** Split a reactions list into the ones not counted yet. `seen` is rebuilt from the current list so it stays bounded. */
export function splitFresh<T extends { id: string }>(seen: ReadonlySet<string>, items: readonly T[]): { fresh: T[]; seen: Set<string> } {
  return { fresh: items.filter((r) => !seen.has(r.id)), seen: new Set(items.map((r) => r.id)) };
}

/**
 * The bar's value lives here, outside React, so draining it never re-renders the page. The value is a pure function of
 * time: it is stored with the moment it was set and decayed on read, so a hidden tab needs no timer to stay correct.
 */
export interface HypeStore {
  read(now?: number): number;
  /** Apply `count` reaction events; returns true if the bar burst at least once. */
  add(count: number, now?: number): boolean;
  subscribe(fn: () => void): () => void;
}

export function createHypeStore(): HypeStore {
  let value = 0;
  let at = 0;
  const subs = new Set<() => void>();
  const settle = (now: number) => {
    const t = Number.isFinite(now) ? now : at;
    value = hypeDecay(value, Math.max(0, t - at) / 1000);
    at = Math.max(at, t);
  };
  return {
    read(now = Date.now()) { settle(now); return value; },
    add(count, now = Date.now()) {
      settle(now);
      let burst = false;
      for (let i = 0; i < count; i++) {
        const r = hypeNext(value, "reaction", now);
        value = r.value;
        if (r.burst) burst = true;
      }
      subs.forEach((f) => f());
      return burst;
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
