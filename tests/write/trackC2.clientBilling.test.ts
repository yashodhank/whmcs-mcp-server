/**
 * Track C2 — client-contact + billable-item governed scopes.
 *
 * Covers the frozen-seam action/risk pins, the strict param mappers (allowlist
 * + drop of permission/sub-account/password/injected keys), and the per-scope
 * validators for:
 *   - client:contact:add        (AddContact, medium)
 *   - client:contact:update     (UpdateContact, medium)
 *   - billing:billable_item:add (AddBillableItem, medium)
 *
 * Mirrors the patterns in trackC.test.ts (WriteIntent helper, validateIntent,
 * intentToWhmcsParams). No WHMCS calls — pure intent inspection / mapping.
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

describe('Track C2 frozen-seam additions (contacts + billable item)', () => {
  it('registers the three scopes with correct action + risk', () => {
    const expect3: Record<string, [string, string]> = {
      'client:contact:add': ['AddContact', 'medium'],
      'client:contact:update': ['UpdateContact', 'medium'],
      'billing:billable_item:add': ['AddBillableItem', 'medium'],
    };
    for (const [scope, [action, risk]] of Object.entries(expect3)) {
      expect(WRITE_SCOPES as readonly string[]).toContain(scope);
      expect(SCOPE_ACTION[scope as keyof typeof SCOPE_ACTION]).toBe(action);
      expect(SCOPE_RISK[scope as keyof typeof SCOPE_RISK]).toBe(risk);
    }
  });
});

describe('Track C2 strict mappers', () => {
  it('client:contact:add emits clientid + allowlisted contact fields, drops permission/sub-account/password keys', () => {
    const out = intentToWhmcsParams('client:contact:add', {
      clientid: 3,
      firstname: 'A',
      email: 'a@b.com',
      password2: 'x',
      subaccount: true,
      generalemails: true,
    });
    expect(out.clientid).toBe(3);
    expect(out.firstname).toBe('A');
    expect(out.email).toBe('a@b.com');
    expect(out).not.toHaveProperty('password2');
    expect(out).not.toHaveProperty('subaccount');
    expect(out).not.toHaveProperty('generalemails');
  });

  it('client:contact:add emits ONLY present allowlisted fields (+clientid)', () => {
    expect(
      intentToWhmcsParams('client:contact:add', {
        clientid: 3,
        firstname: 'A',
        lastname: 'B',
        email: 'a@b.com',
        companyname: 'Acme',
        address1: '1 St',
        address2: 'Apt 2',
        city: 'Town',
        state: 'ST',
        postcode: '12345',
        country: 'US',
        phonenumber: '+1.5125550100',
      })
    ).toEqual({
      clientid: 3,
      firstname: 'A',
      lastname: 'B',
      email: 'a@b.com',
      companyname: 'Acme',
      address1: '1 St',
      address2: 'Apt 2',
      city: 'Town',
      state: 'ST',
      postcode: '12345',
      country: 'US',
      phonenumber: '+1.5125550100',
    });
  });

  it('client:contact:update emits contactid + present allowlisted fields, drops disallowed keys', () => {
    const out = intentToWhmcsParams('client:contact:update', {
      contactid: 9,
      lastname: 'B',
      email: 'c@d.com',
      // disallowed keys must be dropped:
      password2: 'x',
      subaccount: true,
      generalemails: true,
      permissions: 'manageproducts',
    });
    expect(out).toEqual({ contactid: 9, lastname: 'B', email: 'c@d.com' });
    expect(out).not.toHaveProperty('password2');
    expect(out).not.toHaveProperty('subaccount');
    expect(out).not.toHaveProperty('generalemails');
    expect(out).not.toHaveProperty('permissions');
  });

  it('billing:billable_item:add passes allowlisted fields, drops extras', () => {
    const out = intentToWhmcsParams('billing:billable_item:add', {
      clientid: 3,
      description: 'X',
      amount: 10,
      invoiceaction: 'noinvoice',
      evil: 'x',
    });
    expect(out.clientid).toBe(3);
    expect(out.description).toBe('X');
    expect(out.amount).toBe(10);
    expect(out.invoiceaction).toBe('noinvoice');
    expect(out).not.toHaveProperty('evil');
  });

  it('billing:billable_item:add forwards the full recurring/invoicing allowlist', () => {
    expect(
      intentToWhmcsParams('billing:billable_item:add', {
        clientid: 3,
        description: 'X',
        amount: 10,
        recur: 1,
        recurcycle: 'Months',
        recurfor: 12,
        invoiceaction: 'duedate',
        duedate: '2026-07-01',
        // dropped:
        notinvoiced: true,
      })
    ).toEqual({
      clientid: 3,
      description: 'X',
      amount: 10,
      recur: 1,
      recurcycle: 'Months',
      recurfor: 12,
      invoiceaction: 'duedate',
      duedate: '2026-07-01',
    });
  });
});

describe('Track C2 validation', () => {
  // ── client:contact:add ────────────────────────────────────────────────────
  it('client:contact:add accepts clientid + ≥1 contact field', () => {
    expect(validateIntent(intent('client:contact:add', { clientid: 3, firstname: 'A' }), {}).ok).toBe(
      true
    );
  });

  it('client:contact:add rejects clientid-only (empty_contact)', () => {
    const r = validateIntent(intent('client:contact:add', { clientid: 3 }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'empty_contact')).toBe(true);
  });

  it('client:contact:add rejects bad clientid', () => {
    for (const cid of [0, -1, 1.5, '1', undefined]) {
      const r = validateIntent(intent('client:contact:add', { clientid: cid, firstname: 'A' }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_clientid')).toBe(true);
    }
  });

  it('client:contact:add rejects invalid email when email present', () => {
    const r = validateIntent(intent('client:contact:add', { clientid: 3, email: 'notanemail' }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_email')).toBe(true);
  });

  // ── client:contact:update ───────────────────────────────────────────────
  it('client:contact:update accepts contactid + ≥1 contact field', () => {
    expect(
      validateIntent(intent('client:contact:update', { contactid: 9, lastname: 'B' }), {}).ok
    ).toBe(true);
  });

  it('client:contact:update rejects contactid-only (empty_contact_update)', () => {
    const r = validateIntent(intent('client:contact:update', { contactid: 9 }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'empty_contact_update')).toBe(true);
  });

  it('client:contact:update rejects bad contactid', () => {
    for (const cid of [0, -1, 1.5, '1', undefined]) {
      const r = validateIntent(
        intent('client:contact:update', { contactid: cid, lastname: 'B' }),
        {}
      );
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_contactid')).toBe(true);
    }
  });

  it('client:contact:update rejects invalid email when present', () => {
    const r = validateIntent(
      intent('client:contact:update', { contactid: 9, email: 'notanemail' }),
      {}
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_email')).toBe(true);
  });

  // ── billing:billable_item:add ─────────────────────────────────────────────
  it('billing:billable_item:add accepts clientid + description + positive amount', () => {
    expect(
      validateIntent(
        intent('billing:billable_item:add', { clientid: 3, description: 'X', amount: 10 }),
        {}
      ).ok
    ).toBe(true);
  });

  it('billing:billable_item:add rejects missing amount', () => {
    const r = validateIntent(
      intent('billing:billable_item:add', { clientid: 3, description: 'X' }),
      {}
    );
    expect(r.ok).toBe(false);
  });

  it('billing:billable_item:add rejects amount <= 0', () => {
    for (const amt of [0, -5]) {
      const r = validateIntent(
        intent('billing:billable_item:add', { clientid: 3, description: 'X', amount: amt }),
        {}
      );
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'non_positive_billable_amount')).toBe(true);
    }
  });

  it('billing:billable_item:add rejects bad clientid', () => {
    for (const cid of [0, -1, 1.5, '1', undefined]) {
      const r = validateIntent(
        intent('billing:billable_item:add', { clientid: cid, description: 'X', amount: 10 }),
        {}
      );
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_clientid')).toBe(true);
    }
  });
});
