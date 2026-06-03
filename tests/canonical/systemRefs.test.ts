/**
 * B1 — canonical WHMCS system-reference mappers. Synthetic fixtures ONLY.
 *
 * GetCurrencies / GetPaymentMethods / WhmcsDetails are GLOBAL/admin reads of
 * install-level reference data (currency table, gateway labels, version). They
 * are not client-scoped and carry no per-customer PII. All three reuse the
 * EXISTING frozen 'activity' entity (the union is NOT extended), exactly as the
 * GetStats mapper does. Single object per response — no plural form. Fake data
 * only.
 */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalCurrencies,
  mapToCanonicalPaymentMethods,
  mapToCanonicalWhmcsDetails,
} from '../../src/canonical/systemRefs.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalCurrencies', () => {
  it('maps the WHMCS currencies.currency[] shape with field classes', () => {
    const c = mapToCanonicalCurrencies({
      result: 'success',
      currencies: {
        currency: [
          {
            id: '1',
            code: 'USD',
            prefix: '$',
            suffix: '',
            format: '1',
            rate: '1.00000',
            default: '1',
          },
          {
            id: '2',
            code: 'EUR',
            prefix: '€',
            suffix: '',
            format: '2',
            rate: '0.92000',
            default: '0',
          },
        ],
      },
    });
    expect(c.entity).toBe('activity');
    expect(c.data.currencies).toHaveLength(2);
    expect(c.data.currencies[0]).toEqual({
      id: 1,
      code: 'USD',
      prefix: '$',
      suffix: '',
      format: '1',
      rate: 1,
      isDefault: true,
    });
    expect(c.data.currencies[1].rate).toBe(0.92);
    expect(c.data.currencies[1].isDefault).toBe(false);

    expect(c.classes['currencies[].id']).toBe('business.identifier');
    expect(c.classes['currencies[].code']).toBe('business.identifier');
    expect(c.classes['currencies[].prefix']).toBe('business.label');
    expect(c.classes['currencies[].format']).toBe('business.label');
    expect(c.classes['currencies[].rate']).toBe('financial.amount');
    expect(c.classes['currencies[].isDefault']).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('tolerates a single-object currency (no array) and a flat fallback', () => {
    const nested = mapToCanonicalCurrencies({
      currencies: { currency: { id: 5, code: 'GBP', rate: 0.79 } },
    });
    expect(nested.data.currencies).toHaveLength(1);
    expect(nested.data.currencies[0].code).toBe('GBP');

    const flat = mapToCanonicalCurrencies({ currency: { id: 9, code: 'JPY' } });
    expect(flat.data.currencies[0].code).toBe('JPY');
  });

  it('empty / garbage input → empty currencies, complete classmap, no throw', () => {
    for (const raw of [{}, { currencies: {} }, null, [], 'garbage']) {
      const c = mapToCanonicalCurrencies(raw);
      expect(c.entity).toBe('activity');
      expect(c.data.currencies).toEqual([]);
      assertClassmapComplete(c);
    }
  });
});

describe('mapToCanonicalPaymentMethods', () => {
  it('maps the paymentmethods.paymentmethod[] shape as business.label', () => {
    const c = mapToCanonicalPaymentMethods({
      result: 'success',
      paymentmethods: {
        paymentmethod: [
          { module: 'stripe', displayname: 'Credit Card (Stripe)' },
          { module: 'paypal', displayname: 'PayPal' },
        ],
      },
    });
    expect(c.entity).toBe('activity');
    expect(c.data.methods).toEqual([
      { module: 'stripe', displayName: 'Credit Card (Stripe)' },
      { module: 'paypal', displayName: 'PayPal' },
    ]);
    expect(c.classes['methods[].module']).toBe('business.label');
    expect(c.classes['methods[].displayName']).toBe('business.label');
    assertClassmapComplete(c);
  });

  it('tolerates a single-object method and a flat fallback', () => {
    const single = mapToCanonicalPaymentMethods({
      paymentmethods: { paymentmethod: { module: 'mailin', displayname: 'Mail In Payment' } },
    });
    expect(single.data.methods).toHaveLength(1);
    expect(single.data.methods[0].module).toBe('mailin');

    const flat = mapToCanonicalPaymentMethods({
      paymentmethod: { module: 'banktransfer', displayname: 'Bank Transfer' },
    });
    expect(flat.data.methods[0].displayName).toBe('Bank Transfer');
  });

  it('empty / garbage input → empty methods, complete classmap, no throw', () => {
    for (const raw of [{}, { paymentmethods: {} }, null, 'garbage']) {
      const c = mapToCanonicalPaymentMethods(raw);
      expect(c.data.methods).toEqual([]);
      assertClassmapComplete(c);
    }
  });
});

describe('mapToCanonicalWhmcsDetails', () => {
  it('maps version/release from the nested whmcs object as public.safe', () => {
    const c = mapToCanonicalWhmcsDetails({
      result: 'success',
      whmcs: { version: '8.10.1', canonicalversion: '8.10.1-release.1' },
    });
    expect(c.entity).toBe('activity');
    expect(c.data).toEqual({ version: '8.10.1', release: '8.10.1-release.1' });
    expect(c.classes.version).toBe('public.safe');
    expect(c.classes.release).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('falls back to a `release` key and tolerates top-level hoisting', () => {
    const rel = mapToCanonicalWhmcsDetails({ whmcs: { version: '9.0.0', release: '9.0.0-rc' } });
    expect(rel.data.release).toBe('9.0.0-rc');

    const hoisted = mapToCanonicalWhmcsDetails({ version: '7.10.2' });
    expect(hoisted.data.version).toBe('7.10.2');
    expect(hoisted.data.release).toBeNull();
  });

  it('empty / garbage input → null fields, complete classmap, no throw', () => {
    for (const raw of [{}, { whmcs: {} }, null, 'garbage']) {
      const c = mapToCanonicalWhmcsDetails(raw);
      expect(c.data).toEqual({ version: null, release: null });
      assertClassmapComplete(c);
    }
  });
});
