/**
 * PHASE H.1 / Track B — structural / label reclassification correctness.
 *
 * Genuine business DISPLAY labels (product / domain / service / department
 * names) move OFF `public.safe`/`pii.name` ONTO `business.label`. A real
 * PERSON name stays `pii.name`. CRITICAL safety: NO pii.* / secret.* field
 * is ever reclassified to a more-permissive class.
 *
 * Synthetic data only.
 */

import { describe, it, expect } from 'vitest';
import { mapToCanonicalDomain } from '../../src/canonical/domain.js';
import { mapToCanonicalService } from '../../src/canonical/service.js';
import { mapToCanonicalTicket } from '../../src/canonical/ticket.js';
import { mapToCanonicalOrder } from '../../src/canonical/order.js';
import { mapToCanonicalClient } from '../../src/canonical/client.js';
import {
  mapToCanonicalTransaction,
} from '../../src/canonical/transaction.js';
import type { FieldClass } from '../../src/governance/types.js';

const PERMISSIVE = new Set<FieldClass>([
  'business.label',
  'system.status',
  'public.safe',
]);

describe('genuine business labels are business.label', () => {
  it('domain.domain (a domain DISPLAY name) → business.label', () => {
    const c = mapToCanonicalDomain({ id: 1, domain: 'example.test' });
    expect(c.classes.domain).toBe('business.label');
  });

  it('service productName/groupName/domain → business.label', () => {
    const c = mapToCanonicalService({
      id: 9,
      name: 'Business Hosting Pro',
      groupname: 'Shared Hosting',
      domain: 'site.test',
    });
    expect(c.classes.productName).toBe('business.label');
    expect(c.classes.groupName).toBe('business.label');
    expect(c.classes.domain).toBe('business.label');
  });

  it('ticket.departmentName → business.label (it is NOT a person name)', () => {
    const c = mapToCanonicalTicket({ id: 1, deptname: 'Billing' });
    expect(c.classes.departmentName).toBe('business.label');
  });

  it('order lineItems[].product/domain → business.label', () => {
    const c = mapToCanonicalOrder({
      id: 1,
      lineitems: { lineitem: [{ product: 'Hosting A', domain: 'x.test' }] },
    });
    expect(c.classes['lineItems[].product']).toBe('business.label');
    expect(c.classes['lineItems[].domain']).toBe('business.label');
  });
});

describe('real person names stay pii.name (never downgraded)', () => {
  it('client firstName/lastName/fullName stay pii.name', () => {
    const c = mapToCanonicalClient({
      client: { id: 1, firstname: 'Aritra', lastname: 'Sengupta' },
    });
    expect(c.classes.firstName).toBe('pii.name');
    expect(c.classes.lastName).toBe('pii.name');
    expect(c.classes.fullName).toBe('pii.name');
  });

  it('ticket reply name (a person) stays pii.name', () => {
    const c = mapToCanonicalTicket({
      id: 1,
      replies: { reply: [{ id: 1, name: 'Jane Customer', message: 'hi' }] },
    });
    expect(c.classes['replies[].name']).toBe('pii.name');
  });
});

describe('SAFETY: no pii.* / secret.* field became a more-permissive class', () => {
  const samples = [
    mapToCanonicalClient({
      client: {
        id: 1,
        firstname: 'A',
        lastname: 'B',
        email: 'a@example.test',
        phonenumber: '+1 5550000',
        address1: '1 St',
        tax_id: 'TAX1',
        customfields: [{ id: 1, fieldname: 'Tier', value: 'gold' }],
      },
    }),
    mapToCanonicalService({
      id: 1,
      name: 'Plan',
      username: 'u',
      password: 'p',
      dedicatedip: '1.2.3.4',
    }),
    mapToCanonicalTicket({
      id: 1,
      name: 'Jane',
      email: 'j@example.test',
      replies: { reply: [{ id: 1, name: 'Jane', email: 'j@example.test' }] },
    }),
    mapToCanonicalOrder({ id: 1, ipaddress: '9.9.9.9' }),
    mapToCanonicalTransaction({ id: 1, transid: 'T1', gateway: 'stripe' }),
  ];

  it('every pii.*/secret.* path keeps a non-permissive class', () => {
    for (const c of samples) {
      for (const [path, cls] of Object.entries(c.classes)) {
        if (cls.startsWith('pii.') || cls.startsWith('secret.')) {
          expect(
            PERMISSIVE.has(cls),
            `${path} (${cls}) must NOT be a permissive class`
          ).toBe(false);
        }
      }
    }
  });

  it('no field that should be PII/secret is labelled business.label/system.*', () => {
    for (const c of samples) {
      for (const [path, cls] of Object.entries(c.classes)) {
        const looksSensitive =
          /email|phone|password|secret|credential|tax|ssn|token|apikey/i.test(
            path
          );
        if (looksSensitive) {
          expect(
            cls === 'business.label' ||
              cls === 'system.status' ||
              cls === 'system.diagnostic',
            `${path} (${cls}) is sensitive but got a permissive label`
          ).toBe(false);
        }
      }
    }
  });
});
