/**
 * B1 — canonical client mapper.
 *
 * Synthetic fixtures only (example.com / *.test / John Doe). Pins:
 *  - defensive root vs nested `client` / `client.stats` parsing
 *  - numeric-keyed + single-object custom fields, empty {} and []
 *  - classmap completeness: every emitted data path has a FieldClass
 */
import { describe, it, expect } from 'vitest';
import { mapToCanonicalClient } from '../../src/canonical/client.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalClient', () => {
  it('parses a root-shaped GetClientsDetails response', () => {
    const raw = {
      result: 'success',
      id: 42,
      firstname: 'John',
      lastname: 'Doe',
      fullname: 'John Doe',
      companyname: 'Acme Test Ltd',
      email: 'john@example.com',
      address1: '1 Test St',
      address2: 'Suite 9',
      city: 'Testville',
      state: 'TS',
      postcode: '00000',
      country: 'US',
      phonenumber: '+1-000-000-0000',
      tax_id: 'VAT-TEST-1',
      status: 'Active',
      credit: '29.51',
      currency_code: 'USD',
      defaultgateway: 'stripe',
      stats: { productsnumactive: 1, productsnumtotal: 3, numactivedomains: 2, numdomains: 4 },
      customfields: { '0': { id: 7, value: 'cf-a' }, '1': { id: 8, value: 'cf-b' } },
    };
    const c = mapToCanonicalClient(raw);
    expect(c.entity).toBe('client');
    expect(c.data.clientId).toBe(42);
    expect(c.data.email).toBe('john@example.com');
    expect(c.data.creditBalance).toBe(29.51);
    expect(c.data.stats.productCountActive).toBe(1);
    expect(c.data.customFields).toHaveLength(2);
    expect(c.data.customFields[1].value).toBe('cf-b');
    expect(c.classes.email).toBe('pii.email');
    expect(c.classes.clientId).toBe('business.identifier');
    expect(c.classes.creditBalance).toBe('financial.amount');
    expect(c.classes['customFields[].value']).toBe('pii.custom_field');
    expect(c.classes.taxId).toBe('pii.tax');
    assertClassmapComplete(c);
  });

  it('parses the nested `client` / `client.stats` shape (deprecated root)', () => {
    const raw = {
      result: 'success',
      client: {
        id: '99',
        firstname: 'Jane',
        lastname: 'Roe',
        email: 'jane@example.test',
        status: 'Active',
        credit: '0.00',
        currency_code: 'EUR',
        stats: { productsnumactive: 5, numdomains: 1 },
        customfields: [],
      },
    };
    const c = mapToCanonicalClient(raw);
    expect(c.data.clientId).toBe(99);
    expect(c.data.email).toBe('jane@example.test');
    expect(c.data.stats.productCountActive).toBe(5);
    expect(c.data.customFields).toEqual([]);
    assertClassmapComplete(c);
  });

  it('handles a single custom-field object and empty stats {}', () => {
    const raw = {
      id: 1,
      firstname: 'A',
      lastname: 'B',
      email: 'a@example.com',
      status: 'Inactive',
      stats: {},
      customfields: { id: 3, value: 'solo' },
    };
    const c = mapToCanonicalClient(raw);
    expect(c.data.customFields).toEqual([{ id: 3, name: null, value: 'solo' }]);
    expect(c.data.stats.productCountActive).toBeNull();
    assertClassmapComplete(c);
  });

  it('tolerates garbage input', () => {
    const c = mapToCanonicalClient(null);
    expect(c.data.clientId).toBeNull();
    expect(c.data.customFields).toEqual([]);
    assertClassmapComplete(c);
  });
});
