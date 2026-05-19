/**
 * Phase G+ — intent → WHMCS param mapper tests.
 *
 * One block per scope (8 scopes). For each: assert the intent-shape keys are
 * GONE from the mapped output and the WHMCS-shape keys are PRESENT. Also
 * proves the deterministic-transid contract (same idempotency_key → same
 * transid; different keys → different) and the phantom-revenue guard
 * (refund never sets `amountin`).
 */

import { describe, it, expect } from 'vitest';
import {
  intentToWhmcsParams,
  mapClientNoteParams,
  mapTicketCreateParams,
  mapTicketReplyParams,
  mapTicketStatusParams,
  mapInvoiceCreateParams,
  mapInvoicePaymentParams,
  mapCreditAddParams,
  mapRefundRecordParams,
} from '../../src/write/paramMapping.js';

describe('paramMapping — per-scope (8)', () => {
  it('client_note:write maps clientid→userid + note→notes; drops intent keys', () => {
    const out = mapClientNoteParams({ clientid: 42, note: 'hi', sticky: true });
    expect(out).toEqual({ userid: 42, notes: 'hi', sticky: true });
    // double-naming guard
    expect(out).not.toHaveProperty('clientid');
    expect(out).not.toHaveProperty('note');
  });

  it('client_note:write omits sticky when undefined', () => {
    const out = mapClientNoteParams({ clientid: 1, note: 'x' });
    expect(out).toEqual({ userid: 1, notes: 'x' });
    expect(out).not.toHaveProperty('sticky');
  });

  it('ticket:create is intent-shape passthrough (deptid/subject/message/clientid)', () => {
    const out = mapTicketCreateParams({
      deptid: 3,
      subject: 's',
      message: 'm',
      clientid: 7,
    });
    expect(out).toEqual({ deptid: 3, subject: 's', message: 'm', clientid: 7 });
  });

  it('ticket:reply is intent-shape passthrough', () => {
    const out = mapTicketReplyParams({ ticketid: 1, message: 'hi', clientid: 9 });
    expect(out).toEqual({ ticketid: 1, message: 'hi', clientid: 9 });
  });

  it('ticket:status is intent-shape passthrough', () => {
    const out = mapTicketStatusParams({ ticketid: 1, status: 'Closed' });
    expect(out).toEqual({ ticketid: 1, status: 'Closed' });
  });

  it('billing:invoice:create FLATTENS items[]→itemdescription{N}/itemamount{N}/itemtaxed{N}; drops items', () => {
    const out = mapInvoiceCreateParams({
      userid: 5,
      items: [
        { description: 'A', amount: 10, taxed: true },
        { description: 'B', amount: 20, taxed: false },
      ],
    });
    expect(out.userid).toBe(5);
    expect(out.itemdescription1).toBe('A');
    expect(out.itemamount1).toBe(10);
    expect(out.itemtaxed1).toBe(1);
    expect(out.itemdescription2).toBe('B');
    expect(out.itemamount2).toBe(20);
    expect(out.itemtaxed2).toBe(0);
    // critical: the intent-shape `items` key must be GONE
    expect(out).not.toHaveProperty('items');
  });

  it('billing:invoice:create — items with no `taxed` omits the itemtaxed key', () => {
    const out = mapInvoiceCreateParams({
      userid: 5,
      items: [{ description: 'A', amount: 10 }],
    });
    expect(out.itemdescription1).toBe('A');
    expect(out.itemamount1).toBe(10);
    expect(out).not.toHaveProperty('itemtaxed1');
  });

  it('billing:payment:add — supplies deterministic transid from idempotency_key', () => {
    const a = mapInvoicePaymentParams(
      { invoiceid: 9, amount: 50 },
      { idempotency_key: 'IDEMP-XYZ' }
    );
    const b = mapInvoicePaymentParams(
      { invoiceid: 9, amount: 50 },
      { idempotency_key: 'IDEMP-XYZ' }
    );
    expect(a.transid).toBe(b.transid);
    expect(typeof a.transid).toBe('string');
  });

  it('billing:payment:add — different idempotency_key ⇒ different transid', () => {
    const a = mapInvoicePaymentParams({ invoiceid: 9, amount: 50 }, { idempotency_key: 'K1' });
    const b = mapInvoicePaymentParams({ invoiceid: 9, amount: 50 }, { idempotency_key: 'K2' });
    expect(a.transid).not.toBe(b.transid);
  });

  it('billing:payment:add — explicit transid is preserved (no override)', () => {
    const out = mapInvoicePaymentParams(
      { invoiceid: 9, amount: 50, transid: 'EXPLICIT-1' },
      { idempotency_key: 'IDEMP' }
    );
    expect(out.transid).toBe('EXPLICIT-1');
  });

  it('billing:credit:add — passes clientid/amount/description only (description required)', () => {
    const out = mapCreditAddParams({ clientid: 4, amount: 10, description: 'goodwill' });
    expect(out).toEqual({ clientid: 4, amount: 10, description: 'goodwill' });
  });

  it('billing:refund:record (Credit) — sets amountout, NEVER amountin, sets credit:true', () => {
    const out = mapRefundRecordParams(
      {
        invoiceid: 1,
        amount: 25,
        refund_type: 'Credit',
        paymentmethod: 'stripe',
        description: 'refund x',
      },
      { idempotency_key: 'KEY' }
    );
    // phantom-revenue guard
    expect(out).not.toHaveProperty('amountin');
    expect(out.amountout).toBe(25);
    expect(out.credit).toBe(true);
    expect(out.invoiceid).toBe(1);
    expect(out.paymentmethod).toBe('stripe');
    expect(typeof out.transid).toBe('string');
  });

  it('billing:refund:record (GatewayRecord) — sets amountout, NEVER amountin, NEVER credit', () => {
    const out = mapRefundRecordParams(
      {
        invoiceid: 1,
        amount: 25,
        refund_type: 'GatewayRecord',
        paymentmethod: 'stripe',
      },
      { idempotency_key: 'KEY' }
    );
    expect(out).not.toHaveProperty('amountin');
    expect(out).not.toHaveProperty('credit');
    expect(out.amountout).toBe(25);
  });

  it('billing:refund:record — deterministic transid (idempotency_key based)', () => {
    const a = mapRefundRecordParams(
      { invoiceid: 1, amount: 5, refund_type: 'Credit', paymentmethod: 'p' },
      { idempotency_key: 'IDEMP-R1' }
    );
    const b = mapRefundRecordParams(
      { invoiceid: 1, amount: 5, refund_type: 'Credit', paymentmethod: 'p' },
      { idempotency_key: 'IDEMP-R1' }
    );
    expect(a.transid).toBe(b.transid);
    const c = mapRefundRecordParams(
      { invoiceid: 1, amount: 5, refund_type: 'Credit', paymentmethod: 'p' },
      { idempotency_key: 'IDEMP-R2' }
    );
    expect(a.transid).not.toBe(c.transid);
  });

  it('billing:refund:record — derives a default description when absent', () => {
    const out = mapRefundRecordParams(
      { invoiceid: 1, amount: 5, refund_type: 'Credit', paymentmethod: 'p' },
      { idempotency_key: 'X' }
    );
    expect(typeof out.description).toBe('string');
    expect((out.description as string).length).toBeGreaterThan(0);
  });
});

describe('intentToWhmcsParams — dispatcher', () => {
  it('routes client_note:write through mapClientNoteParams', () => {
    const out = intentToWhmcsParams('client_note:write', { clientid: 1, note: 'x' });
    expect(out).toEqual({ userid: 1, notes: 'x' });
  });

  it('routes billing:invoice:create through mapInvoiceCreateParams', () => {
    const out = intentToWhmcsParams('billing:invoice:create', {
      userid: 1,
      items: [{ description: 'd', amount: 1, taxed: true }],
    });
    expect(out).not.toHaveProperty('items');
    expect(out.itemdescription1).toBe('d');
  });

  it('routes billing:refund:record (Credit) and applies the amountin guard', () => {
    const out = intentToWhmcsParams(
      'billing:refund:record',
      {
        invoiceid: 1,
        amount: 9,
        refund_type: 'Credit',
        paymentmethod: 'm',
      },
      { idempotency_key: 'K' }
    );
    expect(out).not.toHaveProperty('amountin');
    expect(out.amountout).toBe(9);
    expect(out.credit).toBe(true);
  });
});
