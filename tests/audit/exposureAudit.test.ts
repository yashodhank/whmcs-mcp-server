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

const findField = (r: ExposureAuditReport, path: string) =>
  r.fields.find((f) => f.path === path);

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
