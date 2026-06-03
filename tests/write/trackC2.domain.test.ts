/**
 * Track C2 — governed domain toggle scopes (idprotect, registrar lock) in the
 * tiered model. Covers the frozen-seam action/risk maps, strict boolean-
 * normalizing param mappers, and validation (booleans, including the valid
 * `false` case, plus domainid checks).
 */
import { describe, it, expect } from 'vitest';
import { SCOPE_ACTION, SCOPE_RISK, type WriteIntent } from '../../src/write/types.js';
import { intentToWhmcsParams } from '../../src/write/paramMapping.js';
import { validateIntent } from '../../src/write/validation.js';

describe('Track C2 frozen-seam: domain toggle action + risk', () => {
  it('domain:idprotect:toggle → DomainToggleIdProtect, low risk', () => {
    expect(SCOPE_ACTION['domain:idprotect:toggle']).toBe('DomainToggleIdProtect');
    expect(SCOPE_RISK['domain:idprotect:toggle']).toBe('low');
  });

  it('domain:lock:toggle → DomainUpdateLockingStatus, medium risk', () => {
    expect(SCOPE_ACTION['domain:lock:toggle']).toBe('DomainUpdateLockingStatus');
    expect(SCOPE_RISK['domain:lock:toggle']).toBe('medium');
  });
});

describe('Track C2 strict mappers', () => {
  it('domain:idprotect:toggle emits ONLY {domainid, idprotect:true}, drops extras', () => {
    expect(
      intentToWhmcsParams('domain:idprotect:toggle', { domainid: 7, idprotect: true, evil: 'x' })
    ).toEqual({ domainid: 7, idprotect: true });
  });

  it('domain:idprotect:toggle normalizes idprotect:false → {domainid, idprotect:false}', () => {
    expect(
      intentToWhmcsParams('domain:idprotect:toggle', { domainid: 7, idprotect: false })
    ).toEqual({ domainid: 7, idprotect: false });
  });

  it('domain:idprotect:toggle normalizes a non-boolean idprotect via === true ⇒ false', () => {
    expect(
      intentToWhmcsParams('domain:idprotect:toggle', { domainid: 7, idprotect: 'yes' })
    ).toEqual({ domainid: 7, idprotect: false });
  });

  it('domain:lock:toggle emits ONLY {domainid, lockstatus:true}, drops extras', () => {
    expect(
      intentToWhmcsParams('domain:lock:toggle', { domainid: 7, lockstatus: true, evil: 'x' })
    ).toEqual({ domainid: 7, lockstatus: true });
  });

  it('domain:lock:toggle normalizes lockstatus:false → {domainid, lockstatus:false}', () => {
    expect(
      intentToWhmcsParams('domain:lock:toggle', { domainid: 7, lockstatus: false })
    ).toEqual({ domainid: 7, lockstatus: false });
  });
});

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

describe('Track C2 validation', () => {
  it('domain:idprotect:toggle accepts boolean idprotect (true AND false)', () => {
    expect(validateIntent(intent('domain:idprotect:toggle', { domainid: 7, idprotect: true }), {}).ok).toBe(
      true
    );
    expect(
      validateIntent(intent('domain:idprotect:toggle', { domainid: 7, idprotect: false }), {}).ok
    ).toBe(true);
  });

  it('domain:idprotect:toggle rejects non-boolean idprotect', () => {
    for (const v of ['yes', 1]) {
      const r = validateIntent(intent('domain:idprotect:toggle', { domainid: 7, idprotect: v }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_idprotect')).toBe(true);
    }
  });

  it('domain:idprotect:toggle rejects missing/zero/negative domainid', () => {
    for (const did of [0, -1, undefined]) {
      const r = validateIntent(intent('domain:idprotect:toggle', { domainid: did, idprotect: true }), {});
      expect(r.ok).toBe(false);
    }
  });

  it('domain:lock:toggle accepts boolean lockstatus (true AND false)', () => {
    expect(validateIntent(intent('domain:lock:toggle', { domainid: 7, lockstatus: true }), {}).ok).toBe(
      true
    );
    expect(validateIntent(intent('domain:lock:toggle', { domainid: 7, lockstatus: false }), {}).ok).toBe(
      true
    );
  });

  it('domain:lock:toggle rejects non-boolean lockstatus', () => {
    for (const v of ['yes', 1]) {
      const r = validateIntent(intent('domain:lock:toggle', { domainid: 7, lockstatus: v }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_lockstatus')).toBe(true);
    }
  });

  it('domain:lock:toggle rejects missing/zero/negative domainid', () => {
    for (const did of [0, -1, undefined]) {
      const r = validateIntent(intent('domain:lock:toggle', { domainid: did, lockstatus: true }), {});
      expect(r.ok).toBe(false);
    }
  });
});
