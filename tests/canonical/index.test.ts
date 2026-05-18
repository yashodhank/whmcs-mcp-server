/** B1 — barrel exports every mapper and returns the correct entity tag. */
import { describe, it, expect } from 'vitest';
import * as canonical from '../../src/canonical/index.js';

describe('canonical barrel', () => {
  it('exports all seven entity mappers', () => {
    for (const fn of [
      'mapToCanonicalClient',
      'mapToCanonicalInvoice',
      'mapToCanonicalTransaction',
      'mapToCanonicalService',
      'mapToCanonicalDomain',
      'mapToCanonicalTicket',
      'mapToCanonicalOrder',
    ] as const) {
      expect(canonical[fn]).toBeTypeOf('function');
    }
  });

  it('each mapper tags the canonical entity', () => {
    expect(canonical.mapToCanonicalClient({}).entity).toBe('client');
    expect(canonical.mapToCanonicalInvoice({}).entity).toBe('invoice');
    expect(canonical.mapToCanonicalTransaction({}).entity).toBe('transaction');
    expect(canonical.mapToCanonicalService({}).entity).toBe('service');
    expect(canonical.mapToCanonicalDomain({}).entity).toBe('domain');
    expect(canonical.mapToCanonicalTicket({}).entity).toBe('ticket');
    expect(canonical.mapToCanonicalOrder({}).entity).toBe('order');
  });
});
