/**
 * CRITICAL regression: stored payment instruments (card/bank/token) must NEVER
 * survive projection to non-local consumers. The container `payMethods` is
 * classed secret.credential (fail-closed) because project() walks only top-level
 * keys — so a public.safe container would emit raw card data. This test plants a
 * raw PAN/bank/token and asserts it's gone for every non-local contract.
 */
import { describe, it, expect } from 'vitest';
import { getContract } from '../../src/governance/contracts.js';
import { project } from '../../src/governance/projection.js';
import { mapToCanonicalPayMethods } from '../../src/canonical/payMethod.js';

const RAW = {
  result: 'success',
  paymethods: {
    paymethod: [
      {
        id: 7,
        type: 'CreditCard',
        description: 'Visa ****4242',
        gateway_name: 'stripe',
        cardnum: '4111111111111111',
        expdate: '1226',
        remotetoken: 'tok_live_SECRET',
        bankacct: '000123456789',
        bankcode: '110000000',
      },
    ],
  },
};

const NON_LOCAL = ['llm_safe_summary', 'ops_operator', 'client_portal_self', 'admin_full_trusted'];

describe('payMethods projection — no raw instrument leak (CRITICAL guard)', () => {
  for (const name of NON_LOCAL) {
    it(`drops the payMethods container for ${name}`, () => {
      const canon = mapToCanonicalPayMethods(RAW, 7);
      const out = project(canon, getContract(name), 'production');
      const blob = JSON.stringify(out);
      expect(blob).not.toContain('4111111111111111');
      expect(blob).not.toContain('tok_live_SECRET');
      expect(blob).not.toContain('000123456789');
      // container omitted entirely (secret.credential → drop)
      expect(out.payMethods).toBeUndefined();
    });
  }

  it('local debug contract may see it (env-gated, local only)', () => {
    const canon = mapToCanonicalPayMethods(RAW, 7);
    // none_local_only allows secrets but only in env=local
    const out = project(canon, getContract('none_local_only'), 'local');
    expect(out.payMethods).toBeDefined();
  });
});
