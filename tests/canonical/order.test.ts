/** B1 — canonical order mapper. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalOrder,
  mapToCanonicalOrders,
} from '../../src/canonical/order.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalOrder', () => {
  it('maps an order with line items', () => {
    const raw = {
      id: 500,
      ordernum: 'ORD-500',
      userid: 42,
      contactid: 0,
      date: '2026-04-01',
      nameservers: 'ns1.example.test',
      amount: '100.00',
      paymentmethod: 'stripe',
      paymentstatus: 'Paid',
      status: 'Active',
      ipaddress: '203.0.113.5',
      fraudoutput: 'pass',
      notes: 'priority customer',
      lineitems: {
        lineitem: {
          '0': { type: 'product', product: 'Hosting A', domain: 'site.test', billingcycle: 'Annually', amount: '100.00', status: 'Active' },
        },
      },
    };
    const c = mapToCanonicalOrder(raw);
    expect(c.entity).toBe('order');
    expect(c.data.orderId).toBe(500);
    expect(c.data.orderNumber).toBe('ORD-500');
    expect(c.data.lineItems).toHaveLength(1);
    expect(c.data.lineItems[0].product).toBe('Hosting A');
    expect(c.classes.orderId).toBe('business.identifier');
    expect(c.classes.amount).toBe('financial.amount');
    expect(c.classes.ipAddress).toBe('pii.address');
    expect(c.classes.notes).toBe('untrusted.free_text');
    expect(c.classes['lineItems[].amount']).toBe('financial.amount');
    assertClassmapComplete(c);
  });

  it('unwraps orders.order list, empty {}, single object', () => {
    expect(mapToCanonicalOrders({ orders: {} })).toEqual([]);
    const list = mapToCanonicalOrders({
      orders: { order: { '0': { id: 1, ordernum: 'A' }, '1': { id: 2, ordernum: 'B' } } },
    });
    expect(list).toHaveLength(2);
    expect(list[1].data.orderNumber).toBe('B');
    list.forEach(assertClassmapComplete);
    const one = mapToCanonicalOrders({ orders: { order: { id: 9, ordernum: 'solo' } } });
    expect(one).toHaveLength(1);
  });

  it('garbage tolerant', () => {
    const g = mapToCanonicalOrder(null);
    expect(g.data.orderId).toBeNull();
    assertClassmapComplete(g);
  });
});
