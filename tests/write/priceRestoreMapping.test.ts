import { describe, it, expect } from 'vitest';
import {
  intentToWhmcsParams,
  mapServicePriceRestoreTarget,
  PRICE_RESTORE_RECURRING_FIELD,
} from '../../src/write/paramMapping.js';

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
