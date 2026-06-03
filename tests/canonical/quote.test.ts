/** B1 — canonical quote mapper. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalQuote,
  mapToCanonicalQuotes,
} from '../../src/canonical/quote.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalQuote', () => {
  it('maps a quote with line items (numeric strings, nested currency)', () => {
    const raw = {
      id: 77,
      subject: 'Annual hosting proposal',
      stage: 'Delivered',
      status: 'Open',
      datecreated: '2026-05-01',
      validuntil: '2026-06-01',
      currency: { id: '1', code: 'USD' },
      subtotal: '100.00',
      tax: '18.00',
      total: '118.00',
      customernotes: 'please review by friday',
      lineitems: {
        lineitem: {
          '0': { description: 'Hosting plan A', amount: '60.00' },
          '1': { description: 'SSL certificate', amount: '40.00' },
        },
      },
    };
    const c = mapToCanonicalQuote(raw);
    // Reuses the invoice entity — a quote is invoice-adjacent.
    expect(c.entity).toBe('invoice');
    expect(c.data.quoteId).toBe(77);
    expect(c.data.subject).toBe('Annual hosting proposal');
    expect(c.data.stage).toBe('Delivered');
    expect(c.data.date).toBe('2026-05-01');
    expect(c.data.validUntil).toBe('2026-06-01');
    expect(c.data.currency).toBe('USD');
    expect(c.data.subtotal).toBe(100);
    expect(c.data.tax).toBe(18);
    expect(c.data.total).toBe(118);
    expect(c.data.customerNotes).toBe('please review by friday');
    expect(c.data.lineItems).toHaveLength(2);
    expect(c.data.lineItems[0]).toEqual({
      description: 'Hosting plan A',
      amount: 60,
    });
    // Field classes.
    expect(c.classes.quoteId).toBe('business.identifier');
    expect(c.classes.subject).toBe('business.label');
    expect(c.classes.currency).toBe('business.identifier');
    expect(c.classes.total).toBe('financial.amount');
    expect(c.classes.status).toBe('public.safe');
    expect(c.classes.customerNotes).toBe('untrusted.free_text');
    expect(c.classes['lineItems[].description']).toBe('business.label');
    expect(c.classes['lineItems[].amount']).toBe('financial.amount');
    assertClassmapComplete(c);
  });

  it('reads a flat currencycode and a single line item object', () => {
    const c = mapToCanonicalQuote({
      quoteid: 9,
      currencycode: 'EUR',
      lineitems: { lineitem: { description: 'Setup', amount: 25 } },
    });
    expect(c.data.quoteId).toBe(9);
    expect(c.data.currency).toBe('EUR');
    expect(c.data.lineItems).toHaveLength(1);
    expect(c.data.lineItems[0].amount).toBe(25);
    assertClassmapComplete(c);
  });

  it('is garbage tolerant', () => {
    const g = mapToCanonicalQuote(null);
    expect(g.entity).toBe('invoice');
    expect(g.data.quoteId).toBeNull();
    expect(g.data.lineItems).toEqual([]);
    assertClassmapComplete(g);
  });
});

describe('mapToCanonicalQuotes', () => {
  it('unwraps quotes.quote list, empty {}, single object', () => {
    expect(mapToCanonicalQuotes({ quotes: {} })).toEqual([]);

    const list = mapToCanonicalQuotes({
      quotes: {
        quote: {
          '0': { id: 1, subject: 'A' },
          '1': { id: 2, subject: 'B' },
        },
      },
    });
    expect(list).toHaveLength(2);
    expect(list[0].entity).toBe('invoice');
    expect(list[1].data.subject).toBe('B');
    list.forEach(assertClassmapComplete);

    const one = mapToCanonicalQuotes({
      quotes: { quote: { id: 9, subject: 'solo' } },
    });
    expect(one).toHaveLength(1);
    expect(one[0].data.quoteId).toBe(9);
  });

  it('returns [] for non-record / missing quotes', () => {
    expect(mapToCanonicalQuotes(null)).toEqual([]);
    expect(mapToCanonicalQuotes({})).toEqual([]);
  });
});
