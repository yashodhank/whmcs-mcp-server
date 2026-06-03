/**
 * Track C2 — governed quote scopes (create/update/send/accept) over the tiered
 * write model. Covers the frozen-seam action/risk maps, the strict line-item
 * flattening mappers, and validation. Mirrors the patterns in trackC.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  type WriteIntent,
} from '../../src/write/types.js';
import { intentToWhmcsParams } from '../../src/write/paramMapping.js';
import { validateIntent } from '../../src/write/validation.js';

function intent(scope: WriteIntent['scope'], params: Record<string, unknown>): WriteIntent {
  return {
    intent_id: 'i',
    consumer_id: 'c',
    scope,
    action: SCOPE_ACTION[scope],
    risk: SCOPE_RISK[scope],
    params,
    idempotency_key: 'k',
    preconditions: {},
    projected_effect: 'x',
    state: 'draft',
    created_at: '2026-06-03T00:00:00.000Z',
    expires_at: '2026-06-03T01:00:00.000Z',
  };
}

describe('Track C2 quote frozen-seam additions', () => {
  it('registers the four quote scopes with correct action + risk', () => {
    const expectQuote: Record<string, [string, string]> = {
      'billing:quote:create': ['CreateQuote', 'medium'],
      'billing:quote:update': ['UpdateQuote', 'medium'],
      'billing:quote:send': ['SendQuote', 'low'],
      'billing:quote:accept': ['AcceptQuote', 'high'],
    };
    for (const [scope, [action, risk]] of Object.entries(expectQuote)) {
      expect(WRITE_SCOPES as readonly string[]).toContain(scope);
      expect(SCOPE_ACTION[scope as keyof typeof SCOPE_ACTION]).toBe(action);
      expect(SCOPE_RISK[scope as keyof typeof SCOPE_RISK]).toBe(risk);
    }
  });
});

describe('Track C2 quote strict mappers', () => {
  it('billing:quote:create flattens items into lineitem{field}{N}, copies allowlist, drops items/extras', () => {
    const out = intentToWhmcsParams('billing:quote:create', {
      subject: 'S',
      stage: 'Draft',
      validuntil: '2026-12-31',
      userid: 4,
      items: [
        { description: 'L1', amount: 100, taxed: true },
        { description: 'L2', amount: 50 },
      ],
      evil: 'x',
    });
    expect(out.subject).toBe('S');
    expect(out.stage).toBe('Draft');
    expect(out.validuntil).toBe('2026-12-31');
    expect(out.userid).toBe(4);
    expect(out.lineitemdescription1).toBe('L1');
    expect(out.lineitemamount1).toBe(100);
    expect(out.lineitemtaxed1).toBe(1);
    expect(out.lineitemdescription2).toBe('L2');
    expect(out.lineitemamount2).toBe(50);
    expect(out).not.toHaveProperty('lineitemtaxed2');
    expect(out).not.toHaveProperty('items');
    expect(out).not.toHaveProperty('evil');
  });

  it('billing:quote:update emits quoteid + present allowlisted fields, flattens optional items', () => {
    expect(intentToWhmcsParams('billing:quote:update', { quoteid: 2, subject: 'New', evil: 'x' })).toEqual({
      quoteid: 2,
      subject: 'New',
    });
    const withItems = intentToWhmcsParams('billing:quote:update', {
      quoteid: 2,
      items: [{ description: 'L', amount: 5, taxed: true }],
    });
    expect(withItems.quoteid).toBe(2);
    expect(withItems.lineitemdescription1).toBe('L');
    expect(withItems.lineitemamount1).toBe(5);
    expect(withItems.lineitemtaxed1).toBe(1);
    expect(withItems).not.toHaveProperty('items');
  });

  it('billing:quote:send emits EXACTLY {quoteid}, drops extras', () => {
    expect(intentToWhmcsParams('billing:quote:send', { quoteid: 2, evil: 'x' })).toEqual({
      quoteid: 2,
    });
  });

  it('billing:quote:accept emits EXACTLY {quoteid}, drops planted paymentmethod/extra', () => {
    const out = intentToWhmcsParams('billing:quote:accept', {
      quoteid: 2,
      paymentmethod: 'stripe',
      extra: 'x',
    });
    expect(out).toEqual({ quoteid: 2 });
    expect(out).not.toHaveProperty('paymentmethod');
  });
});

describe('Track C2 quote validation', () => {
  const validCreate = {
    subject: 'S',
    stage: 'Draft',
    validuntil: '2026-12-31',
    userid: 4,
    items: [
      { description: 'L1', amount: 100, taxed: true },
      { description: 'L2', amount: 50 },
    ],
  };

  it('billing:quote:create accepts a well-formed intent', () => {
    expect(validateIntent(intent('billing:quote:create', validCreate), {}).ok).toBe(true);
  });

  it('billing:quote:create accepts identity via valid email when no userid', () => {
    const { userid, ...rest } = validCreate;
    void userid;
    expect(
      validateIntent(
        intent('billing:quote:create', { ...rest, email: 'buyer@example.test' }),
        {}
      ).ok
    ).toBe(true);
  });

  it('billing:quote:create rejects an invalid stage', () => {
    const r = validateIntent(
      intent('billing:quote:create', { ...validCreate, stage: 'Bogus' }),
      {}
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_quote_stage')).toBe(true);
  });

  it('billing:quote:create rejects when neither userid nor valid email present', () => {
    const { userid, ...rest } = validCreate;
    void userid;
    const r = validateIntent(intent('billing:quote:create', rest), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_quote_identity')).toBe(true);
    // an invalid email shape still counts as no identity
    const r2 = validateIntent(
      intent('billing:quote:create', { ...rest, email: 'not-an-email' }),
      {}
    );
    expect(r2.ok).toBe(false);
    expect(r2.issues.some((i) => i.code === 'missing_quote_identity')).toBe(true);
  });

  it('billing:quote:create rejects empty/missing items', () => {
    const { items, ...rest } = validCreate;
    void items;
    expect(validateIntent(intent('billing:quote:create', rest), {}).ok).toBe(false);
    const r = validateIntent(intent('billing:quote:create', { ...rest, items: [] }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_items_shape')).toBe(true);
  });

  it('billing:quote:create rejects an items entry missing description or amount', () => {
    const missingDesc = validateIntent(
      intent('billing:quote:create', { ...validCreate, items: [{ amount: 10 }] }),
      {}
    );
    expect(missingDesc.ok).toBe(false);
    expect(missingDesc.issues.some((i) => i.code === 'invalid_items_shape')).toBe(true);
    const missingAmt = validateIntent(
      intent('billing:quote:create', { ...validCreate, items: [{ description: 'L' }] }),
      {}
    );
    expect(missingAmt.ok).toBe(false);
    expect(missingAmt.issues.some((i) => i.code === 'invalid_items_shape')).toBe(true);
  });

  it('billing:quote:update accepts quoteid + an updatable field', () => {
    expect(validateIntent(intent('billing:quote:update', { quoteid: 2, subject: 'New' }), {}).ok).toBe(
      true
    );
  });

  it('billing:quote:update accepts quoteid + non-empty items', () => {
    expect(
      validateIntent(
        intent('billing:quote:update', { quoteid: 2, items: [{ description: 'L', amount: 5 }] }),
        {}
      ).ok
    ).toBe(true);
  });

  it('billing:quote:update rejects quoteid-only (empty_quote_update)', () => {
    const r = validateIntent(intent('billing:quote:update', { quoteid: 2 }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'empty_quote_update')).toBe(true);
  });

  it('billing:quote:update rejects an invalid stage when present', () => {
    const r = validateIntent(
      intent('billing:quote:update', { quoteid: 2, stage: 'Bogus' }),
      {}
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_quote_stage')).toBe(true);
  });

  it('billing:quote:update rejects a bad quoteid', () => {
    for (const qid of [0, -1, 1.5, '1', undefined]) {
      const r = validateIntent(intent('billing:quote:update', { quoteid: qid, subject: 'New' }), {});
      expect(r.ok).toBe(false);
    }
  });

  it('billing:quote:send accepts a valid quoteid, rejects missing/bad', () => {
    expect(validateIntent(intent('billing:quote:send', { quoteid: 2 }), {}).ok).toBe(true);
    for (const qid of [0, -1, 1.5, '1', undefined]) {
      expect(validateIntent(intent('billing:quote:send', { quoteid: qid }), {}).ok).toBe(false);
    }
  });

  it('billing:quote:accept accepts a valid quoteid, rejects bad', () => {
    expect(validateIntent(intent('billing:quote:accept', { quoteid: 2 }), {}).ok).toBe(true);
    for (const qid of [0, -1, 1.5, '1', undefined]) {
      expect(validateIntent(intent('billing:quote:accept', { quoteid: qid }), {}).ok).toBe(false);
    }
  });
});
