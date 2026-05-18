/**
 * Phase H — exposure-audit pure model tests.
 *
 * Synthetic data only. No I/O, no WHMCS. Proves that `auditExposure`
 * faithfully reports WHAT a projected output emits for a consumer/contract
 * vs. the canonical classification map, and that no raw value escapes by
 * default. The mirror property: an `allow`ed leaf that is present is OK; a
 * `drop` class that was emitted is a violation; a classified leaf that the
 * contract permits but the projection omitted is over-masked; a risky class
 * emitted raw under a masking contract is under-masked; an emitted leaf with
 * no classification is an unknown field.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  auditExposure,
  redactedReport,
  type ExposureAuditReport,
} from '../../src/audit/exposureAudit.js';
import type { FieldClass } from '../../src/governance/types.js';

const sha8 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

/** A masking contract policy (mirrors `llm_safe_summary` shape). */
const MASK_POLICY: Record<FieldClass, string> = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'mask',
  'pii.name': 'mask',
  'pii.email': 'mask',
  'pii.phone': 'mask',
  'pii.address': 'mask',
  'pii.tax': 'mask',
  'pii.custom_field': 'mask',
  'secret.credential': 'drop',
  'untrusted.free_text': 'summarize',
  'internal.private_note': 'drop',
  'system.audit': 'drop',
  'public.safe': 'allow',
};

/* ── per-contract policy mirrors (copied exactly from
 *    src/governance/contracts.ts; used ONLY to drive the pure auditor). ── */

const LLM_SAFE_SUMMARY: Record<FieldClass, string> = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'mask',
  'pii.email': 'mask',
  'pii.phone': 'mask',
  'pii.address': 'mask',
  'pii.tax': 'mask',
  'pii.custom_field': 'mask',
  'secret.credential': 'drop',
  'untrusted.free_text': 'summarize',
  'internal.private_note': 'drop',
  'system.audit': 'drop',
  'public.safe': 'allow',
};

const OPS_OPERATOR: Record<FieldClass, string> = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'drop',
  'untrusted.free_text': 'wrap_untrusted',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
};

const BILLING_RECONCILIATION: Record<FieldClass, string> = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'mask',
  'pii.address': 'mask',
  'pii.tax': 'mask',
  'pii.custom_field': 'drop',
  'secret.credential': 'drop',
  'untrusted.free_text': 'drop',
  'internal.private_note': 'drop',
  'system.audit': 'allow',
  'public.safe': 'allow',
};

const RENEWAL_AUTOMATION: Record<FieldClass, string> = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'mask',
  'pii.email': 'allow',
  'pii.phone': 'mask',
  'pii.address': 'mask',
  'pii.tax': 'mask',
  'pii.custom_field': 'mask',
  'secret.credential': 'drop',
  'untrusted.free_text': 'drop',
  'internal.private_note': 'drop',
  'system.audit': 'allow',
  'public.safe': 'allow',
};

const SUPPORT_TRIAGE: Record<FieldClass, string> = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'drop',
  'untrusted.free_text': 'allow',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
};

const ADMIN_FULL_TRUSTED: Record<FieldClass, string> = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'drop',
  'untrusted.free_text': 'allow',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
};

const findField = (r: ExposureAuditReport, path: string) =>
  r.fields.find((f) => f.path === path);

/** Recursively assert no object anywhere carries a `raw` key. */
const assertNoRawDeep = (node: unknown): void => {
  if (Array.isArray(node)) {
    for (const el of node) assertNoRawDeep(el);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      expect(k).not.toBe('raw');
      assertNoRawDeep(v);
    }
  }
};

