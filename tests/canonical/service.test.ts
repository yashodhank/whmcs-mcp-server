/** B1 — canonical service mapper. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalService,
  mapToCanonicalServices,
} from '../../src/canonical/service.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalService', () => {
  it('maps a GetClientsProducts product row with credentials + custom fields', () => {
    const raw = {
      id: 200,
      clientid: 42,
      pid: 11,
      name: 'Hosting Plan A',
      domain: 'site.test',
      status: 'Active',
      regdate: '2025-01-01',
      nextduedate: '2026-01-01',
      terminationdate: '0000-00-00',
      recurringamount: '120.00',
      firstpaymentamount: '120.00',
      paymentmethod: 'stripe',
      billingcycle: 'Annually',
      username: 'siteuser',
      password: 's3cr3t',
      dedicatedip: '203.0.113.9',
      serverid: 3,
      servername: 'web01',
      customfields: { customfield: [{ id: 1, value: 'cf' }] },
    };
    const c = mapToCanonicalService(raw);
    expect(c.entity).toBe('service');
    expect(c.data.serviceId).toBe(200);
    expect(c.data.password).toBe('s3cr3t');
    expect(c.data.customFields[0].value).toBe('cf');
    expect(c.classes.serviceId).toBe('business.identifier');
    expect(c.classes.password).toBe('secret.credential');
    expect(c.classes.recurringAmount).toBe('financial.amount');
    // Track B (correctness fix): a service's domain is a business DISPLAY
    // label. business.label is `allow` everywhere ⇒ projected output
    // unchanged; only the auditor's reported class is corrected.
    expect(c.classes.domain).toBe('business.label');
    expect(c.classes['customFields[].value']).toBe('pii.custom_field');
    assertClassmapComplete(c);
  });

  it('unwraps products.product list with empty {} customfields', () => {
    const raw = {
      products: { product: { '0': { id: 1, name: 'X', customfields: {} }, '1': { id: 2, name: 'Y', customfields: [] } } },
    };
    const list = mapToCanonicalServices(raw);
    expect(list).toHaveLength(2);
    expect(list[0].data.customFields).toEqual([]);
    list.forEach(assertClassmapComplete);
  });

  it('single product object + garbage', () => {
    const one = mapToCanonicalServices({ products: { product: { id: 9, name: 'solo' } } });
    expect(one).toHaveLength(1);
    expect(one[0].data.serviceId).toBe(9);
    const g = mapToCanonicalService(null);
    expect(g.data.serviceId).toBeNull();
    assertClassmapComplete(g);
  });
});
