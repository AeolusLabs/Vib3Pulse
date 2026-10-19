// A per-key promise queue with a bounded length. Pure (no database). Used to issue room tickets one at a time per room
// INSIDE this process, before a pool connection is taken: without it, every concurrent charge for a hot room took a
// pool connection and then sat waiting on the room row lock (SELECT ... FOR UPDATE), so about 20 buyers of one room could
// hold the whole pool (max 20) and stall the app. The row lock stays, for safety across server instances.
//
// run(key, fn): fn runs after every earlier task for the same key has settled (fulfilled or rejected), never two at once
// for one key. Tasks for different keys run independently. When `maxPending` tasks (the running one included) are already
// waiting for that key, run throws QueueFullError at once, without queueing: the caller answers 503 + Retry-After.

export class QueueFullError extends Error {
  constructor(public key: string, public pending: number) {
    super(`queue for ${key} is full (${pending} pending)`);
    this.name = "QueueFullError";
  }
}

export interface KeyedQueue {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Tasks queued or running for this key (0 when idle). */
  pending(key: string): number;
}

export function createKeyedQueue(opts: { maxPending: number }): KeyedQueue {
  if (!Number.isInteger(opts.maxPending) || opts.maxPending < 1) throw new Error("maxPending must be a positive integer");
  const tails = new Map<string, Promise<void>>();
  const counts = new Map<string, number>();

  return {
    pending: (key) => counts.get(key) ?? 0,
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const n = counts.get(key) ?? 0;
      if (n >= opts.maxPending) return Promise.reject(new QueueFullError(key, n));
      counts.set(key, n + 1);
      const prev = tails.get(key) ?? Promise.resolve();
      const result = prev.then(() => fn());
      // The next task waits for this one to settle either way; a failure never blocks the queue.
      const tail = result.then(() => undefined, () => undefined).then(() => {
        const left = (counts.get(key) ?? 1) - 1;
        if (left <= 0) counts.delete(key); else counts.set(key, left);
        if (tails.get(key) === tail) tails.delete(key);
      });
      tails.set(key, tail);
      return result;
    },
  };
}
