/**
 * Track C — service lifecycle + domain nameserver scopes migrated into the
 * governed tiered model. Covers the frozen-seam maps, strict param mappers,
 * and validation. (Gate behavior — terminate permanently blocked, suspend
 * audit-gated — is covered in executionGate.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  PROD_NEVER_EXECUTABLE,
  PROD_NEVER_EXECUTABLE_SCOPES,
  type WriteIntent,
} from '../../src/write/types.js';
import { intentToWhmcsParams } from '../../src/write/paramMapping.js';
import { validateIntent } from '../../src/write/validation.js';

describe('Track C frozen-seam additions', () => {
  it('registers the four scopes with correct action + risk', () => {
    const expect4: Record<string, [string, string]> = {
      'service:suspend': ['ModuleSuspend', 'medium'],
      'service:unsuspend': ['ModuleUnsuspend', 'medium'],
      'service:terminate': ['ModuleTerminate', 'high'],
      'domain:nameservers:update': ['DomainUpdateNameservers', 'medium'],
    };
    for (const [scope, [action, risk]] of Object.entries(expect4)) {
      expect(WRITE_SCOPES as readonly string[]).toContain(scope);
      expect(SCOPE_ACTION[scope as keyof typeof SCOPE_ACTION]).toBe(action);
      expect(SCOPE_RISK[scope as keyof typeof SCOPE_RISK]).toBe(risk);
    }
  });

  it('terminate is permanently blocked at BOTH action and scope level', () => {
    expect(PROD_NEVER_EXECUTABLE.has('ModuleTerminate')).toBe(true);
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('service:terminate')).toBe(true);
  });
});

describe('Track C strict mappers', () => {
  it('service:suspend emits serviceid (+ suspendreason only when non-empty), drops extras', () => {
    expect(intentToWhmcsParams('service:suspend', { serviceid: 5, evil: 'x' })).toEqual({
      serviceid: 5,
    });
    expect(
      intentToWhmcsParams('service:suspend', { serviceid: 5, suspendreason: 'abuse' })
    ).toEqual({ serviceid: 5, suspendreason: 'abuse' });
    expect(intentToWhmcsParams('service:suspend', { serviceid: 5, suspendreason: '  ' })).toEqual({
      serviceid: 5,
    });
  });

  it('service:unsuspend / service:terminate emit only serviceid', () => {
    expect(intentToWhmcsParams('service:unsuspend', { serviceid: 9, status: 'x' })).toEqual({
      serviceid: 9,
    });
    expect(intentToWhmcsParams('service:terminate', { serviceid: 9, foo: 1 })).toEqual({
      serviceid: 9,
    });
  });

  it('domain:nameservers:update maps array → ns1..nsN (normalized), drops extras', () => {
    expect(
      intentToWhmcsParams('domain:nameservers:update', {
        domainid: 7,
        nameservers: ['NS1.Example.COM', 'ns2.example.com'],
        recurringamount: 999,
      })
    ).toEqual({ domainid: 7, ns1: 'ns1.example.com', ns2: 'ns2.example.com' });
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

describe('Track C validation', () => {
  it('service ops require a positive-integer serviceid', () => {
    expect(validateIntent(intent('service:suspend', { serviceid: 1 }), {}).ok).toBe(true);
    for (const sid of [0, -1, 1.5, '1']) {
      const r = validateIntent(intent('service:terminate', { serviceid: sid }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_serviceid')).toBe(true);
    }
  });

  it('domain:nameservers:update requires domainid + 2..5 valid hostnames', () => {
    expect(
      validateIntent(
        intent('domain:nameservers:update', { domainid: 7, nameservers: ['ns1.x.com', 'ns2.x.com'] }),
        {}
      ).ok
    ).toBe(true);
    // too few
    expect(
      validateIntent(intent('domain:nameservers:update', { domainid: 7, nameservers: ['ns1.x.com'] }), {})
        .ok
    ).toBe(false);
    // too many
    expect(
      validateIntent(
        intent('domain:nameservers:update', {
          domainid: 7,
          nameservers: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'],
        }),
        {}
      ).ok
    ).toBe(false);
    // malformed hostname
    expect(
      validateIntent(
        intent('domain:nameservers:update', { domainid: 7, nameservers: ['ns1.x.com', 'http://bad'] }),
        {}
      ).ok
    ).toBe(false);
    // bad domainid
    expect(
      validateIntent(
        intent('domain:nameservers:update', { domainid: 0, nameservers: ['ns1.x.com', 'ns2.x.com'] }),
        {}
      ).ok
    ).toBe(false);
  });
});
