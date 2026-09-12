/**
 * Track C2 — service:change_package + service:upgrade governed write scopes.
 * Covers the frozen-seam action/risk maps, strict param mappers, and validation.
 */
import { describe, it, expect } from 'vitest';
import { WRITE_SCOPES, SCOPE_ACTION, SCOPE_RISK, type WriteIntent } from '../../src/write/types.js';
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
  it('registers service:change_package as ModuleChangePackage / medium', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('service:change_package');
    expect(SCOPE_ACTION['service:change_package']).toBe('ModuleChangePackage');
    expect(SCOPE_RISK['service:change_package']).toBe('medium');
  });

  it('registers service:product:set and service:customfields:update', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('service:product:set');
    expect(SCOPE_ACTION['service:product:set']).toBe('UpdateClientProduct');
    expect(SCOPE_RISK['service:product:set']).toBe('medium');
    expect(WRITE_SCOPES as readonly string[]).toContain('service:customfields:update');
    expect(SCOPE_ACTION['service:customfields:update']).toBe('UpdateClientProduct');
    expect(SCOPE_RISK['service:customfields:update']).toBe('medium');
  });

  it('registers service:upgrade as UpgradeProduct / high', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('service:upgrade');
    expect(SCOPE_ACTION['service:upgrade']).toBe('UpgradeProduct');
    expect(SCOPE_RISK['service:upgrade']).toBe('high');
  });
});

describe('Track C2 strict mappers', () => {
  it('service:change_package emits ONLY {serviceid}, drops extras', () => {
    expect(intentToWhmcsParams('service:change_package', { serviceid: 5, evil: 'x' })).toEqual({
      serviceid: 5,
    });
  });

  it('service:product:set emits serviceid + pid and optional billingcycle', () => {
    expect(
      intentToWhmcsParams('service:product:set', { serviceid: 5, pid: 12, evil: 'x' })
    ).toEqual({
      serviceid: 5,
      pid: 12,
    });
    expect(
      intentToWhmcsParams('service:product:set', { serviceid: 5, pid: 12, billingcycle: 'monthly' })
    ).toEqual({ serviceid: 5, pid: 12, billingcycle: 'monthly' });
  });

  it('service:customfields:update emits base64 PHP-serialized customfields', () => {
    const out = intentToWhmcsParams('service:customfields:update', {
      serviceid: 5,
      customfields: { '12': 'PKG-1', evilobj: undefined },
      evil: 'x',
    });
    expect(out.serviceid).toBe(5);
    expect(typeof out.customfields).toBe('string');
    const decoded = Buffer.from(String(out.customfields), 'base64').toString('utf8');
    expect(decoded).toContain('PKG-1');
    expect(out).not.toHaveProperty('evil');
  });

  it('service:upgrade forwards allowlisted product fields, drops cost overrides + extras', () => {
    const out = intentToWhmcsParams('service:upgrade', {
      serviceid: 5,
      type: 'product',
      newproductid: 10,
      newproductbillingcycle: 'monthly',
      recurringamount: 999,
      evil: 'x',
    });
    expect(out.serviceid).toBe(5);
    expect(out.type).toBe('product');
    expect(out.newproductid).toBe(10);
    expect(out.newproductbillingcycle).toBe('monthly');
    expect(out).not.toHaveProperty('recurringamount');
    expect(out).not.toHaveProperty('evil');
  });
});

describe('Track C2 validation — service:change_package', () => {
  it('accepts a positive-integer serviceid', () => {
    expect(validateIntent(intent('service:change_package', { serviceid: 5 }), {}).ok).toBe(true);
  });

  it('rejects missing / 0 / negative / non-integer serviceid', () => {
    for (const sid of [undefined, 0, -1, 1.5]) {
      const r = validateIntent(intent('service:change_package', { serviceid: sid }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_serviceid')).toBe(true);
    }
  });
});

describe('Track C2 validation — service:product:set / customfields', () => {
  it('accepts pid + serviceid', () => {
    expect(validateIntent(intent('service:product:set', { serviceid: 5, pid: 12 }), {}).ok).toBe(
      true
    );
  });

  it('rejects missing pid', () => {
    const r = validateIntent(intent('service:product:set', { serviceid: 5 }), {});
    expect(r.ok).toBe(false);
  });

  it('accepts a scalar customfields map', () => {
    expect(
      validateIntent(
        intent('service:customfields:update', { serviceid: 5, customfields: { '3': 'x' } }),
        {}
      ).ok
    ).toBe(true);
  });

  it('rejects empty or nested customfields', () => {
    expect(
      validateIntent(intent('service:customfields:update', { serviceid: 5, customfields: {} }), {})
        .ok
    ).toBe(false);
    expect(
      validateIntent(
        intent('service:customfields:update', { serviceid: 5, customfields: { '1': { x: 1 } } }),
        {}
      ).ok
    ).toBe(false);
  });
});

describe('Track C2 validation — service:upgrade', () => {
  it('accepts a valid product upgrade', () => {
    expect(
      validateIntent(
        intent('service:upgrade', { serviceid: 5, type: 'product', newproductid: 10 }),
        {}
      ).ok
    ).toBe(true);
  });

  it('accepts a valid configoptions upgrade', () => {
    expect(
      validateIntent(
        intent('service:upgrade', { serviceid: 5, type: 'configoptions', configoptions: { 1: 2 } }),
        {}
      ).ok
    ).toBe(true);
  });

  it('accepts a valid addon upgrade', () => {
    expect(
      validateIntent(intent('service:upgrade', { serviceid: 5, type: 'addon', addonid: 3 }), {}).ok
    ).toBe(true);
  });

  it('rejects an invalid type', () => {
    const r = validateIntent(intent('service:upgrade', { serviceid: 5, type: 'bogus' }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_upgrade_type')).toBe(true);
  });

  it('rejects type=product missing newproductid', () => {
    const r = validateIntent(intent('service:upgrade', { serviceid: 5, type: 'product' }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_newproductid')).toBe(true);
  });

  it('rejects type=configoptions missing configoptions', () => {
    const r = validateIntent(
      intent('service:upgrade', { serviceid: 5, type: 'configoptions' }),
      {}
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_configoptions')).toBe(true);
  });

  it('rejects type=addon missing addonid', () => {
    const r = validateIntent(intent('service:upgrade', { serviceid: 5, type: 'addon' }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_addonid')).toBe(true);
  });

  it('rejects missing serviceid', () => {
    const r = validateIntent(intent('service:upgrade', { type: 'product', newproductid: 10 }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_serviceid')).toBe(true);
  });
});