describe('auditExposure (Phase H)', () => {
  it('emitted allowed field → ok (no violation/over/under/unknown)', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: { id: 'business.identifier' },
      projected: { id: 42 },
      contractPolicy: MASK_POLICY,
    });
    const f = findField(r, 'id');
    expect(f).toBeDefined();
    expect(f?.classification).toBe('business.identifier');
    expect(f?.value_state).toBe('present');
    expect(f?.allowed).toBe(true);
    expect(r.summary.emitted_count).toBe(1);
    expect(r.summary.violations).toHaveLength(0);
    expect(r.summary.over_masked).toHaveLength(0);
    expect(r.summary.under_masked).toHaveLength(0);
    expect(r.summary.unknown_fields).toHaveLength(0);
  });

  it('contract-drop class emitted → violation', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: { password: 'secret.credential' },
      projected: { password: 'hunter2-SYNTHETIC' },
      contractPolicy: MASK_POLICY,
    });
    const f = findField(r, 'password');
    expect(f?.classification).toBe('secret.credential');
    expect(f?.allowed).toBe(false);
    expect(r.summary.violations).toContain('password');
  });

  it('classified path omitted though contract allows → over_masked', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: {
        id: 'business.identifier',
        company: 'business.identifier',
      },
      // `company` is allowed by contract but absent from the projection.
      projected: { id: 7 },
      contractPolicy: MASK_POLICY,
    });
    expect(r.summary.over_masked).toContain('company');
    const f = findField(r, 'company');
    expect(f?.value_state).toBe('omitted');
  });

  it('pii/secret/financial.reference emitted raw under masking contract → under_masked', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: {
        email: 'pii.email',
        txn_ref: 'financial.reference',
        amount: 'financial.amount',
      },
      projected: {
        // raw, unmasked PII / reference under a mask/summarize contract
        email: 'jane.doe@synthetic.example',
        txn_ref: 'TXN-SYNTH-0001',
        amount: 19.99,
      },
      contractPolicy: MASK_POLICY,
    });
    expect(r.summary.under_masked).toContain('email');
    expect(r.summary.under_masked).toContain('txn_ref');
    // financial.amount is `allow` here — emitting it raw is NOT under_masked
    expect(r.summary.under_masked).not.toContain('amount');
  });

  it('masked-looking value under a mask contract is not under_masked', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: { email: 'pii.email' },
      projected: { email: 'j***@s***' },
      contractPolicy: MASK_POLICY,
    });
    const f = findField(r, 'email');
    expect(f?.value_state).toBe('masked');
    expect(r.summary.under_masked).not.toContain('email');
    expect(r.summary.violations).toHaveLength(0);
  });

  it('unknown (unclassified) emitted path → unknown_fields', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: { id: 'business.identifier' },
      projected: { id: 1, mystery_field: 'synthetic' },
      contractPolicy: MASK_POLICY,
    });
    const f = findField(r, 'mystery_field');
    expect(f?.classification).toBe('UNKNOWN');
    expect(r.summary.unknown_fields).toContain('mystery_field');
    expect(r.summary.violations).toContain('mystery_field');
  });

  it('sample is { length, sha8 } by default — NEVER raw', () => {
    const secret = 'jane.doe@synthetic.example';
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: { email: 'pii.email' },
      projected: { email: secret },
      contractPolicy: MASK_POLICY,
    });
    const f = findField(r, 'email');
    expect(f?.sample).toEqual({ length: secret.length, sha8: sha8(secret) });
    expect(JSON.stringify(r)).not.toContain('jane.doe@synthetic.example');
    expect((f?.sample as Record<string, unknown>).raw).toBeUndefined();
  });

  it('localShowValues=true → raw present in sample (operator-only)', () => {
    const secret = 'jane.doe@synthetic.example';
    const r = auditExposure({
      consumer_id: 'debug_local',
      contract: 'debug_local',
      tool: 'get_client_details',
      canonicalClasses: { email: 'pii.email' },
      projected: { email: secret },
      contractPolicy: MASK_POLICY,
      localShowValues: true,
    });
    const f = findField(r, 'email');
    expect(f?.sample).toMatchObject({ length: secret.length, sha8: sha8(secret) });
    expect((f?.sample as Record<string, unknown>).raw).toBe(secret);
  });

  it('redactedReport strips any sample.raw', () => {
    const secret = 'jane.doe@synthetic.example';
    const r = auditExposure({
      consumer_id: 'debug_local',
      contract: 'debug_local',
      tool: 'get_client_details',
      canonicalClasses: { email: 'pii.email' },
      projected: { email: secret },
      contractPolicy: MASK_POLICY,
      localShowValues: true,
    });
    const safe = redactedReport(r);
    const f = findField(safe, 'email');
    expect((f?.sample as Record<string, unknown>).raw).toBeUndefined();
    expect(f?.sample).toEqual({ length: secret.length, sha8: sha8(secret) });
    expect(JSON.stringify(safe)).not.toContain('jane.doe@synthetic.example');
    // original is not mutated
    const orig = findField(r, 'email');
    expect((orig?.sample as Record<string, unknown>).raw).toBe(secret);
  });

  it('walks nested leaf paths with dot/array notation', () => {
    const r = auditExposure({
      consumer_id: 'support_console',
      contract: 'support_triage',
      tool: 'get_ticket_thread',
      canonicalClasses: {
        'replies[].message': 'untrusted.free_text',
        'client.email': 'pii.email',
      },
      projected: {
        replies: [{ message: 'first synthetic reply' }],
        client: { email: 'a***@b***' },
      },
      contractPolicy: MASK_POLICY,
    });
    expect(findField(r, 'replies[].message')).toBeDefined();
    expect(findField(r, 'client.email')?.value_state).toBe('masked');
    expect(r.summary.emitted_count).toBe(2);
  });

  it('null leaf reports value_state = null and counts as emitted', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: { phone: 'pii.phone' },
      projected: { phone: null },
      contractPolicy: MASK_POLICY,
    });
    const f = findField(r, 'phone');
    expect(f?.value_state).toBe('null');
    expect(r.summary.under_masked).not.toContain('phone');
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Per-contract coverage proofs. Each test exercises one real contract policy
 * with a representative synthetic projected payload + classmap, asserting the
 * auditor reports the right paths/classification/state/allowed and the right
 * over/under/unknown/violation buckets for that policy. Synthetic data only.
 * ────────────────────────────────────────────────────────────────────────── */
