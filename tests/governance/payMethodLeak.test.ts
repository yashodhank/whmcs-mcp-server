/**
 * CRITICAL regression: stored payment instruments (card/bank/token) must NEVER
 * survive projection to non-local consumers.
 *
 * Projection is now RECURSIVE, so the container `payMethods` is `public.safe`
 * (a gate that lets the array appear) while every nested `secret.credential`
 * LEAF (`payMethods[].card.*`, `bankAccount.*`, `remoteToken`, and the
 * `card`/`bankAccount` container nodes) is DROPPED by recursion. This test
 * plants a raw PAN / bank / token and asserts:
 *   - the raw secret strings are ABSENT for every non-local contract;
 *   - the payMethods array IS present with its SAFE fields (type, lastFour,
 *     description, payMethodId) for those same contracts;
 *   - the local debug contract may still see the instruments (env-gated).
 */
import { describe, it, expect } from 'vitest';
import { getContract } from '../../src/governance/contracts.js';
import { project } from '../../src/governance/projection.js';
import { mapToCanonicalPayMethods } from '../../src/canonical/payMethod.js';

const RAW = {
  result: 'success',
  clientid: 7,
  paymethods: {
    paymethod: [
      {
        id: 7,
        type: 'CreditCard',
        description: 'Visa ****4242',
        gateway_name: 'stripe',
        card: {
          cardnum: '4111111111111111',
          expdate: '1226',
          lastfour: '4242',
        },
        remotetoken: 'tok_live_SECRET',
        bankacct: '000123456789',
        bankcode: '110000000',
      },
    ],
  },
};

const NON_LOCAL = [
  'llm_safe_summary',
  'ops_operator',
  'client_portal_self',
  'admin_full_trusted',
];

interface ProjectedPayMethod {
  type?: unknown;
  lastFour?: unknown;
  description?: unknown;
  payMethodId?: unknown;
  card?: unknown;
  bankAccount?: unknown;
  remoteToken?: unknown;
}

describe('payMethods projection — granular, no raw instrument leak (CRITICAL guard)', () => {
  for (const name of NON_LOCAL) {
    it(`drops nested secret leaves but keeps safe fields for ${name}`, () => {
      const canon = mapToCanonicalPayMethods(RAW);
      const out = project(canon, getContract(name), 'production');
      const blob = JSON.stringify(out);

      // No raw instrument material survives, anywhere in the blob.
      expect(blob).not.toContain('4111111111111111');
      expect(blob).not.toContain('tok_live_SECRET');
      expect(blob).not.toContain('000123456789');
      expect(blob).not.toContain('1226'); // raw expiry

      // The container array IS present (public.safe gate), with safe leaves.
      expect(Array.isArray(out.payMethods)).toBe(true);
      const arr = out.payMethods as ProjectedPayMethod[];
      expect(arr).toHaveLength(1);
      const pm = arr[0];
      expect(pm.type).toBe('CreditCard');
      expect(pm.lastFour).toBe('4242'); // WHMCS-provided masked last4 survives
      expect(pm.payMethodId).toBe(7);

      // Every secret leaf / container is DROPPED by recursion.
      expect('card' in pm).toBe(false);
      expect('bankAccount' in pm).toBe(false);
      expect('remoteToken' in pm).toBe(false);
    });
  }

  it('local debug contract may see it (env-gated, local only)', () => {
    const canon = mapToCanonicalPayMethods(RAW);
    // none_local_only allows secrets but only in env=local
    const out = project(canon, getContract('none_local_only'), 'local');
    expect(out.payMethods).toBeDefined();
    const arr = out.payMethods as ProjectedPayMethod[];
    expect(arr[0].remoteToken).toBe('tok_live_SECRET');
    expect(JSON.stringify(out)).toContain('4111111111111111');
  });
});
