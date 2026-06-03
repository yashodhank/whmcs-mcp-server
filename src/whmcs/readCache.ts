/**
 * ReadCache — short-TTL, in-memory, process-local cache for idempotent WHMCS reads.
 *
 * F1: cut repeated WHMCS API load for truly-static reference reads.
 *
 * Design constraints (enforced by callers + this impl):
 *  - Caches ONLY idempotent reads on the WhmcsClient.read() path. Never mutate().
 *  - Default OFF: TTL 0 ⇒ disabled, so existing behaviour/tests are byte-identical
 *    unless explicitly enabled via env.
 *  - Per-WhmcsClient-instance (constructed by the client), NOT a global singleton,
 *    so tests do not leak cross-instance. Also explicitly clearable.
 *  - Pure in-memory, no disk. Bounded size (oldest-eviction) to avoid unbounded growth.
 *  - Only actions in the configured allowlist are cacheable, and only when TTL > 0.
 *
 * Date.now() is used here deliberately — that is allowed in src (only workflow
 * scripts forbid it).
 */

/** Hard cap on entries to keep memory bounded regardless of churn. */
export const READ_CACHE_MAX_ENTRIES = 256;

/** Stored cache entry. */
interface CacheEntry<T = unknown> {
  /** Cached, already-normalized read result. */
  value: T;
  /** Absolute epoch ms after which the entry is stale. */
  expiresAt: number;
}

/**
 * Stable JSON stringify: object keys are emitted in sorted order at every depth
 * so that `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same cache key.
 * Arrays preserve order (order is semantically significant for arrays).
 */
function stableStringify(value: unknown): string {
  // `undefined` is not valid JSON; map it to a stable token so distinct param
  // shapes stay distinct (JSON.stringify(undefined) would itself return undefined).
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Build the cache key from an action + its params.
 * Key = action + stable-stringified params.
 */
export function buildCacheKey(action: string, params: Record<string, unknown>): string {
  return `${action}|${stableStringify(params)}`;
}

/**
 * A per-instance, TTL-bounded read cache.
 *
 * When `ttlMs <= 0` the cache is fully disabled: `isCacheable()` returns false,
 * `get()` always misses, and `set()` is a no-op. This is the default posture.
 */
export class ReadCache {
  private readonly ttlMs: number;
  private readonly cacheableActions: ReadonlySet<string>;
  private readonly maxEntries: number;
  /** Map preserves insertion order — used for oldest-first eviction. */
  private readonly store = new Map<string, CacheEntry>();

  constructor(opts: {
    ttlMs: number;
    cacheableActions: readonly string[];
    maxEntries?: number;
  }) {
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 0;
    this.cacheableActions = new Set(opts.cacheableActions);
    this.maxEntries =
      opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : READ_CACHE_MAX_ENTRIES;
  }

  /** True only when caching is enabled (TTL > 0) AND the action is allowlisted. */
  isCacheable(action: string): boolean {
    return this.ttlMs > 0 && this.cacheableActions.has(action);
  }

  /** Whether the cache is enabled at all (TTL > 0). */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /**
   * Look up a cached value. Returns `undefined` on miss / disabled / expired.
   * Expired entries are removed on access.
   */
  get(action: string, params: Record<string, unknown>): unknown {
    if (!this.isCacheable(action)) {
      return undefined;
    }
    const key = buildCacheKey(action, params);
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Hand out an independent copy so a caller that mutates the returned object
    // cannot poison the cached value for the rest of the TTL window.
    return structuredClone(entry.value);
  }

  /**
   * Store a successful read result. No-op when caching is disabled or the action
   * is not allowlisted. Evicts the oldest entry when the size cap is exceeded.
   */
  set(action: string, params: Record<string, unknown>, value: unknown): void {
    if (!this.isCacheable(action)) {
      return;
    }
    const key = buildCacheKey(action, params);
    // Refresh insertion order on re-set so the newest write is "youngest".
    this.store.delete(key);
    // Snapshot at store time so a caller mutating the original object AFTER
    // caching cannot retroactively change the cached value.
    this.store.set(key, { value: structuredClone(value), expiresAt: Date.now() + this.ttlMs });

    // Bounded growth: evict oldest (insertion-order) entries beyond the cap.
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
    }
  }

  /** Remove all entries. Exposed for tests / explicit bypass. */
  clear(): void {
    this.store.clear();
  }

  /** Current number of live (possibly-expired-but-not-yet-evicted) entries. */
  get size(): number {
    return this.store.size;
  }
}
