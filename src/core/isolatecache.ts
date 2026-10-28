/**
 * A small per-isolate cache of KV values (credential records and `gh-repo:` index lists). A
 * Worker isolate serves many requests, so reading `cred:<project>` once a minute instead of on
 * every request saves KV reads and latency. Writes made by this isolate replace the cached
 * value at once; writes made elsewhere become visible within the TTL, which is no worse than
 * KV's own propagation delay (about 60 seconds).
 */

/** How long a cached value is served, in milliseconds. */
export const ISOLATE_CACHE_TTL_MS = 60_000;

/** Upper bound of entries per cache; the oldest entries are dropped first. */
const MAX_ENTRIES = 1000;

/** Values by key with a fixed time to live. `undefined` is a miss; `null` may be cached. */
export class IsolateCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(private readonly ttlMs: number = ISOLATE_CACHE_TTL_MS) {}

  /** The cached value, or `undefined` when it is missing or older than the TTL. */
  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Caches a value read from, or just written to, KV. */
  set(key: string, value: T, now: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: now + this.ttlMs });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Forgets one key. */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Forgets everything. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of cached keys (expired ones included until they are read). */
  get size(): number {
    return this.entries.size;
  }
}