describe('per-contract coverage (Phase H)', () => {
  /* ── llm_safe_summary ── */
  it('llm_safe_summary: safe projection with masked PII → no violations', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'account360',
      canonicalClasses: {
        id: 'business.identifier',
        company: 'business.identifier',
        email: 'pii.email',
        name: 'pii.name',
        balance: 'financial.amount',
      },
      projected: {
        id: 1,
        company: 'Synthetic Co',
        email: 'j***@s***',
        name: 'J*** D***',
        balance: 12.5,
      },
      contractPolicy: LLM_SAFE_SUMMARY,
    });
    expect(r.summary.violations).toHaveLength(0);
    expect(r.summary.under_masked).toHaveLength(0);
    expect(r.summary.unknown_fields).toHaveLength(0);
    expect(findField(r, 'email')?.value_state).toBe('masked');
    expect(findField(r, 'id')?.allowed).toBe(true);
  });

  it('llm_safe_summary: leaked raw secret + raw PII → under_masked + violation', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_client_details',
      canonicalClasses: {
        email: 'pii.email',
        api_token: 'secret.credential',
      },
      projected: {
        email: 'jane.doe@synthetic.example',
        api_token: 'SK-SYNTHETIC-LEAK-0001',
      },
      contractPolicy: LLM_SAFE_SUMMARY,
    });
    // PII emitted raw under a mask contract → under_masked.
    expect(r.summary.under_masked).toContain('email');
    // secret.credential is `drop` → emitting it at all is a violation.
    expect(r.summary.violations).toContain('api_token');
    expect(findField(r, 'api_token')?.allowed).toBe(false);
  });

  it('llm_safe_summary: unknown emitted path → unknown_fields + violation', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'get_billing_snapshot',
      canonicalClasses: { id: 'business.identifier' },
      projected: { id: 1, undocumented_blob: 'synthetic-mystery' },
      contractPolicy: LLM_SAFE_SUMMARY,
    });
    expect(r.summary.unknown_fields).toContain('undocumented_blob');
    expect(r.summary.violations).toContain('undocumented_blob');
    expect(findField(r, 'undocumented_blob')?.classification).toBe('UNKNOWN');
  });

  it('llm_safe_summary: allowed business.identifier omitted → over_masked', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'account360',
      canonicalClasses: {
        id: 'business.identifier',
        company: 'business.identifier',
      },
      projected: { id: 9 },
      contractPolicy: LLM_SAFE_SUMMARY,
    });
    expect(r.summary.over_masked).toContain('company');
    expect(findField(r, 'company')?.value_state).toBe('omitted');
  });

  /* ── ops_operator ── */
  it('ops_operator: raw PII allowed → no under_masked; secret drop → violation', () => {
    const r = auditExposure({
      consumer_id: 'ops_operator',
      contract: 'ops_operator',
      tool: 'get_account_360',
      canonicalClasses: {
        email: 'pii.email',
        phone: 'pii.phone',
        password: 'secret.credential',
      },
      projected: {
        email: 'ops.user@synthetic.example',
        phone: '+1-555-0100',
        password: 'PW-SYNTHETIC-0001',
      },
      contractPolicy: OPS_OPERATOR,
    });
    expect(r.summary.under_masked).not.toContain('email');
    expect(r.summary.under_masked).not.toContain('phone');
    expect(r.summary.violations).toContain('password');
  });

  /* ── billing_reconciliation ── */
  it('billing_reconciliation: raw phone under mask policy → under_masked', () => {
    const r = auditExposure({
      consumer_id: 'billing_dashboard',
      contract: 'billing_reconciliation',
      tool: 'reconciliation_snapshot',
      canonicalClasses: {
        invoice_id: 'financial.reference',
        amount: 'financial.amount',
        phone: 'pii.phone',
        note: 'internal.private_note',
      },
      projected: {
        invoice_id: 'INV-SYNTH-77',
        amount: 42,
        phone: '+1-555-0144',
        note: 'internal synthetic memo',
      },
      contractPolicy: BILLING_RECONCILIATION,
    });
    // phone is `mask` here but emitted raw → under_masked.
    expect(r.summary.under_masked).toContain('phone');
    // internal.private_note is `drop` for this contract → violation.
    expect(r.summary.violations).toContain('note');
    expect(findField(r, 'invoice_id')?.allowed).toBe(true);
  });

  /* ── renewal_automation ── */
  it('renewal_automation: raw name under mask but email allowed', () => {
    const r = auditExposure({
      consumer_id: 'renewal_worker',
      contract: 'renewal_automation',
      tool: 'renewal_snapshot',
      canonicalClasses: {
        name: 'pii.name',
        email: 'pii.email',
        amount: 'financial.amount',
      },
      projected: {
        name: 'Renewal Synthetic Customer',
        email: 'renew@synthetic.example',
        amount: 99,
      },
      contractPolicy: RENEWAL_AUTOMATION,
    });
    // pii.name is `mask` → raw name is under_masked.
    expect(r.summary.under_masked).toContain('name');
    // pii.email is `allow` → raw email is fine.
    expect(r.summary.under_masked).not.toContain('email');
    expect(r.summary.violations).toHaveLength(0);
  });

  /* ── support_triage ── */
  it('support_triage: nested replies + client email all allowed → no violations', () => {
    const r = auditExposure({
      consumer_id: 'support_console',
      contract: 'support_triage',
      tool: 'support_snapshot',
      canonicalClasses: {
        'replies[].message': 'untrusted.free_text',
        'client.email': 'pii.email',
        'client.id': 'business.identifier',
      },
      projected: {
        replies: [{ message: 'synthetic ticket reply one' }],
        client: { email: 'support@synthetic.example', id: 3 },
      },
      contractPolicy: SUPPORT_TRIAGE,
    });
    expect(r.summary.violations).toHaveLength(0);
    expect(r.summary.under_masked).toHaveLength(0);
    expect(findField(r, 'replies[].message')?.allowed).toBe(true);
    expect(r.summary.emitted_count).toBe(3);
  });

  /* ── admin_full_trusted ── */
  it('admin_full_trusted: everything allowed except secret.credential drop', () => {
    const r = auditExposure({
      consumer_id: 'admin_full_trusted',
      contract: 'admin_full_trusted',
      tool: 'get_account_360',
      canonicalClasses: {
        id: 'business.identifier',
        email: 'pii.email',
        tax_id: 'pii.tax',
        admin_note: 'internal.private_note',
        audit_event: 'system.audit',
        secret_key: 'secret.credential',
      },
      projected: {
        id: 5,
        email: 'admin@synthetic.example',
        tax_id: 'TAX-SYNTH-001',
        admin_note: 'synthetic admin note',
        audit_event: 'synthetic.audit.event',
        secret_key: 'KEY-SYNTHETIC-0001',
      },
      contractPolicy: ADMIN_FULL_TRUSTED,
    });
    // Only secret.credential is drop → only that path is a violation.
    expect(r.summary.violations).toEqual(['secret_key']);
    expect(r.summary.under_masked).toHaveLength(0);
    expect(r.summary.unknown_fields).toHaveLength(0);
    expect(findField(r, 'email')?.allowed).toBe(true);
    expect(findField(r, 'admin_note')?.allowed).toBe(true);
    expect(findField(r, 'audit_event')?.allowed).toBe(true);
    expect(findField(r, 'secret_key')?.allowed).toBe(false);
  });

  it('admin_full_trusted: hashes + lengths present for every emitted field', () => {
    const value = 'admin-synthetic-value';
    const r = auditExposure({
      consumer_id: 'admin_full_trusted',
      contract: 'admin_full_trusted',
      tool: 'get_stats',
      canonicalClasses: { stat: 'public.safe' },
      projected: { stat: value },
      contractPolicy: ADMIN_FULL_TRUSTED,
    });
    const f = findField(r, 'stat');
    expect(f?.sample.length).toBe(value.length);
    expect(f?.sample.sha8).toBe(sha8(value));
    expect((f?.sample as Record<string, unknown>).raw).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Committed-artifact safety property: a redactedReport must contain NO `raw`
 * key anywhere, no matter how nested the projection was.
 * ────────────────────────────────────────────────────────────────────────── */
describe('redactedReport committed-artifact safety (Phase H)', () => {
  it('deep redactedReport output has no `raw` key anywhere', () => {
    const secret = 'deeply-nested-synthetic-secret';
    const r = auditExposure({
      consumer_id: 'debug_local',
      contract: 'debug_local',
      tool: 'get_account_360',
      canonicalClasses: {
        'client.email': 'pii.email',
        'invoices[].ref': 'financial.reference',
        'tickets[].replies[].message': 'untrusted.free_text',
      },
      projected: {
        client: { email: secret },
        invoices: [{ ref: 'INV-SYNTH-1' }],
        tickets: [{ replies: [{ message: 'synthetic nested reply' }] }],
      },
      contractPolicy: ADMIN_FULL_TRUSTED,
      localShowValues: true,
    });
    // raw IS present before redaction (operator-only path).
    expect(JSON.stringify(r)).toContain(secret);
    const safe = redactedReport(r);
    assertNoRawDeep(safe);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).not.toContain('"raw"');
  });

  it('redactedReport on an already-redacted report is still raw-free (idempotent)', () => {
    const r = auditExposure({
      consumer_id: 'llm_chat',
      contract: 'llm_safe_summary',
      tool: 'account360',
      canonicalClasses: { email: 'pii.email' },
      projected: { email: 'idem@synthetic.example' },
      contractPolicy: LLM_SAFE_SUMMARY,
    });
    const once = redactedReport(r);
    const twice = redactedReport(once);
    assertNoRawDeep(twice);
    expect(twice).toEqual(once);
  });
});
