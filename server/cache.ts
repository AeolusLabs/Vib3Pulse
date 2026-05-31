interface CacheConfig {
  ttlMs: number;
  maxSize?: number;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class Cache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private _hits = 0;
  private _misses = 0;

  constructor(config: CacheConfig) {
    this.ttlMs = config.ttlMs;
    this.maxSize = config.maxSize ?? 1000;
    const timer = setInterval(() => this._sweep(), this.ttlMs);
    timer.unref(); // don't block process exit
  }

  private _sweep(): void {
    const now = Date.now();
    this.store.forEach((entry, key) => {
      if (now >= entry.expiresAt) this.store.delete(key);
    });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) { this._misses++; return null; }
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      this._misses++;
      return null;
    }
    this._hits++;
    return entry.data;
  }

  set(key: string, data: T): void {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      // FIFO eviction: Map preserves insertion order
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { data, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }

  stats() {
    const now = Date.now();
    let liveEntries = 0;
    this.store.forEach((entry) => {
      if (now < entry.expiresAt) liveEntries++;
    });
    return {
      totalEntries: this.store.size,
      liveEntries,
      ttlMs: this.ttlMs,
      hits: this._hits,
      misses: this._misses,
    };
  }
}

// Per-cache in-flight maps — prevents thundering herd on cache miss
const inFlightMaps = new WeakMap<Cache<any>, Map<string, Promise<any>>>();

function getInFlight(cache: Cache<any>): Map<string, Promise<any>> {
  let m = inFlightMaps.get(cache);
  if (!m) { m = new Map(); inFlightMaps.set(cache, m); }
  return m;
}

export async function cached<T>(
  key: string,
  fn: () => Promise<T>,
  cache: Cache<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit !== null) return hit;

  const inFlight = getInFlight(cache);
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn()
    .then((data) => { cache.set(key, data); return data; })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

// Typed as Cache<any>: type safety is enforced at each cached<T>() call site
export const postsCache   = new Cache<any>({ ttlMs:  5 * 60 * 1000, maxSize: 500 });
export const eventsCache  = new Cache<any>({ ttlMs: 10 * 60 * 1000, maxSize: 200 });
export const storiesCache = new Cache<any>({ ttlMs:  2 * 60 * 1000, maxSize: 300 });

export const invalidateCache = {
  posts(key?: string):   void { key ? postsCache.delete(key)   : postsCache.clear(); },
  events(key?: string):  void { key ? eventsCache.delete(key)  : eventsCache.clear(); },
  stories(key?: string): void { key ? storiesCache.delete(key) : storiesCache.clear(); },
  all():                 void { postsCache.clear(); eventsCache.clear(); storiesCache.clear(); },
};