/**
 * Track C2 — support-ticket write scopes (ticket:note, ticket:merge) in the
 * governed tiered model. Covers the frozen-seam action/risk maps, the STRICT
 * param mappers, and validation.
 */
import { describe, it, expect } from 'vitest';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  type WriteIntent,
} from '../../src/write/types.js';
import { intentToWhmcsParams } from '../../src/write/paramMapping.js';
import { validateIntent } from '../../src/write/validation.js';

function intent(scope: WriteIntent['scope'], params: Record<string, unknown>): WriteIntent {
  return {
    intent_id: 'i',
    consumer_id: 'c',
    scope,
    action: SCOPE_ACTION[scope],
    risk: SCOPE_RISK[scope],
    params,
    idempotency_key: 'k',
    preconditions: {},
    projected_effect: 'x',
    state: 'draft',
    created_at: '2026-06-03T00:00:00.000Z',
    expires_at: '2026-06-03T01:00:00.000Z',
  };
}

describe('Track C2 frozen-seam additions', () => {
  it('registers ticket:note with correct action + risk', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('ticket:note');
    expect(SCOPE_ACTION['ticket:note']).toBe('AddTicketNote');
    expect(SCOPE_RISK['ticket:note']).toBe('low');
  });

  it('registers ticket:merge with correct action + risk', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('ticket:merge');
    expect(SCOPE_ACTION['ticket:merge']).toBe('MergeTicket');
    expect(SCOPE_RISK['ticket:merge']).toBe('medium');
  });
});

describe('Track C2 strict mappers', () => {
  it('ticket:note emits ONLY {ticketid, message}, drops markdown/adminid extras', () => {
    expect(
      intentToWhmcsParams('ticket:note', {
        ticketid: 8,
        message: 'hi',
        markdown: true,
        adminid: 1,
      })
    ).toEqual({ ticketid: 8, message: 'hi' });
  });

  it('ticket:merge emits {ticketid, mergeticketids: comma-joined string}', () => {
    expect(
      intentToWhmcsParams('ticket:merge', { ticketid: 8, mergeticketids: [9, 10] })
    ).toEqual({ ticketid: 8, mergeticketids: '9,10' });
  });
});

describe('Track C2 validation', () => {
  it('ticket:note accepts a positive-int ticketid + non-empty message', () => {
    expect(validateIntent(intent('ticket:note', { ticketid: 8, message: 'hi' }), {}).ok).toBe(true);
  });

  it('ticket:note rejects missing message', () => {
    const r = validateIntent(intent('ticket:note', { ticketid: 8 }), {});
    expect(r.ok).toBe(false);
  });

  it('ticket:note rejects a missing/zero/negative/non-int ticketid', () => {
    expect(validateIntent(intent('ticket:note', { message: 'hi' }), {}).ok).toBe(false);
    for (const tid of [0, -1, 1.5, '1']) {
      const r = validateIntent(intent('ticket:note', { ticketid: tid, message: 'hi' }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_ticketid')).toBe(true);
    }
  });

  it('ticket:merge accepts a positive-int ticketid + non-empty mergeticketids', () => {
    expect(
      validateIntent(intent('ticket:merge', { ticketid: 8, mergeticketids: [9, 10] }), {}).ok
    ).toBe(true);
  });

  it('ticket:merge rejects empty/missing mergeticketids array', () => {
    expect(
      validateIntent(intent('ticket:merge', { ticketid: 8, mergeticketids: [] }), {}).ok
    ).toBe(false);
    expect(validateIntent(intent('ticket:merge', { ticketid: 8 }), {}).ok).toBe(false);
  });

  it('ticket:merge rejects a non-positive-int element', () => {
    for (const bad of [0, -1, 2.5, '9']) {
      const r = validateIntent(intent('ticket:merge', { ticketid: 8, mergeticketids: [bad] }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_mergeticketids')).toBe(true);
    }
  });

  it('ticket:merge rejects an element equal to the primary ticketid', () => {
    const r = validateIntent(intent('ticket:merge', { ticketid: 8, mergeticketids: [8] }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_mergeticketids')).toBe(true);
  });

  it('ticket:merge rejects a bad ticketid', () => {
    for (const tid of [0, -1, 1.5, '1']) {
      const r = validateIntent(intent('ticket:merge', { ticketid: tid, mergeticketids: [9] }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_ticketid')).toBe(true);
    }
  });
});
