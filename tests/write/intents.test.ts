/**
 * Phase F — draft intent factory + in-memory IntentStore tests.
 *
 * Proves: draft shape (uuid id, ISO timestamps, derived risk/action from the
 * frozen SCOPE_* maps, deterministic idempotency_key), the validated write
 * state machine (legal transitions succeed, illegal throw), get semantics,
 * and TTL prune of expired drafts. No WHMCS.
 */

import { describe, it, expect } from 'vitest';
import { createDraftIntent, IntentStore } from '../../src/write/intents.js';

const baseInput = {
  consumer_id: 'consumer-1',
  scope: 'client_note:write' as const,
  params: { clientid: 42, note: 'hello' },
  naturalKey: 'client:42:note:hello',
  preconditions: { client_exists: true },
  projected_effect: 'Append a private note to client 42',
};

describe('createDraftIntent', () => {
  it('produces a draft with derived risk/action and ISO timestamps', () => {
    const intent = createDraftIntent(baseInput);
    expect(intent.state).toBe('draft');
    expect(intent.scope).toBe('client_note:write');
    expect(intent.action).toBe('AddClientNote');
    expect(intent.risk).toBe('low');
    expect(intent.intent_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(new Date(intent.created_at).toISOString()).toBe(intent.created_at);
    expect(new Date(intent.expires_at).toISOString()).toBe(intent.expires_at);
    expect(Date.parse(intent.expires_at)).toBeGreaterThan(Date.parse(intent.created_at));
    expect(intent.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives high risk + CreateInvoice/AddTransaction for billing scopes', () => {
    const refund = createDraftIntent({ ...baseInput, scope: 'billing:refund:record' });
    expect(refund.risk).toBe('high');
    expect(refund.action).toBe('AddTransaction');
    const inv = createDraftIntent({ ...baseInput, scope: 'billing:invoice:create' });
    expect(inv.risk).toBe('medium');
    expect(inv.action).toBe('CreateInvoice');
  });

  it('computes a deterministic idempotency_key for identical natural keys', () => {
    const a = createDraftIntent(baseInput);
    const b = createDraftIntent(baseInput);
    expect(a.idempotency_key).toBe(b.idempotency_key);
    expect(a.intent_id).not.toBe(b.intent_id);
  });
});

describe('IntentStore', () => {
  it('put/get round-trips and returns undefined for unknown', () => {
    const store = new IntentStore();
    const intent = createDraftIntent(baseInput);
    store.put(intent);
    expect(store.get(intent.intent_id)).toEqual(intent);
    expect(store.get('nope')).toBeUndefined();
  });

  it('allows legal state-machine transitions', () => {
    const store = new IntentStore();
    const intent = createDraftIntent(baseInput);
    store.put(intent);
    const validated = store.transition(intent.intent_id, 'validated');
    expect(validated.state).toBe('validated');
    const approved = store.transition(intent.intent_id, 'approved');
    expect(approved.state).toBe('approved');
    const blocked = store.transition(intent.intent_id, 'execution_blocked');
    expect(blocked.state).toBe('execution_blocked');
  });

  it('throws on an illegal transition', () => {
    const store = new IntentStore();
    const intent = createDraftIntent(baseInput);
    store.put(intent);
    expect(() => store.transition(intent.intent_id, 'executed')).toThrow();
    store.transition(intent.intent_id, 'validated');
    expect(() => store.transition(intent.intent_id, 'verified')).toThrow();
  });

  it('throws transitioning an unknown intent', () => {
    const store = new IntentStore();
    expect(() => store.transition('missing', 'validated')).toThrow();
  });

  it('prunes expired drafts', () => {
    let now = 10_000;
    const store = new IntentStore(() => now);
    const intent = createDraftIntent({ ...baseInput, ttlMs: 1000 }, () => now);
    store.put(intent);
    expect(store.get(intent.intent_id)).toBeDefined();
    now = 12_000;
    store.prune();
    expect(store.get(intent.intent_id)).toBeUndefined();
  });
});
