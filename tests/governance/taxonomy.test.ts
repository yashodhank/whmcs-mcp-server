/**
 * PHASE H.1 / Track B — classification taxonomy expansion.
 *
 * Proves the three new FieldClasses exist, that every one of the 9 frozen
 * ContractPolicy maps has a (correct + safe) entry for each, and that the
 * secret.credential drop-invariant + env restrictions are UNCHANGED.
 *
 * Synthetic data only.
 */

import { describe, it, expect } from 'vitest';
import {
  FIELD_CLASSES,
  CONTRACT_NAMES,
  type FieldClass,
} from '../../src/governance/types.js';
import { CONTRACTS } from '../../src/governance/contracts.js';

const NEW_CLASSES: FieldClass[] = [
  'business.label',
  'system.status',
  'system.diagnostic',
];

describe('new FieldClasses are part of the frozen taxonomy', () => {
  it('FIELD_CLASSES contains business.label, system.status, system.diagnostic', () => {
    for (const c of NEW_CLASSES) {
      expect(FIELD_CLASSES).toContain(c);
    }
  });

  it('every one of the 9 contracts has an entry for each new class (exhaustive)', () => {
    for (const name of CONTRACT_NAMES) {
      const policy = CONTRACTS[name].policy;
      for (const c of NEW_CLASSES) {
        expect(
          policy[c],
          `${name} missing action for ${c}`
        ).toBeTruthy();
      }
    }
  });
});

describe('new class actions are correct + safe', () => {
  it('business.label is allow in EVERY contract (non-sensitive business metadata)', () => {
    for (const name of CONTRACT_NAMES) {
      expect(
        CONTRACTS[name].policy['business.label'],
        `${name} must allow business.label`
      ).toBe('allow');
    }
  });

  it('system.status is allow in EVERY contract (presence/flags/counts only)', () => {
    for (const name of CONTRACT_NAMES) {
      expect(
        CONTRACTS[name].policy['system.status'],
        `${name} must allow system.status`
      ).toBe('allow');
    }
  });

  it('system.diagnostic: allow for trusted operator/admin/local, drop for LLM/portal, summarize for the conservative automations', () => {
    expect(CONTRACTS.ops_operator.policy['system.diagnostic']).toBe('allow');
    expect(CONTRACTS.admin_full_trusted.policy['system.diagnostic']).toBe(
      'allow'
    );
    expect(CONTRACTS.debug_local.policy['system.diagnostic']).toBe('allow');
    expect(CONTRACTS.none_local_only.policy['system.diagnostic']).toBe(
      'allow'
    );
    expect(CONTRACTS.llm_safe_summary.policy['system.diagnostic']).toBe(
      'drop'
    );
    expect(CONTRACTS.client_portal_self.policy['system.diagnostic']).toBe(
      'drop'
    );
    expect(CONTRACTS.billing_reconciliation.policy['system.diagnostic']).toBe(
      'summarize'
    );
    expect(CONTRACTS.renewal_automation.policy['system.diagnostic']).toBe(
      'summarize'
    );
    expect(CONTRACTS.support_triage.policy['system.diagnostic']).toBe(
      'summarize'
    );
  });
});

describe('hard invariants UNCHANGED by the taxonomy expansion', () => {
  it('secret.credential remains drop in every non-local contract', () => {
    for (const name of CONTRACT_NAMES) {
      if (name === 'debug_local' || name === 'none_local_only') continue;
      expect(CONTRACTS[name].policy['secret.credential']).toBe('drop');
    }
    expect(CONTRACTS.debug_local.policy['secret.credential']).toBe('mask');
    expect(CONTRACTS.none_local_only.policy['secret.credential']).toBe(
      'allow'
    );
  });

  it('debug_local & none_local_only stay local-only', () => {
    expect(CONTRACTS.debug_local.envRestrictions).toEqual(['local']);
    expect(CONTRACTS.none_local_only.envRestrictions).toEqual(['local']);
  });
});
