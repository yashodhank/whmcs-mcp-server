/**
 * Enhanced billing business-logic validation tests.
 *
 * Proves: invoice negative item amounts emit warnings (not errors),
 * taxed items emit a compat_warning, credit large/negative amount checks,
 * refund negative/large amount checks, payment non-positive amount checks.
 * Also confirms existing validation rules are unaffected.
 */

import { describe, it, expect } from 'vitest';
import { createDraftIntent } from '../../src/write/intents.js';
import { validateIntent } from '../../src/write/validation.js';

/* ── Helpers ───────────────────────────────────────────────────────────── */

function invoiceIntent(items: unknown[]) {
  return createDraftIntent({
    consumer_id: 'c1',
    scope: 'billing:invoice:create',
    params: { userid: 1, items },
    naturalKey: 'inv:enhanced',
    preconditions: {},
    projected_effect: 'create invoice',
  });
}

function creditIntent(amount: unknown) {
  return createDraftIntent({
    consumer_id: 'c1',
    scope: 'billing:credit:add',
    params: { clientid: 1, amount, description: 'test credit' },
    naturalKey: 'cr:enhanced',
    preconditions: {},
    projected_effect: 'add credit',
  });
}

function refundIntent(amount: unknown) {
  return createDraftIntent({
    consumer_id: 'c1',
    scope: 'billing:refund:record',
    params: {
      invoiceid: 1,
      amount,
      refund_type: 'Credit',
      paymentmethod: 'stripe',
    },
    naturalKey: 'ref:enhanced',
    preconditions: {},
    projected_effect: 'refund',
  });
}

function paymentIntent(amount: unknown) {
  return createDraftIntent({
    consumer_id: 'c1',
    scope: 'billing:payment:add',
    params: { invoiceid: 1, amount },
    naturalKey: 'pay:enhanced',
    preconditions: {},
    projected_effect: 'add payment',
  });
}

/* ── Invoice line items ────────────────────────────────────────────────── */

