/** B1 — canonical invoice mapper. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import { mapToCanonicalInvoice } from '../../src/canonical/invoice.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalInvoice', () => {
  it('maps GetInvoice with items.item + transactions.transaction wrappers', () => {
    const raw = {
      result: 'success',
      invoiceid: 100,
      invoicenum: 'INV-100',
      userid: 42,
      date: '2026-01-01',
      duedate: '2026-01-15',
      datepaid: '2026-01-10',
      status: 'Paid',
      subtotal: '90.00',
      tax: '10.00',
      tax2: '0.00',
      total: '100.00',
      balance: '0.00',
      credit: '0.00',
      paymentmethod: 'stripe',
      items: { item: { '0': { id: 1, type: 'Hosting', relid: 5, description: 'Plan A', amount: '90.00', taxed: 1 } } },
      transactions: { transaction: [{ id: 9, transid: 'TX-9', date: '2026-01-10', gateway: 'stripe', amount: '100.00', amountin: '100.00', amountout: '0.00' }] },
    };
    const c = mapToCanonicalInvoice(raw);
    expect(c.entity).toBe('invoice');
    expect(c.data.invoiceId).toBe(100);
    expect(c.data.total).toBe(100);
    expect(c.data.items).toHaveLength(1);
    expect(c.data.items[0].description).toBe('Plan A');
    expect(c.data.transactions[0].transactionId).toBe('TX-9');
    expect(c.classes.invoiceId).toBe('business.identifier');
    expect(c.classes.total).toBe('financial.amount');
    expect(c.classes['transactions[].transactionId']).toBe('financial.reference');
    expect(c.classes['items[].description']).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('handles empty items {} and missing transactions', () => {
    const raw = { invoiceid: 1, status: 'Unpaid', total: '5', items: {}, transactions: [] };
    const c = mapToCanonicalInvoice(raw);
    expect(c.data.items).toEqual([]);
    expect(c.data.transactions).toEqual([]);
    assertClassmapComplete(c);
  });

  it('handles a single (non-array) item object', () => {
    const raw = { invoiceid: 2, items: { item: { id: 7, description: 'solo', amount: '1.00' } }, transactions: {} };
    const c = mapToCanonicalInvoice(raw);
    expect(c.data.items).toHaveLength(1);
    expect(c.data.items[0].itemId).toBe(7);
    assertClassmapComplete(c);
  });

  it('tolerates garbage', () => {
    const c = mapToCanonicalInvoice(undefined);
    expect(c.data.invoiceId).toBeNull();
    assertClassmapComplete(c);
  });
});
