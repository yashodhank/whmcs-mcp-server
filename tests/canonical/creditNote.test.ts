/**
 * B1 — canonical credit/debit note mapper. Synthetic fixtures ONLY.
 *
 * WHMCS 9 makes non-draft invoices immutable; corrections are expressed as
 * credit/debit notes. This mapper is READ-ONLY canonical modeling — it never
 * calls WHMCS and does not assert the underlying read action is supported.
 * All fixtures use synthetic ids and example.com / .test domains (no PII).
 */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalCreditNote,
  mapToCanonicalCreditNotes,
} from '../../src/canonical/creditNote.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalCreditNote (single)', () => {
  it('maps a single credit note row', () => {
    const raw = {
      id: 7,
      clientid: 42,
      invoiceid: 100,
      type: 'credit',
      date: '2026-03-01',
      currency: 'USD',
      amount: '25.00',
      reference: 'CN-7',
      status: 'Applied',
      description: 'Goodwill credit for billing@acme.example.com',
    };
    const c = mapToCanonicalCreditNote(raw);
    expect(c.entity).toBe('transaction');
    expect(c.data.noteId).toBe(7);
    expect(c.data.clientId).toBe(42);
    expect(c.data.invoiceId).toBe(100);
    expect(c.data.type).toBe('credit');
    expect(c.data.amount).toBe(25);
    expect(c.data.reference).toBe('CN-7');
    expect(c.data.status).toBe('Applied');
    expect(c.classes.noteId).toBe('business.identifier');
    expect(c.classes.clientId).toBe('business.identifier');
    expect(c.classes.amount).toBe('financial.amount');
    expect(c.classes.reference).toBe('financial.reference');
    expect(c.classes.description).toBe('untrusted.free_text');
    expect(c.classes.date).toBe('public.safe');
    expect(c.classes.currency).toBe('public.safe');
    expect(c.classes.status).toBe('public.safe');
    expect(c.classes.type).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('infers debit type and tolerates missing invoiceId', () => {
    const raw = {
      id: 8,
      clientid: 43,
      type: 'debit',
      date: '2026-03-02',
      currency: 'EUR',
      amount: 12.5,
      reference: 'DN-8',
      status: 'Open',
    };
    const c = mapToCanonicalCreditNote(raw);
    expect(c.data.type).toBe('debit');
    expect(c.data.invoiceId).toBeNull();
    expect(c.data.description).toBeNull();
    assertClassmapComplete(c);
  });

  it('defaults unknown type to credit and is garbage tolerant', () => {
    const c = mapToCanonicalCreditNote(null);
    expect(c.entity).toBe('transaction');
    expect(c.data.noteId).toBeNull();
    expect(c.data.type).toBe('credit');
    expect(c.data.reference).toBeNull();
    assertClassmapComplete(c);
  });
});

describe('mapToCanonicalCreditNotes (list / wrapper / numeric-keyed)', () => {
  it('unwraps creditnotes.creditnote numeric-keyed object', () => {
    const raw = {
      creditnotes: {
        creditnote: {
          '0': { id: 1, reference: 'A', type: 'credit' },
          '1': { id: 2, reference: 'B', type: 'debit' },
        },
      },
    };
    const list = mapToCanonicalCreditNotes(raw);
    expect(list).toHaveLength(2);
    expect(list[0].data.reference).toBe('A');
    expect(list[1].data.reference).toBe('B');
    expect(list[1].data.type).toBe('debit');
    list.forEach(assertClassmapComplete);
  });

  it('handles a single (non-array) creditnote object', () => {
    const single = mapToCanonicalCreditNotes({
      creditnotes: { creditnote: { id: 9, reference: 'solo', type: 'credit' } },
    });
    expect(single).toHaveLength(1);
    expect(single[0].data.reference).toBe('solo');
    single.forEach(assertClassmapComplete);
  });

  it('handles a proper array under creditnote', () => {
    const arr = mapToCanonicalCreditNotes({
      creditnotes: {
        creditnote: [
          { id: 11, reference: 'X' },
          { id: 12, reference: 'Y' },
        ],
      },
    });
    expect(arr).toHaveLength(2);
    expect(arr.map((c) => c.data.reference)).toEqual(['X', 'Y']);
    arr.forEach(assertClassmapComplete);
  });

  it('handles empty {} and [] without throwing', () => {
    expect(mapToCanonicalCreditNotes({ creditnotes: {} })).toEqual([]);
    expect(mapToCanonicalCreditNotes({})).toEqual([]);
    expect(mapToCanonicalCreditNotes([])).toEqual([]);
    expect(mapToCanonicalCreditNotes(null)).toEqual([]);
  });
});
