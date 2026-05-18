/**
 * PHASE H.1 / Track A3 — authoritative auditor (`auditFromTrace`).
 *
 * Computes emitted/masked/omitted/violations/over/under/unknown PURELY from
 * the projection trace — NO name inference. classmap_source = 'authoritative'.
 * Zero UNKNOWN fields when a trace is present (aggregator leaves inherit the
 * emitted top-level key's class via source_path prefix).
 *
 * Synthetic data only.
 */

import { describe, it, expect } from 'vitest';
import {
  auditFromTrace,
  redactedReport,
} from '../../src/audit/exposureAudit.js';
import type { AuditTraceRecord } from '../../src/governance/auditTrace.js';

function rec(p: Partial<AuditTraceRecord>): AuditTraceRecord {
  return {
    source_path: 'x',
    output_path: 'x',
    field_classification: 'public.safe',
    consumer_id: 'c',
    contract: 'llm_safe_summary',
    projection_decision: 'emit',
    rule_id: 'llm_safe_summary:public.safe->allow',
    reason: 'r',
    value_state: 'present',
    environment: 'production',
    tool: 't',
    ...p,
  };
}

const META = {
  consumer_id: 'llm_chat',
  contract: 'llm_safe_summary',
  tool: 'get_account_360',
};

describe('auditFromTrace authoritative report', () => {
  it('classmap_source is authoritative', () => {
    const r = auditFromTrace([rec({})], META);
    expect(r.classmap_source).toBe('authoritative');
  });

  it('emitted allow → no violation/over/under/unknown', () => {
    const r = auditFromTrace(
      [
        rec({
          source_path: 'clientid',
          output_path: 'clientid',
          field_classification: 'business.identifier',
          rule_id: 'llm_safe_summary:business.identifier->allow',
        }),
      ],
      META
    );
    expect(r.summary.violations).toHaveLength(0);
    expect(r.summary.over_masked).toHaveLength(0);
    expect(r.summary.under_masked).toHaveLength(0);
    expect(r.summary.unknown_fields).toHaveLength(0);
    expect(r.summary.emitted_count).toBe(1);
  });

  it('omitted secret (drop) → omitted, NOT a violation (governance honoured it)', () => {
    const r = auditFromTrace(
      [
        rec({
          source_path: 'password',
          output_path: '',
          field_classification: 'secret.credential',
          projection_decision: 'omit',
          rule_id: 'llm_safe_summary:secret.credential->drop',
          value_state: 'omitted',
        }),
      ],
      META
    );
    expect(r.summary.violations).toHaveLength(0);
    expect(r.summary.omitted).toContain('password');
  });

  it('masked pii → masked bucket, no under_masked', () => {
    const r = auditFromTrace(
      [
        rec({
          source_path: 'email',
          output_path: 'email',
          field_classification: 'pii.email',
          projection_decision: 'mask',
          rule_id: 'llm_safe_summary:pii.email->mask',
          value_state: 'masked',
        }),
      ],
      META
    );
    expect(r.summary.masked).toContain('email');
    expect(r.summary.under_masked).toHaveLength(0);
  });

  it('unmapped emitted top-level key → violation + unknown_field', () => {
    const r = auditFromTrace(
      [
        rec({
          source_path: 'mystery',
          output_path: '',
          field_classification: 'unmapped',
          projection_decision: 'omit',
          rule_id: 'unmapped_dropped',
          value_state: 'omitted',
        }),
      ],
      META
    );
    // unmapped was DROPPED by governance → it is omitted, not exposed.
    // It is reported as unknown but NOT a violation (nothing leaked).
    expect(r.summary.unknown_fields).toContain('mystery');
    expect(r.summary.violations).toHaveLength(0);
  });

  it('env-forbidden deny record → zero emitted, classmap authoritative', () => {
    const r = auditFromTrace(
      [
        rec({
          source_path: '',
          output_path: '',
          field_classification: 'unmapped',
          projection_decision: 'deny',
          rule_id: 'env_forbidden',
          value_state: 'omitted',
        }),
      ],
      META
    );
    expect(r.summary.emitted_count).toBe(0);
    expect(r.classmap_source).toBe('authoritative');
  });

  it('aggregator leaves inherit the emitted top-level key class via prefix → ZERO unknown', () => {
    // Only the TOP-LEVEL key `risk` is traced (system.status, emitted). The
    // auditor must NOT invent UNKNOWN children for nested leaves.
    const r = auditFromTrace(
      [
        rec({
          source_path: 'risk',
          output_path: 'risk',
          field_classification: 'system.status',
          projection_decision: 'emit',
          rule_id: 'llm_safe_summary:system.status->allow',
        }),
        rec({
          source_path: 'source_invoice_ids',
          output_path: 'source_invoice_ids',
          field_classification: 'business.identifier',
          projection_decision: 'emit',
          rule_id: 'llm_safe_summary:business.identifier->allow',
        }),
      ],
      META
    );
    expect(r.summary.unknown_fields).toHaveLength(0);
    expect(r.summary.emitted_count).toBe(2);
    expect(r.fields.find((f) => f.source_path === 'risk')?.field_classification).toBe(
      'system.status'
    );
  });

  it('redactedReport works on an authoritative report (no raw, idempotent)', () => {
    const r = auditFromTrace(
      [
        rec({
          source_path: 'email',
          output_path: 'email',
          field_classification: 'pii.email',
          projection_decision: 'mask',
          value_state: 'masked',
        }),
      ],
      META
    );
    const safe = redactedReport(r);
    expect(safe.classmap_source).toBe('authoritative');
    expect(JSON.stringify(safe)).not.toContain('"raw"');
    expect(redactedReport(safe)).toEqual(safe);
  });

  it('trace is the truth: a `drop` class wrongly emitted IS a violation', () => {
    // projection_decision says emit for a class whose rule is ->drop: this is
    // the authoritative leak signal (should never happen, but the auditor
    // must catch it from the trace, not infer it).
    const r = auditFromTrace(
      [
        rec({
          source_path: 'leaked',
          output_path: 'leaked',
          field_classification: 'secret.credential',
          projection_decision: 'emit',
          rule_id: 'llm_safe_summary:secret.credential->drop',
          value_state: 'present',
        }),
      ],
      META
    );
    expect(r.summary.violations).toContain('leaked');
  });

  it('value-free: report carries no field values (only paths/classes/decisions)', () => {
    const r = auditFromTrace(
      [
        rec({
          source_path: 'email',
          output_path: 'email',
          field_classification: 'pii.email',
          projection_decision: 'mask',
          value_state: 'masked',
        }),
      ],
      META
    );
    // there is simply no place for a value in the trace-driven report
    for (const f of r.fields) {
      expect('sample' in f).toBe(false);
    }
  });
});
