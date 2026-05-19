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

  // ── Phase G+: broadened intent-contract required fields ──────────────

  it('billing:refund:record without refund_type ⇒ validation error', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'billing:refund:record',
      params: { invoiceid: 1, amount: 10, paymentmethod: 'stripe' },
      naturalKey: 'r:1',
      preconditions: {},
      projected_effect: 'refund',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(
      res.issues.some(
        (i) => i.code === 'missing_required_param' && i.message.includes('refund_type')
      )
    ).toBe(true);
  });

  it('billing:refund:record with invalid refund_type ⇒ validation error', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'billing:refund:record',
      params: {
        invoiceid: 1,
        amount: 10,
        refund_type: 'NotARealType',
        paymentmethod: 'stripe',
      },
      naturalKey: 'r:2',
      preconditions: {},
      projected_effect: 'refund',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'invalid_refund_type')).toBe(true);
  });

  it('billing:credit:add without description ⇒ validation error (new required field)', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'billing:credit:add',
      params: { clientid: 1, amount: 5 },
      naturalKey: 'c:1',
      preconditions: {},
      projected_effect: 'credit',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(
      res.issues.some(
        (i) => i.code === 'missing_required_param' && i.message.includes('description')
      )
    ).toBe(true);
  });

  it('ticket:create requires deptid and an identity disjunction (clientid OR name+email)', () => {
    // missing deptid
    const noDept = createDraftIntent({
      consumer_id: 'c1',
      scope: 'ticket:create',
      params: { subject: 's', message: 'm', clientid: 1 },
      naturalKey: 't:no-dept',
      preconditions: {},
      projected_effect: 't',
    });
    const r1 = validateIntent(noDept, {});
    expect(r1.ok).toBe(false);
    expect(
      r1.issues.some((i) => i.code === 'missing_required_param' && i.message.includes('deptid'))
    ).toBe(true);

    // present deptid but neither identity
    const noIdent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'ticket:create',
      params: { deptid: 1, subject: 's', message: 'm' },
      naturalKey: 't:no-ident',
      preconditions: {},
      projected_effect: 't',
    });
    const r2 = validateIntent(noIdent, {});
    expect(r2.ok).toBe(false);
    expect(
      r2.issues.some((i) => i.code === 'missing_required_param' && i.message.includes('clientid'))
    ).toBe(true);

    // name+email satisfies the disjunction
    const withEmail = createDraftIntent({
      consumer_id: 'c1',
      scope: 'ticket:create',
      params: { deptid: 1, subject: 's', message: 'm', name: 'a', email: 'a@b' },
      naturalKey: 't:email',
      preconditions: {},
      projected_effect: 't',
    });
    const r3 = validateIntent(withEmail, {});
    expect(r3.ok).toBe(true);
  });

  it('ticket:status with an unknown status ⇒ invalid_status_enum error', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'ticket:status',
      params: { ticketid: 1, status: 'NotAStatus' },
      naturalKey: 't:bad-status',
      preconditions: {},
      projected_effect: 't',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'invalid_status_enum')).toBe(true);
  });

  it('billing:invoice:create with empty items[] ⇒ invalid_items_shape error', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'billing:invoice:create',
      params: { userid: 1, items: [] },
      naturalKey: 'inv:empty',
      preconditions: {},
      projected_effect: 'inv',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'invalid_items_shape')).toBe(true);
  });

  it('billing:invoice:create with non-array items ⇒ invalid_items_shape error', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'billing:invoice:create',
      params: { userid: 1, items: { 0: 'x' } },
      naturalKey: 'inv:badshape',
      preconditions: {},
      projected_effect: 'inv',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'invalid_items_shape')).toBe(true);
  });

  it('billing:invoice:create with item lacking description ⇒ invalid_items_shape error', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'billing:invoice:create',
      params: { userid: 1, items: [{ amount: 5 }] },
      naturalKey: 'inv:nodesc',
      preconditions: {},
      projected_effect: 'inv',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'invalid_items_shape')).toBe(true);
  });
});