describe('enhanced validation: billing:invoice:create', () => {
  it('emits WARNING for negative item amounts (ok still true)', () => {
    const intent = invoiceIntent([
      { description: 'Discount', amount: -10 },
      { description: 'Service', amount: 50 },
    ]);
    const res = validateIntent(intent, {});
    // Negative item amount is a warning, not an error → ok stays true.
    const negWarnings = res.issues.filter(
      (i) => i.code === 'negative_item_amount' && i.severity === 'warning'
    );
    expect(negWarnings).toHaveLength(1);
    expect(negWarnings[0].message).toContain('-10');
    // ok should still be true (no errors from this).
    expect(res.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(res.ok).toBe(true);
  });

  it('emits compat_warning when an item has taxed=true', () => {
    const intent = invoiceIntent([{ description: 'Taxable item', amount: 100, taxed: true }]);
    const res = validateIntent(intent, {});
    const taxWarnings = res.compat_warnings.filter((w) => w.includes('taxed is true'));
    expect(taxWarnings.length).toBeGreaterThanOrEqual(1);
    expect(taxWarnings[0]).toContain('items[0].taxed');
    expect(taxWarnings[0]).toContain('WHMCS 8 and 9');
  });

  it('emits compat_warning per-item for multiple taxed items', () => {
    const intent = invoiceIntent([
      { description: 'A', amount: 10, taxed: true },
      { description: 'B', amount: 20 },
      { description: 'C', amount: 30, taxed: true },
    ]);
    const res = validateIntent(intent, {});
    const taxWarnings = res.compat_warnings.filter((w) => w.includes('taxed is true'));
    expect(taxWarnings).toHaveLength(2);
  });

  it('does not emit warnings for valid positive amounts', () => {
    const intent = invoiceIntent([
      { description: 'Service', amount: 100 },
      { description: 'Hosting', amount: 50 },
    ]);
    const res = validateIntent(intent, {});
    expect(res.issues.filter((i) => i.code === 'negative_item_amount')).toHaveLength(0);
    expect(res.ok).toBe(true);
  });
});

/* ── Credit amount threshold ──────────────────────────────────────────── */

describe('enhanced validation: billing:credit:add', () => {
  it('emits WARNING when credit amount > 10000', () => {
    const intent = creditIntent(15000);
    const res = validateIntent(intent, {});
    const warnings = res.issues.filter(
      (i) => i.code === 'large_credit_amount' && i.severity === 'warning'
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('>10000');
    // Warning only → ok still true.
    expect(res.ok).toBe(true);
  });

  it('emits ERROR when credit amount is negative', () => {
    const intent = creditIntent(-50);
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    const errors = res.issues.filter(
      (i) => i.code === 'negative_credit_amount' && i.severity === 'error'
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('positive');
  });

  it('no warning for amount <= 10000 and positive', () => {
    const intent = creditIntent(500);
    const res = validateIntent(intent, {});
    expect(
      res.issues.filter(
        (i) => i.code === 'large_credit_amount' || i.code === 'negative_credit_amount'
      )
    ).toHaveLength(0);
    expect(res.ok).toBe(true);
  });

  it('no warning for amount exactly 10000', () => {
    const intent = creditIntent(10000);
    const res = validateIntent(intent, {});
    expect(res.issues.filter((i) => i.code === 'large_credit_amount')).toHaveLength(0);
    expect(res.ok).toBe(true);
  });
});

/* ── Refund amount validation ─────────────────────────────────────────── */

describe('enhanced validation: billing:refund:record', () => {
  it('emits ERROR when refund amount is negative', () => {
    const intent = refundIntent(-100);
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    const errors = res.issues.filter(
      (i) => i.code === 'negative_refund_amount' && i.severity === 'error'
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('positive');
  });

  it('emits WARNING when refund amount > 50000', () => {
    const intent = refundIntent(75000);
    const res = validateIntent(intent, {});
    const warnings = res.issues.filter(
      (i) => i.code === 'large_refund_amount' && i.severity === 'warning'
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('Very large refund');
    // Warning only → ok still true.
    expect(res.ok).toBe(true);
  });

  it('no warning for a normal positive refund amount', () => {
    const intent = refundIntent(250);
    const res = validateIntent(intent, {});
    expect(
      res.issues.filter(
        (i) => i.code === 'negative_refund_amount' || i.code === 'large_refund_amount'
      )
    ).toHaveLength(0);
    expect(res.ok).toBe(true);
  });
});

/* ── Payment amount validation ────────────────────────────────────────── */

describe('enhanced validation: billing:payment:add', () => {
  it('emits ERROR when payment amount is zero', () => {
    const intent = paymentIntent(0);
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    const errors = res.issues.filter(
      (i) => i.code === 'non_positive_payment_amount' && i.severity === 'error'
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('positive');
  });

  it('emits ERROR when payment amount is negative', () => {
    const intent = paymentIntent(-5);
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'non_positive_payment_amount')).toBe(true);
  });

  it('no error for a positive payment amount', () => {
    const intent = paymentIntent(100);
    const res = validateIntent(intent, {});
    expect(res.issues.filter((i) => i.code === 'non_positive_payment_amount')).toHaveLength(0);
    expect(res.ok).toBe(true);
  });
});

/* ── Existing validation still passes ─────────────────────────────────── */

describe('enhanced validation: existing rules unaffected', () => {
  it('well-formed client_note intent still passes', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'client_note:write',
      params: { clientid: 42, note: 'hello' },
      naturalKey: 'client:42:note',
      preconditions: { client_exists: true },
      projected_effect: 'note',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('missing required param still fails', () => {
    const intent = createDraftIntent({
      consumer_id: 'c1',
      scope: 'client_note:write',
      params: { clientid: 42 },
      naturalKey: 'client:42:note',
      preconditions: {},
      projected_effect: 'note',
    });
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
  });

  it('billing:invoice:create with empty items still fails', () => {
    const intent = invoiceIntent([]);
    const res = validateIntent(intent, {});
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'invalid_items_shape')).toBe(true);
  });
});
