/**
 * Phase F — append-only audit log tests. In-memory only; never stores tokens.
 *
 * Proves: append + global ordering, per-intent filtering, the auditEvent
 * helper maps intent fields onto an AuditEvent, and no token-bearing field
 * leaks into a recorded event.
 */

import { describe, it, expect } from 'vitest';
import { createDraftIntent } from '../../src/write/intents.js';
import { AuditLog, auditEvent } from '../../src/write/audit.js';

const mk = (consumer: string) =>
  createDraftIntent({
    consumer_id: consumer,
    scope: 'ticket:create',
    params: { subject: 's', message: 'm' },
    naturalKey: `ticket:${consumer}`,
    preconditions: {},
    projected_effect: 'open ticket',
  });

describe('AuditLog', () => {
  it('appends events and preserves insertion order in all()', () => {
    const log = new AuditLog();
    const i1 = mk('c1');
    const i2 = mk('c2');
    log.append(auditEvent('intent.drafted', i1));
    log.append(auditEvent('intent.validated', i1));
    log.append(auditEvent('intent.drafted', i2));
    expect(log.all()).toHaveLength(3);
    expect(log.all().map((e) => e.event)).toEqual([
      'intent.drafted',
      'intent.validated',
      'intent.drafted',
    ]);
  });

  it('filters events for a single intent', () => {
    const log = new AuditLog();
    const i1 = mk('c1');
    const i2 = mk('c2');
    log.append(auditEvent('intent.drafted', i1));
    log.append(auditEvent('intent.drafted', i2));
    log.append(auditEvent('intent.rejected', i1, 'bad input'));
    const forI1 = log.forIntent(i1.intent_id);
    expect(forI1).toHaveLength(2);
    expect(forI1.every((e) => e.intent_id === i1.intent_id)).toBe(true);
    expect(forI1[1]?.detail).toBe('bad input');
  });

  it('auditEvent records consumer_id but no token-bearing fields', () => {
    const intent = mk('c1');
    const ev = auditEvent('intent.drafted', intent);
    expect(ev.consumer_id).toBe('c1');
    expect(ev.idempotency_key).toBe(intent.idempotency_key);
    expect(JSON.stringify(ev).toLowerCase()).not.toMatch(/token|bearer|secret/);
  });
});
