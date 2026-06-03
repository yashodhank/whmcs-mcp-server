/**
 * Phase F — idempotency key + ledger tests. Synthetic only, no WHMCS.
 *
 * Proves: deterministic sha256 hex keys (stable across calls, sensitive to
 * every input + window bucket), ledger duplicate detection, result recall,
 * and windowed expiry that forgets a key after its window elapses.
 */

import { describe, it, expect } from 'vitest';
import { idempotencyKey, IdempotencyLedger } from '../../src/write/idempotency.js';

describe('idempotencyKey', () => {
  it('is deterministic sha256 hex for identical inputs', () => {
    const a = idempotencyKey('consumer-1', 'AddClientNote', 'client_note:write', 'client:42:note', 60000);
    const b = idempotencyKey('consumer-1', 'AddClientNote', 'client_note:write', 'client:42:note', 60000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any input changes', () => {
    const base = idempotencyKey('c', 'A', 's', 'k', 60000);
    expect(idempotencyKey('c2', 'A', 's', 'k', 60000)).not.toBe(base);
    expect(idempotencyKey('c', 'A2', 's', 'k', 60000)).not.toBe(base);
    expect(idempotencyKey('c', 'A', 's', 'k2', 60000)).not.toBe(base);
  });

  it('changes with scope even when action + naturalKey are identical', () => {
    // Two scopes sharing one WHMCS action (service:price_restore and
    // service:domain_rename both → UpdateClientProduct) must NOT collide.
    const a = idempotencyKey('c', 'UpdateClientProduct', 'service:price_restore', 'k', 60000, 0);
    const b = idempotencyKey('c', 'UpdateClientProduct', 'service:domain_rename', 'k', 60000, 0);
    expect(a).not.toBe(b);
  });

  it('buckets keys by time window so different windows differ', () => {
    const w1 = idempotencyKey('c', 'A', 's', 'k', 1000, 0);
    const w2 = idempotencyKey('c', 'A', 's', 'k', 1000, 5000);
    const sameBucket = idempotencyKey('c', 'A', 's', 'k', 1000, 500);
    expect(w1).not.toBe(w2);
    expect(w1).toBe(sameBucket);
  });
});

describe('IdempotencyLedger', () => {
  it('detects duplicates only after record', () => {
    const ledger = new IdempotencyLedger(60000);
    const key = idempotencyKey('c', 'A', 's', 'k', 60000);
    expect(ledger.seen(key)).toBe(false);
    ledger.record(key, { ok: true });
    expect(ledger.seen(key)).toBe(true);
    expect(ledger.getResult(key)).toEqual({ ok: true });
  });

  it('forgets a key after its window expires', () => {
    let now = 1_000;
    const ledger = new IdempotencyLedger(1000, () => now);
    const key = idempotencyKey('c', 'A', 's', 'k', 1000);
    ledger.record(key, 'r');
    expect(ledger.seen(key)).toBe(true);
    now = 2_500;
    expect(ledger.seen(key)).toBe(false);
    expect(ledger.getResult(key)).toBeUndefined();
  });
});
