/**
 * deriveToolMeta unit tests — the `_meta` governance-hint derivation.
 *
 * Hints are derived purely from the existing result payload; a payload with no
 * hint-worthy fields yields `undefined` (so the result stays byte-identical).
 */

import { describe, it, expect } from 'vitest';
import { deriveToolMeta, META_PREFIX } from '../../src/tools/meta.js';

const k = (s: string) => `${META_PREFIX}/${s}`;

describe('deriveToolMeta — write-flow payloads', () => {
  it('surfaces risk tier + scope + stage from an intent payload', () => {
    const meta = deriveToolMeta({
      intent: { risk: 'high', scope: 'billing:invoice:create' },
      stage: 'draft',
      required_approvals: 2,
      executed: false,
    });
    expect(meta).toMatchObject({
      [k('risk_tier')]: 'high',
      [k('scope')]: 'billing:invoice:create',
      [k('stage')]: 'draft',
      [k('required_approvals')]: 2,
      [k('executed')]: false,
    });
  });

  it('falls back to risk_flags[0] when there is no intent object', () => {
    const meta = deriveToolMeta({ risk_flags: ['low'], scope: 'client_note:write' });
    expect(meta?.[k('risk_tier')]).toBe('low');
    expect(meta?.[k('scope')]).toBe('client_note:write');
  });

  it('carries executed:true through for an execute-stage result', () => {
    const meta = deriveToolMeta({ intent: { risk: 'low' }, stage: 'execute', executed: true });
    expect(meta?.[k('executed')]).toBe(true);
    expect(meta?.[k('stage')]).toBe('execute');
  });
});

describe('deriveToolMeta — workflow payloads', () => {
  it('advertises the workflow name + draft/skip counts', () => {
    const meta = deriveToolMeta({
      workflow: 'dunning_sweep',
      drafted_intent_ids: ['a', 'b', 'c'],
      skipped: [{ ref: {}, reason: 'x' }],
      executed: false,
    });
    expect(meta).toMatchObject({
      [k('workflow')]: 'dunning_sweep',
      [k('drafted_count')]: 3,
      [k('skipped_count')]: 1,
      [k('executed')]: false,
    });
  });
});

describe('deriveToolMeta — nothing to advertise', () => {
  it('returns undefined for a hint-free payload', () => {
    expect(deriveToolMeta({ some: 'data', n: 1 })).toBeUndefined();
  });

  it('returns undefined for an empty payload', () => {
    expect(deriveToolMeta({})).toBeUndefined();
  });
});
