/** B1 — canonical pay-method + credit mappers. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalPayMethods,
  mapToCanonicalCredits,
} from '../../src/canonical/payMethod.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalPayMethods', () => {
  it('maps GetPayMethods with paymethods.paymethod wrapper + nested card', () => {
    const raw = {
      result: 'success',
      clientid: 42,
      paymethods: {
        paymethod: [
          {
            id: '7',
            type: 'CreditCard',
            description: 'Visa ending 4242',
            gateway_name: 'stripe',
            card: {
              cardnum: '************4242',
              expdate: '1230',
              startdate: '',
              issuenumber: '',
            },
          },
        ],
      },
    };
    const c = mapToCanonicalPayMethods(raw);
    expect(c.entity).toBe('transaction');
    expect(c.data.clientId).toBe(42);
    expect(c.data.payMethods).toHaveLength(1);
    const pm = c.data.payMethods[0];
    expect(pm.payMethodId).toBe(7);
    expect(pm.type).toBe('CreditCard');
    expect(pm.description).toBe('Visa ending 4242');
    expect(pm.gateway).toBe('stripe');
    // masked value present in WHMCS → safe last4
    expect(pm.lastFour).toBe('4242');
    // raw card material retained in canonical (dropped only at projection)
    expect(pm.card?.cardNumber).toBe('************4242');
    expect(pm.card?.expiryDate).toBe('1230');

    // CRITICAL: every card/bank/token field classed secret.credential.
    expect(c.classes['payMethods[].card.cardNumber']).toBe('secret.credential');
    expect(c.classes['payMethods[].card.expiryDate']).toBe('secret.credential');
    expect(c.classes['payMethods[].card.startDate']).toBe('secret.credential');
    expect(c.classes['payMethods[].card.issueNumber']).toBe('secret.credential');
    expect(c.classes['payMethods[].card']).toBe('secret.credential');
    expect(c.classes['payMethods[].bankAccount']).toBe('secret.credential');
    expect(c.classes['payMethods[].remoteToken']).toBe('secret.credential');
    // Display-safe values.
    expect(c.classes['payMethods[].lastFour']).toBe('business.label');
    expect(c.classes['payMethods[].description']).toBe('business.label');
    expect(c.classes['payMethods[].gateway']).toBe('financial.reference');
    expect(c.classes['payMethods[].payMethodId']).toBe('business.identifier');
    expect(c.classes.clientId).toBe('business.identifier');
    assertClassmapComplete(c);
  });

  it('NEVER derives last4 from a raw PAN', () => {
    const raw = {
      paymethods: {
        paymethod: {
          id: 1,
          type: 'CreditCard',
          card: { cardnum: '4111111111111111', expdate: '1230' },
        },
      },
    };
    const c = mapToCanonicalPayMethods(raw);
    const pm = c.data.payMethods[0];
    // Raw, unmasked PAN ⇒ refuse to surface any last4.
    expect(pm.lastFour).toBeNull();
    // Raw PAN is still retained in canonical (it is secret.credential, dropped
    // at projection), but never as lastFour.
    expect(pm.card?.cardNumber).toBe('4111111111111111');
    assertClassmapComplete(c);
  });

  it('classes bank-account material secret + tolerates a single object', () => {
    const raw = {
      clientid: 9,
      paymethods: {
        paymethod: {
          id: 3,
          type: 'BankAccount',
          description: 'Checking',
          gateway: 'gocardless',
          bankaccount: {
            accountnumber: '000123456',
            accounttype: 'Checking',
            routingnumber: '110000000',
            bankname: 'Acme Bank',
          },
        },
      },
    };
    const c = mapToCanonicalPayMethods(raw);
    expect(c.data.payMethods).toHaveLength(1);
    const pm = c.data.payMethods[0];
    expect(pm.card).toBeNull();
    expect(pm.bankAccount?.accountNumber).toBe('000123456');
    expect(c.classes['payMethods[].bankAccount.accountNumber']).toBe(
      'secret.credential'
    );
    expect(c.classes['payMethods[].bankAccount.routingNumber']).toBe(
      'secret.credential'
    );
    assertClassmapComplete(c);
  });

  it('captures a gateway remote token as secret', () => {
    const raw = {
      clientid: 5,
      paymethods: {
        paymethod: {
          id: 11,
          type: 'RemoteToken',
          description: 'Saved card',
          gateway: 'stripe',
          remotetoken: { token: 'tok_secret_abc123' },
        },
      },
    };
    const c = mapToCanonicalPayMethods(raw);
    expect(c.data.payMethods[0].remoteToken).toBe('tok_secret_abc123');
    expect(c.classes['payMethods[].remoteToken']).toBe('secret.credential');
    assertClassmapComplete(c);
  });

  it('handles empty paymethods {} and garbage', () => {
    const empty = mapToCanonicalPayMethods({ clientid: 1, paymethods: {} });
    expect(empty.data.payMethods).toEqual([]);
    assertClassmapComplete(empty);

    const garbage = mapToCanonicalPayMethods(undefined);
    expect(garbage.data.clientId).toBeNull();
    expect(garbage.data.payMethods).toEqual([]);
    assertClassmapComplete(garbage);
  });
});

describe('mapToCanonicalCredits', () => {
  it('maps GetCredits with credits.credit wrapper', () => {
    const raw = {
      result: 'success',
      clientid: 42,
      credits: {
        credit: [
          {
            id: '100',
            date: '2026-01-01',
            description: 'Refund credit',
            amount: '25.00',
            relid: '500',
          },
          { id: 101, date: '2026-02-01', description: 'Promo', amount: '5', relid: 0 },
        ],
      },
    };
    const c = mapToCanonicalCredits(raw);
    expect(c.entity).toBe('transaction');
    expect(c.data.clientId).toBe(42);
    expect(c.data.credits).toHaveLength(2);
    expect(c.data.credits[0].creditId).toBe(100);
    expect(c.data.credits[0].amount).toBe(25);
    expect(c.data.credits[0].relatedId).toBe(500);
    expect(c.classes['credits[].amount']).toBe('financial.amount');
    expect(c.classes['credits[].description']).toBe('business.label');
    expect(c.classes['credits[].date']).toBe('public.safe');
    expect(c.classes['credits[].creditId']).toBe('business.identifier');
    expect(c.classes.clientId).toBe('business.identifier');
    assertClassmapComplete(c);
  });

  it('tolerates a single credit object, empty {}, and garbage', () => {
    const single = mapToCanonicalCredits({
      clientid: 1,
      credits: { credit: { id: 7, amount: '1.00' } },
    });
    expect(single.data.credits).toHaveLength(1);
    expect(single.data.credits[0].creditId).toBe(7);
    assertClassmapComplete(single);

    const empty = mapToCanonicalCredits({ clientid: 1, credits: {} });
    expect(empty.data.credits).toEqual([]);
    assertClassmapComplete(empty);

    const garbage = mapToCanonicalCredits(null);
    expect(garbage.data.clientId).toBeNull();
    expect(garbage.data.credits).toEqual([]);
    assertClassmapComplete(garbage);
  });
});
