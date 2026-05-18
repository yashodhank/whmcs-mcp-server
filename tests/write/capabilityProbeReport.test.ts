/**
 * Phase G — pure capability-probe report model tests. No WHMCS, no I/O.
 *
 * Proves the deliberate read-only verification probe's classification mirrors
 * the live `capabilities.ts` patterns EXACTLY:
 *   - success                              → supported
 *   - "Access Denied" / permission text    → not_authorized
 *   - "action not found" / invalid action  → unsupported
 *   - any other result:'error'             → degraded
 *   - a thrown transport/other error       → degraded
 * and that `buildProbeReport` summarizes counts without leaking any raw
 * response body (evidence is a short classification string only). Synthetic
 * inputs only — this never touches WHMCS.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyProbeOutcome,
  buildProbeReport,
} from '../../src/governance/capabilityProbeReport.js';

const ACTION = 'GetTransactions';
const CAP = 'list_client_transactions';

describe('classifyProbeOutcome', () => {
  it('classifies a result:"success" response as supported', () => {
    const r = classifyProbeOutcome(ACTION, {
      response: { result: 'success', transactions: { transaction: [] } },
    });
    expect(r.action).toBe(ACTION);
    expect(r.capability).toBe(CAP);
    expect(r.status).toBe('supported');
    expect(typeof r.evidence).toBe('string');
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it('classifies an unknown action as unsupported', () => {
    const r = classifyProbeOutcome('GetStats', {
      error: { result: 'error', message: 'Action could not be found' },
    });
    expect(r.action).toBe('GetStats');
    expect(r.capability).toBe('get_system_stats');
    expect(r.status).toBe('unsupported');
  });

  it('classifies "Invalid Action" text as unsupported', () => {
    const r = classifyProbeOutcome('GetUsers', {
      error: { result: 'error', message: 'Invalid Action' },
    });
    expect(r.status).toBe('unsupported');
  });

  it('classifies "Access Denied" as not_authorized', () => {
    const r = classifyProbeOutcome(ACTION, {
      error: { result: 'error', message: 'Access Denied' },
    });
    expect(r.status).toBe('not_authorized');
  });

  it('classifies a permission-related error as not_authorized', () => {
    const r = classifyProbeOutcome('GetToDoItems', {
      error: { result: 'error', message: 'You do not have permission' },
    });
    expect(r.action).toBe('GetToDoItems');
    expect(r.capability).toBe('list_todo_items');
    expect(r.status).toBe('not_authorized');
  });

  it('classifies any other result:"error" as degraded', () => {
    const r = classifyProbeOutcome('GetAutomationLog', {
      error: { result: 'error', message: 'Something unexpected went wrong' },
    });
    expect(r.action).toBe('GetAutomationLog');
    expect(r.capability).toBe('list_automation_log');
    expect(r.status).toBe('degraded');
  });

  it('classifies a thrown transport error as degraded', () => {
    const r = classifyProbeOutcome(ACTION, {
      error: new Error('WHMCS connection error: ECONNREFUSED'),
    });
    expect(r.status).toBe('degraded');
  });

  it('classifies a thrown string error as degraded', () => {
    const r = classifyProbeOutcome(ACTION, { error: 'socket hang up' });
    expect(r.status).toBe('degraded');
  });

  it('synthesizes a capability id for an action outside the registry', () => {
    const r = classifyProbeOutcome('GetSomethingNew', {
      response: { result: 'success' },
    });
    expect(r.capability).toBe('get_something_new');
    expect(r.status).toBe('supported');
  });

  it('never embeds the raw response body in evidence', () => {
    const secret = 'CUSTOMER_EMAIL=alice@example.com';
    const r = classifyProbeOutcome(ACTION, {
      response: { result: 'success', leak: secret },
    });
    expect(r.evidence.includes(secret)).toBe(false);
  });

  it('treats a missing response/error as degraded (no probe outcome)', () => {
    const r = classifyProbeOutcome(ACTION, {});
    expect(r.status).toBe('degraded');
  });
});

describe('buildProbeReport', () => {
  it('summarizes status counts and stamps generated_at', () => {
    const results = [
      classifyProbeOutcome('GetTransactions', {
        response: { result: 'success' },
      }),
      classifyProbeOutcome('GetStats', {
        error: { result: 'error', message: 'Access Denied' },
      }),
      classifyProbeOutcome('GetUsers', {
        error: { result: 'error', message: 'Action not found' },
      }),
      classifyProbeOutcome('GetToDoItems', {
        error: { result: 'error', message: 'temporary glitch' },
      }),
      classifyProbeOutcome('GetAutomationLog', {
        error: new Error('timeout'),
      }),
    ];
    const report = buildProbeReport(results);

    expect(report.results).toHaveLength(5);
    expect(typeof report.generated_at).toBe('string');
    expect(Number.isNaN(Date.parse(report.generated_at))).toBe(false);

    expect(report.summary.total).toBe(5);
    expect(report.summary.supported).toBe(1);
    expect(report.summary.not_authorized).toBe(1);
    expect(report.summary.unsupported).toBe(1);
    expect(report.summary.degraded).toBe(2);
  });

  it('produces an all-zero summary (except total) for an empty run', () => {
    const report = buildProbeReport([]);
    expect(report.results).toHaveLength(0);
    expect(report.summary.total).toBe(0);
    expect(report.summary.supported).toBe(0);
    expect(report.summary.not_authorized).toBe(0);
    expect(report.summary.unsupported).toBe(0);
    expect(report.summary.degraded).toBe(0);
  });

  it('does not leak any raw response body through the report', () => {
    const secret = 'SECRET-TOKEN-abc123';
    const report = buildProbeReport([
      classifyProbeOutcome('GetTransactions', {
        response: { result: 'success', token: secret },
      }),
    ]);
    expect(JSON.stringify(report).includes(secret)).toBe(false);
  });
});
