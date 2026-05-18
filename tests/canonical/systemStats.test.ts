/**
 * B1 — canonical WHMCS GetStats mapper. Synthetic fixtures ONLY.
 *
 * GetStats is a GLOBAL/admin read of AGGREGATE counters (income totals,
 * order/client/ticket counts). It is not client-scoped and carries no
 * per-customer PII. It maps to the EXISTING frozen 'activity' entity (an admin
 * operational snapshot; the frozen CanonicalEntity union is NOT extended).
 * Single object only — there is no plural form. Fake amounts only.
 */
import { describe, it, expect } from 'vitest';
import { mapToCanonicalSystemStats } from '../../src/canonical/systemStats.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalSystemStats (single object only)', () => {
  it('classifies income/revenue keys financial and counts public, with complete classmap', () => {
    const raw = {
      income_today: '120.50',
      income_thismonth: 4200,
      income_thisyear: '50000.00',
      total_revenue: 99999,
      orders_today: 4,
      orders_pending: 2,
      clients_total: 87,
      tickets_open: 9,
      services_active: 211,
    };
    const c = mapToCanonicalSystemStats(raw);
    expect(c.entity).toBe('activity');
    expect(c.data.metrics.income_today).toBe(120.5);
    expect(c.data.metrics.income_thismonth).toBe(4200);
    expect(c.data.metrics.total_revenue).toBe(99999);
    expect(c.data.metrics.orders_today).toBe(4);
    expect(c.data.metrics.clients_total).toBe(87);

    // pattern classifier: income|revenue|amount|balance → financial.amount
    expect(c.classes['metrics.income_today']).toBe('financial.amount');
    expect(c.classes['metrics.income_thisyear']).toBe('financial.amount');
    expect(c.classes['metrics.total_revenue']).toBe('financial.amount');
    // everything else aggregate counter → public.safe
    expect(c.classes['metrics.orders_today']).toBe('public.safe');
    expect(c.classes['metrics.clients_total']).toBe('public.safe');
    expect(c.classes['metrics.tickets_open']).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('classifies id-ish keys as business.identifier and balance as financial', () => {
    const c = mapToCanonicalSystemStats({
      staffid: 7,
      account_balance: '15.00',
      orders_total: 3,
    });
    expect(c.data.metrics.staffid).toBe(7);
    expect(c.classes['metrics.staffid']).toBe('business.identifier');
    expect(c.classes['metrics.account_balance']).toBe('financial.amount');
    expect(c.classes['metrics.orders_total']).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('classifies free-text keys as untrusted.free_text', () => {
    const c = mapToCanonicalSystemStats({
      orders_today: 1,
      announcement_note: 'See ops@example.com for details',
    });
    expect(c.data.metrics.announcement_note).toBe(
      'See ops@example.com for details'
    );
    expect(c.classes['metrics.announcement_note']).toBe(
      'untrusted.free_text'
    );
    assertClassmapComplete(c);
  });

  it('empty {} → empty metrics, complete (empty) classmap, no throw', () => {
    const c = mapToCanonicalSystemStats({});
    expect(c.data.metrics).toEqual({});
    assertClassmapComplete(c);
  });

  it('is garbage tolerant (null / array / string → empty metrics)', () => {
    expect(mapToCanonicalSystemStats(null).data.metrics).toEqual({});
    expect(mapToCanonicalSystemStats([]).data.metrics).toEqual({});
    const c = mapToCanonicalSystemStats('garbage');
    expect(c.entity).toBe('activity');
    assertClassmapComplete(c);
  });

  it('ignores nested object values (only scalar counters are emitted)', () => {
    const c = mapToCanonicalSystemStats({
      orders_today: 5,
      nested: { a: 1 },
    });
    expect(c.data.metrics.orders_today).toBe(5);
    expect('nested' in c.data.metrics).toBe(false);
    assertClassmapComplete(c);
  });
});
