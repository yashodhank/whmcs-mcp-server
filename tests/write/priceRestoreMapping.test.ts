import { describe, it, expect } from 'vitest';
import {
  intentToWhmcsParams,
  mapServicePriceRestoreTarget,
  PRICE_RESTORE_RECURRING_FIELD,
} from '../../src/write/paramMapping.js';
import {
  assertPriceRestoreOutput,
  PriceRestoreOutputAssertionError,
} from '../../src/tools/writeFlow.js';

describe('mapServicePriceRestoreTarget', () => {
  it('returns exactly { serviceid, <recurring-field>: new_amount }', () => {
    const out = mapServicePriceRestoreTarget({ serviceid: 555, new_amount: 31350 });
    expect(Object.keys(out).sort()).toEqual(['serviceid', PRICE_RESTORE_RECURRING_FIELD].sort());
    expect(out.serviceid).toBe(555);
    expect(out[PRICE_RESTORE_RECURRING_FIELD]).toBe(31350);
  });

  it('ignores extra fields on the target input (defense in depth)', () => {
    const out = mapServicePriceRestoreTarget({
      serviceid: 555,
      new_amount: 31350,
      domainstatus: 'Terminated',
      paymentmethod: 'evil',
      billingcycle: 'Annually',
    } as never);
    expect(Object.keys(out).sort()).toEqual(['serviceid', PRICE_RESTORE_RECURRING_FIELD].sort());
  });

  it('passes serviceid and new_amount through without coercion', () => {
    const out = mapServicePriceRestoreTarget({ serviceid: 1, new_amount: 0.01 });
    expect(out.serviceid).toBe(1);
    expect(out[PRICE_RESTORE_RECURRING_FIELD]).toBe(0.01);
  });
});

describe('intentToWhmcsParams dispatcher: service:price_restore defensive case', () => {
  it('throws — the dispatcher does not support batch scopes', () => {
    expect(() =>
      intentToWhmcsParams('service:price_restore', { targets: [{ serviceid: 1, new_amount: 100 }] })
    ).toThrow(/batch.*mapServicePriceRestoreTarget/i);
  });
});

describe('assertPriceRestoreOutput (defense-in-depth)', () => {
  it('passes when output is exactly { serviceid, <recurring-field> }', () => {
    expect(() =>
      assertPriceRestoreOutput({ serviceid: 555, [PRICE_RESTORE_RECURRING_FIELD]: 31350 })
    ).not.toThrow();
  });

  it('throws on any extra key (e.g., a leak of domainstatus)', () => {
    expect(() =>
      assertPriceRestoreOutput({
        serviceid: 555,
        [PRICE_RESTORE_RECURRING_FIELD]: 31350,
        domainstatus: 'Terminated',
      })
    ).toThrow(PriceRestoreOutputAssertionError);
  });

  it('throws on missing serviceid', () => {
    expect(() =>
      assertPriceRestoreOutput({ [PRICE_RESTORE_RECURRING_FIELD]: 31350 })
    ).toThrow(PriceRestoreOutputAssertionError);
  });

  it('throws on missing recurring-amount field', () => {
    expect(() => assertPriceRestoreOutput({ serviceid: 555 })).toThrow(
      PriceRestoreOutputAssertionError
    );
  });
});
