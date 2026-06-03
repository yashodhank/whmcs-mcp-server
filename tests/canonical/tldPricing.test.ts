/**
 * B1 — canonical WHMCS GetTLDPricing mapper. Synthetic fixtures ONLY.
 *
 * Static reference data (no PII). Verifies the dynamic-key WHMCS shape
 * (pricing keyed by TLD; register/renew/transfer keyed by period → price
 * string) collapses into stable typed arrays, "-1" not-offered is dropped,
 * prices classify financial.amount, and the classmap is complete.
 */
import { describe, it, expect } from 'vitest';
import { mapToCanonicalTldPricing } from '../../src/canonical/tldPricing.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalTldPricing', () => {
  const raw = {
    result: 'success',
    currency: { id: '1', code: 'USD', prefix: '$' },
    pricing: {
      '.com': {
        register: { '1': '9.95', '2': '19.90' },
        transfer: { '1': '9.95' },
        renew: { '1': '11.95' },
        addons: { dnsmanagement: '1', emailforwarding: '0', idprotection: '1' },
      },
      '.io': {
        register: { '1': '39.95', '2': '-1' },
        transfer: { '1': '39.95' },
        renew: { '1': '44.95' },
      },
    },
  };

  it('maps currency, per-TLD prices and addons with complete classmap', () => {
    const c = mapToCanonicalTldPricing(raw, 'enom');
    expect(c.entity).toBe('tldPricing');
    expect(c.data.currencyCode).toBe('USD');
    expect(c.data.currencyId).toBe(1);
    expect(c.data.registrar).toBe('enom');

    const com = c.data.prices.find((p) => p.tld === '.com');
    expect(com?.register).toEqual([
      { period: 1, price: 9.95 },
      { period: 2, price: 19.9 },
    ]);
    expect(com?.renew).toEqual([{ period: 1, price: 11.95 }]);
    expect(com?.addons.dnsManagement).toBe(true);
    expect(com?.addons.emailForwarding).toBe(false);
    expect(com?.addons.idProtection).toBe(true);

    // "-1" (not offered) is dropped.
    const io = c.data.prices.find((p) => p.tld === '.io');
    expect(io?.register).toEqual([{ period: 1, price: 39.95 }]);
    // addons absent → all null
    expect(io?.addons.dnsManagement).toBeNull();

    expect(c.classes['currencyCode']).toBe('business.identifier');
    expect(c.classes['prices[].tld']).toBe('business.label');
    expect(c.classes['prices[].register[].price']).toBe('financial.amount');
    expect(c.classes['prices[].register[].period']).toBe('public.safe');
    expect(c.classes['prices[].addons.dnsManagement']).toBe('system.status');
    assertClassmapComplete(c);
  });

  it('TLDs are sorted; periods are sorted ascending', () => {
    const c = mapToCanonicalTldPricing(raw);
    expect(c.data.prices.map((p) => p.tld)).toEqual(['.com', '.io']);
    const com = c.data.prices[0];
    expect(com.register.map((r) => r.period)).toEqual([1, 2]);
    expect(c.data.registrar).toBeNull();
  });

  it('resolves registrar from raw GetRegistrars shape', () => {
    const c = mapToCanonicalTldPricing(raw, {
      registrars: { registrar: [{ module: 'resellerclub', displayname: 'ResellerClub' }] },
    });
    expect(c.data.registrar).toBe('resellerclub');
  });

  it('empty / garbage → empty prices, complete classmap, no throw', () => {
    const c = mapToCanonicalTldPricing(null);
    expect(c.data.prices).toEqual([]);
    expect(c.data.currencyCode).toBeNull();
    assertClassmapComplete(c);
    const c2 = mapToCanonicalTldPricing({ pricing: {} });
    expect(c2.data.prices).toEqual([]);
    assertClassmapComplete(c2);
  });

  it('keeps a zero price, drops "-1"/negative, excludes fractional/garbage periods', () => {
    const c = mapToCanonicalTldPricing({
      currency: { id: '1', code: 'USD' },
      pricing: {
        '.promo': {
          register: { '1': '0.00', '2': '-1', '3': '-5', '1.5': '9.99', abc: '7' },
          renew: { '1': '0' },
          transfer: {},
        },
      },
    });
    const promo = c.data.prices.find((p) => p.tld === '.promo');
    expect(promo).toBeDefined();
    // 0 kept (period 1); -1/-5 dropped; "1.5"/"abc" periods excluded.
    expect(promo?.register).toEqual([{ period: 1, price: 0 }]);
    expect(promo?.renew).toEqual([{ period: 1, price: 0 }]);
    assertClassmapComplete(c);
  });
});
