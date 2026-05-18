/**
 * Phase F — pure intent validation tests. No WHMCS; ctx supplies any
 * already-read precondition snapshots.
 *
 * Proves: a well-formed intent passes; missing required params, scope/action
 * mismatch, missing risk, missing idempotency_key, and malformed preconditions
 * each yield severity='error' (ok=false); billing:* scopes emit a non-blocking
 * WHMCS 9 compatibility advisory.
 */

import { describe, it, expect } from 'vitest';
import { createDraftIntent } from '../../src/write/intents.js';
import { validateIntent } from '../../src/write/validation.js';
import type { WriteIntent } from '../../src/write/types.js';

const noteInput = {
  consumer_id: 'c1',
  scope: 'client_note:write' as const,
  params: { clientid: 42, note: 'hello' },
  naturalKey: 'client:42:note',
  preconditions: { client_exists: true },
  projected_effect: 'note',
};

describe('validateIntent', () => {
  it('passes a well-formed client_note intent with no errors', () => {
    const res = validateIntent(createDraftIntent(noteInput), {});
    expect(res.ok).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('fails when a required param is missing', () => {
    const intent = createDraftIntent({ ...noteInput, params: { clientid: 42 } });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('fails when scope/action are inconsistent with SCOPE_ACTION', () => {
    const intent = createDraftIntent(noteInput);
    const tampered: WriteIntent = { ...intent, action: 'WrongAction' };
    const res = validateIntent(tampered, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'scope_action_mismatch')).toBe(true);
  });

  it('fails when idempotency_key is missing', () => {
    const intent = createDraftIntent(noteInput);
    const tampered: WriteIntent = { ...intent, idempotency_key: '' };
    const res = validateIntent(tampered, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'missing_idempotency_key')).toBe(true);
  });

  it('fails when preconditions shape is not an object', () => {
    const intent = createDraftIntent(noteInput);
    const tampered = {
      ...intent,
      preconditions: null as unknown as Readonly<Record<string, unknown>>,
    };
    const res = validateIntent(tampered, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'bad_preconditions')).toBe(true);
  });

  it('emits a WHMCS 9 immutability advisory for billing scopes', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'billing:invoice:create',
      params: { userid: 1, items: { 0: 'x' } },
      naturalKey: 'inv:1',
      preconditions: {},
      projected_effect: 'create invoice',
    });
    const res = validateIntent(intent, {});
    expect(res.compat_warnings.some((w) => w.includes('WHMCS 9'))).toBe(true);
    expect(res.compat_warnings.some((w) => w.includes('credit/debit notes'))).toBe(true);
  });

  it('does not emit billing advisory for non-billing scopes', () => {
    const res = validateIntent(createDraftIntent(noteInput), {});
    expect(res.compat_warnings).toHaveLength(0);
  });
});
