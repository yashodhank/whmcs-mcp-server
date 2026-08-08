import { describe, expect, it } from 'vitest';
import { intentToWhmcsParams } from '../../src/write/paramMapping.js';
import { SCOPE_ACTION, SCOPE_RISK, WRITE_SCOPES, type WriteIntent } from '../../src/write/types.js';
import { validateIntent } from '../../src/write/validation.js';

const intent = (params: Record<string, unknown>): WriteIntent => ({
  intent_id: 'order-create-test',
  consumer_id: 'test',
  scope: 'order:create',
  action: SCOPE_ACTION['order:create'],
  risk: SCOPE_RISK['order:create'],
  params,
  idempotency_key: 'order-create-test-key',
  preconditions: {},
  projected_effect: 'Create a payment-pending order without acceptance or email.',
  state: 'draft',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});

describe('order:create governed contract', () => {
  it('is registered as a high-risk AddOrder scope', () => {
    expect(WRITE_SCOPES).toContain('order:create');
    expect(SCOPE_ACTION['order:create']).toBe('AddOrder');
    expect(SCOPE_RISK['order:create']).toBe('high');
  });

  it('maps domains to WHMCS parallel arrays and suppresses email', () => {
    expect(
      intentToWhmcsParams('order:create', {
        clientid: 279,
        paymentmethod: 'mailin',
        domains: [
          { domain: 'geodscvr.app', regperiod: 1, price: 2549 },
          { domain: 'geodscvr.io', regperiod: 1, price: 6900 },
        ],
        evil: 'dropped',
      })
    ).toEqual({
      clientid: 279,
      domain: ['geodscvr.app', 'geodscvr.io'],
      domaintype: ['register', 'register'],
      regperiod: [1, 1],
      domainpriceoverride: [2549, 6900],
      paymentmethod: 'mailin',
      noinvoice: false,
      noemail: true,
    });
  });

  it('rejects malformed rows before execution', () => {
    const result = validateIntent(
      intent({
        clientid: 279,
        paymentmethod: 'mailin',
        domains: [{ domain: 'geodscvr.app', regperiod: 0, price: -1 }],
      }),
      {}
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['order_create_regperiod_invalid', 'order_create_price_invalid'])
    );
  });
});
