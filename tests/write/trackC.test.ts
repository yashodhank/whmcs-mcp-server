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

  it('registers the two governed money scopes (capture/apply) as high-risk', () => {
    const expectMoney: Record<string, [string, string]> = {
      'billing:payment:capture': ['CapturePayment', 'high'],
      'billing:credit:apply': ['ApplyCredit', 'high'],
    };
    for (const [scope, [action, risk]] of Object.entries(expectMoney)) {
      expect(WRITE_SCOPES as readonly string[]).toContain(scope);
      expect(SCOPE_ACTION[scope as keyof typeof SCOPE_ACTION]).toBe(action);
      expect(SCOPE_RISK[scope as keyof typeof SCOPE_RISK]).toBe(risk);
    }
  });

  it('registers the governed domain/order scopes with correct action + risk', () => {
    const expectDomainOrder: Record<string, [string, string]> = {
      'domain:register': ['DomainRegister', 'high'],
      'domain:renew': ['DomainRenew', 'high'],
      'order:accept': ['AcceptOrder', 'medium'],
    };
    for (const [scope, [action, risk]] of Object.entries(expectDomainOrder)) {
      expect(WRITE_SCOPES as readonly string[]).toContain(scope);
      expect(SCOPE_ACTION[scope as keyof typeof SCOPE_ACTION]).toBe(action);
      expect(SCOPE_RISK[scope as keyof typeof SCOPE_RISK]).toBe(risk);
    }
  });

  it('domain transfer stays blocked — no domain:transfer scope, action permanently blocked', () => {
    expect(WRITE_SCOPES as readonly string[]).not.toContain('domain:transfer');
    expect(PROD_NEVER_EXECUTABLE.has('DomainTransfer')).toBe(true);
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('domain:transfer')).toBe(true);
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

  it('billing:payment:capture emits ONLY invoiceid, NEVER cvv, drops extras', () => {
    const out = intentToWhmcsParams('billing:payment:capture', {
      invoiceid: 42,
      cvv: '123',
      amount: 99,
      gateway: 'stripe',
    });
    expect(out).toEqual({ invoiceid: 42 });
    expect(out).not.toHaveProperty('cvv');
  });

  it('billing:credit:apply emits ONLY {invoiceid, amount}, drops extras', () => {
    expect(
      intentToWhmcsParams('billing:credit:apply', { invoiceid: 42, amount: 25, evil: 'x' })
    ).toEqual({ invoiceid: 42, amount: 25 });
  });

  it('domain:register emits domainid + normalized ns1..nsN, drops extras/blanks', () => {
    expect(
      intentToWhmcsParams('domain:register', {
        domainid: 7,
        ns1: 'NS1.Example.COM',
        ns2: ' ns2.example.com ',
        ns3: '   ',
        cost: 99,
        status: 'Active',
      })
    ).toEqual({ domainid: 7, ns1: 'ns1.example.com', ns2: 'ns2.example.com' });
    // domainid only — no ns keys when none supplied.
    expect(intentToWhmcsParams('domain:register', { domainid: 7 })).toEqual({ domainid: 7 });
  });

  it('domain:renew emits ONLY {domainid, regperiod}, drops extras', () => {
    expect(
      intentToWhmcsParams('domain:renew', { domainid: 7, regperiod: 2, evil: 'x' })
    ).toEqual({ domainid: 7, regperiod: 2 });
  });

  it('order:accept emits ONLY {orderid}, drops fraud/provisioning flags', () => {
    const out = intentToWhmcsParams('order:accept', {
      orderid: 42,
      fraudbypass: true,
      autosetup: true,
      sendemail: true,
      serverid: 3,
    });
    expect(out).toEqual({ orderid: 42 });
    expect(out).not.toHaveProperty('fraudbypass');
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

  it('billing:payment:capture requires a positive-integer invoiceid', () => {
    expect(validateIntent(intent('billing:payment:capture', { invoiceid: 1 }), {}).ok).toBe(true);
    for (const inv of [0, -1, 1.5, '1', undefined]) {
      const r = validateIntent(intent('billing:payment:capture', { invoiceid: inv }), {});
      expect(r.ok).toBe(false);
    }
  });

  it('billing:credit:apply requires invoiceid + positive amount', () => {
    expect(
      validateIntent(intent('billing:credit:apply', { invoiceid: 1, amount: 10 }), {}).ok
    ).toBe(true);
    // missing amount
    expect(validateIntent(intent('billing:credit:apply', { invoiceid: 1 }), {}).ok).toBe(false);
    // non-positive amount
    for (const amt of [0, -5]) {
      const r = validateIntent(intent('billing:credit:apply', { invoiceid: 1, amount: amt }), {});
      expect(r.ok).toBe(false);
    }
    // bad invoiceid
    expect(
      validateIntent(intent('billing:credit:apply', { invoiceid: 0, amount: 10 }), {}).ok
    ).toBe(false);
  });

  it('domain:register requires positive-int domainid; optional ns must be valid', () => {
    expect(validateIntent(intent('domain:register', { domainid: 7 }), {}).ok).toBe(true);
    expect(
      validateIntent(
        intent('domain:register', { domainid: 7, ns1: 'ns1.x.com', ns2: 'ns2.x.com' }),
        {}
      ).ok
    ).toBe(true);
    for (const did of [0, -1, 1.5, '1', undefined]) {
      const r = validateIntent(intent('domain:register', { domainid: did }), {});
      expect(r.ok).toBe(false);
    }
    // malformed nameserver
    const bad = validateIntent(
      intent('domain:register', { domainid: 7, ns1: 'http://bad' }),
      {}
    );
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.code === 'invalid_nameserver')).toBe(true);
  });

  it('domain:renew requires positive-int domainid + regperiod 1..10', () => {
    expect(validateIntent(intent('domain:renew', { domainid: 7, regperiod: 1 }), {}).ok).toBe(true);
    expect(validateIntent(intent('domain:renew', { domainid: 7, regperiod: 10 }), {}).ok).toBe(
      true
    );
    // bad regperiod
    for (const rp of [0, 11, 2.5, '2', undefined]) {
      const r = validateIntent(intent('domain:renew', { domainid: 7, regperiod: rp }), {});
      expect(r.ok).toBe(false);
    }
    // bad domainid
    expect(validateIntent(intent('domain:renew', { domainid: 0, regperiod: 2 }), {}).ok).toBe(
      false
    );
  });

  it('order:accept requires a positive-integer orderid', () => {
    expect(validateIntent(intent('order:accept', { orderid: 42 }), {}).ok).toBe(true);
    for (const oid of [0, -1, 1.5, '1', undefined]) {
      const r = validateIntent(intent('order:accept', { orderid: oid }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_orderid')).toBe(true);
    }
  });
});
