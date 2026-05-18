/** B1 — canonical domain mapper. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalDomain,
  mapToCanonicalDomains,
} from '../../src/canonical/domain.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalDomain', () => {
  it('maps a GetClientsDomains domain row', () => {
    const raw = {
      id: 300,
      userid: 42,
      domain: 'example.test',
      registrar: 'enom',
      registrationdate: '2024-01-01',
      expirydate: '2027-01-01',
      nextduedate: '2026-12-01',
      status: 'Active',
      recurringamount: '15.00',
      firstpaymentamount: '15.00',
      paymentmethod: 'stripe',
      idprotection: 1,
      donotrenew: 0,
      dnsmanagement: 1,
      emailforwarding: 0,
    };
    const c = mapToCanonicalDomain(raw);
    expect(c.entity).toBe('domain');
    expect(c.data.domainId).toBe(300);
    expect(c.data.domain).toBe('example.test');
    expect(c.data.idProtection).toBe(true);
    expect(c.classes.domainId).toBe('business.identifier');
    // Track B (correctness fix): a domain name is a non-sensitive business
    // DISPLAY label, not generic public.safe metadata. business.label is
    // `allow` in every contract, so projected output is unchanged — this
    // only fixes the classification the authoritative auditor reports.
    expect(c.classes.domain).toBe('business.label');
    expect(c.classes.recurringAmount).toBe('financial.amount');
    assertClassmapComplete(c);
  });

  it('unwraps domains.domain numeric-keyed + empty', () => {
    expect(mapToCanonicalDomains({ domains: {} })).toEqual([]);
    const list = mapToCanonicalDomains({
      domains: { domain: { '0': { id: 1, domain: 'a.test' }, '1': { id: 2, domain: 'b.test' } } },
    });
    expect(list).toHaveLength(2);
    expect(list[1].data.domain).toBe('b.test');
    list.forEach(assertClassmapComplete);
  });

  it('single object + garbage', () => {
    const one = mapToCanonicalDomains({ domains: { domain: { id: 9, domain: 'solo.test' } } });
    expect(one).toHaveLength(1);
    const g = mapToCanonicalDomain(undefined);
    expect(g.data.domainId).toBeNull();
    assertClassmapComplete(g);
  });
});
