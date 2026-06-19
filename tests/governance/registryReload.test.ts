/**
 * Registry TTL-cache reload tests.
 *
 * Proves:
 *  (a) Repeated calls within the TTL return the SAME cached object identity.
 *  (b) After the TTL elapses, a changed `MCP_CONSUMER_REGISTRY` env value is
 *      picked up on the next call.
 *
 * Approach: vi.spyOn(Date, 'now') to control the clock without sleeping.
 * __resetRegistryCacheForTests() is called before each test so module-level
 * state is clean (per-file module isolation already gives a fresh null cache,
 * but this is cheap insurance for intra-file ordering).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashToken } from '../../src/governance/consumers.js';
import {
  getConsumerRegistry,
  REGISTRY_CACHE_TTL_MS,
  __resetRegistryCacheForTests,
} from '../../src/governance/pipeline.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const TOKEN_A = 'tok-registry-reload-aaa';
const TOKEN_B = 'tok-registry-reload-bbb';

/** Minimal valid single-consumer registry JSON. */
function makeRegistryJson(id: string, token: string): string {
  return JSON.stringify([
    {
      id,
      token_sha256: hashToken(token),
      defaultContract: 'llm_safe_summary',
      allowedContracts: ['llm_safe_summary'],
      writeCapability: 'false',
    },
  ]);
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  __resetRegistryCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MCP_CONSUMER_REGISTRY;
  __resetRegistryCacheForTests();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('getConsumerRegistry TTL cache', () => {
  it('REGISTRY_CACHE_TTL_MS is a positive finite number (module constant is sane)', () => {
    expect(Number.isFinite(REGISTRY_CACHE_TTL_MS)).toBe(true);
    expect(REGISTRY_CACHE_TTL_MS).toBeGreaterThan(0);
  });

  it('(a) repeated calls within the TTL return the SAME cached array object', () => {
    process.env.MCP_CONSUMER_REGISTRY = makeRegistryJson('consumer_a', TOKEN_A);

    // Freeze clock at t=0.
    const t0 = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    const first = getConsumerRegistry();

    // Advance clock by (TTL - 1 ms) — still within TTL.
    spy.mockReturnValue(t0 + REGISTRY_CACHE_TTL_MS - 1);
    const second = getConsumerRegistry();

    expect(second).toBe(first); // exact same object reference = cache hit
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('consumer_a');
  });

  it('(b) after TTL elapses, a changed env value is reflected', () => {
    process.env.MCP_CONSUMER_REGISTRY = makeRegistryJson('consumer_a', TOKEN_A);

    const t0 = 2_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    const first = getConsumerRegistry();
    expect(first[0].id).toBe('consumer_a');

    // Rotate the registry in the environment.
    process.env.MCP_CONSUMER_REGISTRY = makeRegistryJson('consumer_b', TOKEN_B);

    // Advance clock to exactly TTL — should NOT yet reload (>= check).
    spy.mockReturnValue(t0 + REGISTRY_CACHE_TTL_MS);
    const atTtl = getConsumerRegistry();

    // Advance clock to TTL + 1 ms — should reload.
    spy.mockReturnValue(t0 + REGISTRY_CACHE_TTL_MS + 1);
    const afterTtl = getConsumerRegistry();

    // Cache hit at exactly TTL boundary — same reference as first.
    expect(atTtl).toBe(first);

    // Cache miss after TTL — fresh array, new consumer id.
    expect(afterTtl).not.toBe(first);
    expect(afterTtl).toHaveLength(1);
    expect(afterTtl[0].id).toBe('consumer_b');
  });

  it('__resetRegistryCacheForTests() forces an immediate reload', () => {
    process.env.MCP_CONSUMER_REGISTRY = makeRegistryJson('consumer_a', TOKEN_A);

    const t0 = 3_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);

    const first = getConsumerRegistry();
    expect(first[0].id).toBe('consumer_a');

    // Rotate env and reset without moving the clock.
    process.env.MCP_CONSUMER_REGISTRY = makeRegistryJson('consumer_b', TOKEN_B);
    __resetRegistryCacheForTests();

    const reloaded = getConsumerRegistry();
    expect(reloaded).not.toBe(first);
    expect(reloaded[0].id).toBe('consumer_b');
  });

  it('an empty registry env var yields an empty array (no consumer = deny-all)', () => {
    delete process.env.MCP_CONSUMER_REGISTRY;

    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const reg = getConsumerRegistry();
    expect(reg).toEqual([]);
  });
});
