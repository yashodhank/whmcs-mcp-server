import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReadCache,
  buildCacheKey,
  READ_CACHE_MAX_ENTRIES,
} from '../../src/whmcs/readCache.js';

const STATIC = ['GetTLDPricing', 'GetRegistrars', 'GetProducts'];

describe('readCache — buildCacheKey', () => {
  it('is stable across param key ordering', () => {
    const a = buildCacheKey('GetProducts', { pid: 1, gid: 2 });
    const b = buildCacheKey('GetProducts', { gid: 2, pid: 1 });
    expect(a).toBe(b);
  });

  it('distinguishes by action and by param value', () => {
    expect(buildCacheKey('GetProducts', {})).not.toBe(buildCacheKey('GetRegistrars', {}));
    expect(buildCacheKey('GetProducts', { pid: 1 })).not.toBe(
      buildCacheKey('GetProducts', { pid: 2 })
    );
  });

  it('treats array order as significant', () => {
    expect(buildCacheKey('X', { a: [1, 2] })).not.toBe(buildCacheKey('X', { a: [2, 1] }));
  });

  it('handles nested objects stably', () => {
    const a = buildCacheKey('X', { nested: { z: 1, a: 2 } });
    const b = buildCacheKey('X', { nested: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });
});

describe('readCache — disabled by default (TTL 0)', () => {
  it('does not cache when ttl is 0', () => {
    const cache = new ReadCache({ ttlMs: 0, cacheableActions: STATIC });
    expect(cache.enabled).toBe(false);
    expect(cache.isCacheable('GetProducts')).toBe(false);
    cache.set('GetProducts', {}, { result: 'success' });
    expect(cache.size).toBe(0);
    expect(cache.get('GetProducts', {})).toBeUndefined();
  });

  it('treats negative / non-finite ttl as disabled', () => {
    expect(new ReadCache({ ttlMs: -5, cacheableActions: STATIC }).enabled).toBe(false);
    expect(new ReadCache({ ttlMs: NaN, cacheableActions: STATIC }).enabled).toBe(false);
  });
});

describe('readCache — enabled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches only allowlisted actions', () => {
    const cache = new ReadCache({ ttlMs: 1000, cacheableActions: STATIC });
    expect(cache.isCacheable('GetProducts')).toBe(true);
    expect(cache.isCacheable('GetClientsDetails')).toBe(false);

    cache.set('GetClientsDetails', {}, { x: 1 });
    expect(cache.get('GetClientsDetails', {})).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('returns a cached value within TTL and expires after it', () => {
    const cache = new ReadCache({ ttlMs: 1000, cacheableActions: STATIC });
    cache.set('GetProducts', { pid: 1 }, { result: 'ok', n: 42 });

    expect(cache.get('GetProducts', { pid: 1 })).toEqual({ result: 'ok', n: 42 });

    // still valid just before expiry
    vi.advanceTimersByTime(999);
    expect(cache.get('GetProducts', { pid: 1 })).toEqual({ result: 'ok', n: 42 });

    // expired at/after TTL
    vi.advanceTimersByTime(1);
    expect(cache.get('GetProducts', { pid: 1 })).toBeUndefined();
    // expired entry was evicted on access
    expect(cache.size).toBe(0);
  });

  it('keys by params — different params miss', () => {
    const cache = new ReadCache({ ttlMs: 1000, cacheableActions: STATIC });
    cache.set('GetProducts', { pid: 1 }, 'A');
    expect(cache.get('GetProducts', { pid: 2 })).toBeUndefined();
    expect(cache.get('GetProducts', { pid: 1 })).toBe('A');
  });

  it('clear() empties the cache', () => {
    const cache = new ReadCache({ ttlMs: 1000, cacheableActions: STATIC });
    cache.set('GetProducts', {}, 'A');
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('GetProducts', {})).toBeUndefined();
  });

  it('is bounded — evicts oldest beyond the cap', () => {
    const cache = new ReadCache({
      ttlMs: 10000,
      cacheableActions: ['GetProducts'],
      maxEntries: 3,
    });
    cache.set('GetProducts', { pid: 1 }, '1');
    cache.set('GetProducts', { pid: 2 }, '2');
    cache.set('GetProducts', { pid: 3 }, '3');
    cache.set('GetProducts', { pid: 4 }, '4'); // evicts pid:1 (oldest)

    expect(cache.size).toBe(3);
    expect(cache.get('GetProducts', { pid: 1 })).toBeUndefined();
    expect(cache.get('GetProducts', { pid: 4 })).toBe('4');
  });

  it('uses the default cap when none provided', () => {
    const cache = new ReadCache({ ttlMs: 10000, cacheableActions: ['GetProducts'] });
    for (let i = 0; i < READ_CACHE_MAX_ENTRIES + 50; i++) {
      cache.set('GetProducts', { pid: i }, String(i));
    }
    expect(cache.size).toBe(READ_CACHE_MAX_ENTRIES);
  });

  it('re-set refreshes recency so it is not the next eviction victim', () => {
    const cache = new ReadCache({
      ttlMs: 10000,
      cacheableActions: ['GetProducts'],
      maxEntries: 2,
    });
    cache.set('GetProducts', { pid: 1 }, 'old');
    cache.set('GetProducts', { pid: 2 }, '2');
    cache.set('GetProducts', { pid: 1 }, 'new'); // refresh pid:1 recency
    cache.set('GetProducts', { pid: 3 }, '3'); // should evict pid:2, not pid:1

    expect(cache.get('GetProducts', { pid: 2 })).toBeUndefined();
    expect(cache.get('GetProducts', { pid: 1 })).toBe('new');
    expect(cache.get('GetProducts', { pid: 3 })).toBe('3');
  });

  // ── M2 regression: cache must not be poisoned by caller mutation ──────────
  it('mutating the RETURNED value does not poison the cached copy', () => {
    const cache = new ReadCache({ ttlMs: 1000, cacheableActions: ['GetProducts'] });
    cache.set('GetProducts', {}, { products: [{ id: 1 }], n: 1 });
    const first = cache.get('GetProducts', {}) as { products: { id: number }[]; n: number };
    first.products.push({ id: 999 });
    first.n = 42;
    const second = cache.get('GetProducts', {}) as { products: unknown[]; n: number };
    expect(second).toEqual({ products: [{ id: 1 }], n: 1 });
  });

  it('mutating the ORIGINAL object after set does not change the cached copy', () => {
    const cache = new ReadCache({ ttlMs: 1000, cacheableActions: ['GetProducts'] });
    const original = { products: [{ id: 1 }] };
    cache.set('GetProducts', {}, original);
    original.products.push({ id: 2 });
    expect(cache.get('GetProducts', {})).toEqual({ products: [{ id: 1 }] });
  });

  it('two cache instances do not share state (per-instance isolation)', () => {
    const a = new ReadCache({ ttlMs: 1000, cacheableActions: ['GetProducts'] });
    const b = new ReadCache({ ttlMs: 1000, cacheableActions: ['GetProducts'] });
    a.set('GetProducts', {}, 'A');
    expect(b.get('GetProducts', {})).toBeUndefined();
  });
});
