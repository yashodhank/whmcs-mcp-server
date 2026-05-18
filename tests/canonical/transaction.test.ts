/** B1 — canonical transaction mapper. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalTransaction,
  mapToCanonicalTransactions,
} from '../../src/canonical/transaction.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalTransaction', () => {
  it('maps a single GetTransactions row', () => {
    const raw = {
      id: 5,
      userid: 42,
      invoiceid: 100,
      transid: 'TX-5',
      date: '2026-02-01',
      gateway: 'stripe',
      amountin: '50.00',
      amountout: '0.00',
      fees: '1.50',
      description: 'Payment received',
    };
    const c = mapToCanonicalTransaction(raw);
    expect(c.entity).toBe('transaction');
    expect(c.data.transactionRowId).toBe(5);
    expect(c.data.transactionId).toBe('TX-5');
    expect(c.data.amountIn).toBe(50);
    expect(c.classes.transactionId).toBe('financial.reference');
    expect(c.classes.amountIn).toBe('financial.amount');
    expect(c.classes.description).toBe('untrusted.free_text');
    assertClassmapComplete(c);
  });

  it('tolerates missing/partial fields (nulls, not throws)', () => {
    const c = mapToCanonicalTransaction({ id: 7 });
    expect(c.data).toMatchObject({
      transactionRowId: 7,
      transactionId: null,
      amountIn: null,
      description: null,
    });
    assertClassmapComplete(c);
  });

  it('coerces wrong-typed values without throwing (string id, null amount)', () => {
    const c = mapToCanonicalTransaction({
      id: 'not-a-number',
      userid: '42',
      amountin: null,
      fees: { nested: true },
    });
    expect(c.data.transactionRowId).toBeNull();
    expect(c.data.clientId).toBe(42); // numeric string coerced
    expect(c.data.amountIn).toBeNull();
    expect(c.data.fees).toBeNull();
    assertClassmapComplete(c);
  });

  it('garbage tolerant (null / string / array → nulls, no throw)', () => {
    for (const g of [null, 'garbage', [], 123]) {
      const c = mapToCanonicalTransaction(g);
      expect(c.entity).toBe('transaction');
      expect(c.data.transactionId).toBeNull();
      assertClassmapComplete(c);
    }
  });
});

describe('mapToCanonicalTransactions (list / wrapper / numeric-keyed)', () => {
  it('unwraps transactions.transaction numeric-keyed object', () => {
    const raw = {
      transactions: {
        transaction: { '0': { id: 1, transid: 'A' }, '1': { id: 2, transid: 'B' } },
      },
    };
    const list = mapToCanonicalTransactions(raw);
    expect(list).toHaveLength(2);
    expect(list[1].data.transactionId).toBe('B');
    list.forEach(assertClassmapComplete);
  });

  it('handles single object and empty {}', () => {
    expect(mapToCanonicalTransactions({ transactions: {} })).toEqual([]);
    const single = mapToCanonicalTransactions({
      transactions: { transaction: { id: 9, transid: 'solo' } },
    });
    expect(single).toHaveLength(1);
    expect(single[0].data.transactionId).toBe('solo');
  });

  it('handles a proper array under transaction', () => {
    const arr = mapToCanonicalTransactions({
      transactions: { transaction: [{ id: 11 }, { id: 12 }] },
    });
    expect(arr.map((c) => c.data.transactionRowId)).toEqual([11, 12]);
    arr.forEach(assertClassmapComplete);
  });

  it('handles empty / missing / garbage wrappers without throwing', () => {
    expect(mapToCanonicalTransactions({})).toEqual([]);
    expect(mapToCanonicalTransactions(null)).toEqual([]);
    expect(mapToCanonicalTransactions([])).toEqual([]);
    expect(mapToCanonicalTransactions('garbage')).toEqual([]);
    expect(mapToCanonicalTransactions({ transactions: null })).toEqual([]);
  });
});
