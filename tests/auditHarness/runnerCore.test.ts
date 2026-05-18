/**
 * PHASE H.1 — Track C: exposure-audit harness reliability core tests.
 *
 * Synthetic, pure, no I/O, no WHMCS, no MCP. Proves the harness reliability
 * primitives so that EVERY (consumer,tool,client) job yields exactly one
 * structured JSON object — either a redacted audit report or a structured
 * failure — with a stable failure taxonomy, a safe+deterministic retry
 * predicate, and faithful metrics aggregation. These are the only parts
 * that need TDD; the MCP transport orchestration is glue around them.
 */

import { describe, it, expect } from 'vitest';
import {
  FAILURE_KINDS,
  classifyFailure,
  isTransientKind,
  shouldRetry,
  MAX_RETRIES,
  buildEnvelope,
  buildFailureReport,
  aggregateMetrics,
  classmapSourceFor,
  type JobOutcome,
} from '../../src/auditHarness/runnerCore.js';

describe('failure taxonomy', () => {
  it('exposes exactly the six contract kinds', () => {
    expect([...FAILURE_KINDS].sort()).toEqual(
      [
        'audit_error',
        'call_timeout',
        'connect_timeout',
        'parse_error',
        'tool_error',
        'transport_error',
      ].sort()
    );
  });
});

describe('classifyFailure', () => {
  it('maps a connect-phase timeout to connect_timeout', () => {
    const err = new Error('connect deadline exceeded');
    expect(classifyFailure(err, 'connect').kind).toBe('connect_timeout');
  });

  it('maps a callTool-phase timeout to call_timeout', () => {
    const err = Object.assign(new Error('hung'), { code: 'TIMEOUT' });
    expect(classifyFailure(err, 'call').kind).toBe('call_timeout');
  });

  it('maps a phase-agnostic timeout by phase (connect)', () => {
    const e = new Error('Operation timed out');
    expect(classifyFailure(e, 'connect').kind).toBe('connect_timeout');
  });

  it('maps a phase-agnostic timeout by phase (call)', () => {
    const e = new Error('Operation timed out');
    expect(classifyFailure(e, 'call').kind).toBe('call_timeout');
  });

  it('maps EPIPE / closed stdio to transport_error', () => {
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(classifyFailure(err, 'call').kind).toBe('transport_error');
  });

  it('maps a stdio "closed" message to transport_error', () => {
    expect(
      classifyFailure(new Error('transport closed'), 'connect').kind
    ).toBe('transport_error');
  });

  it('maps an MCP tool error result to tool_error', () => {
    const err = Object.assign(new Error('isError'), { mcpToolError: true });
    expect(classifyFailure(err, 'call').kind).toBe('tool_error');
  });

  it('maps a JSON parse failure to parse_error', () => {
    const err = new SyntaxError('Unexpected token < in JSON at position 0');
    expect(classifyFailure(err, 'parse').kind).toBe('parse_error');
  });

  it('maps an auditor throw to audit_error', () => {
    expect(
      classifyFailure(new Error('classmap blew up'), 'audit').kind
    ).toBe('audit_error');
  });

  it('always returns a string message and a known kind', () => {
    const c = classifyFailure(undefined, 'call');
    expect(typeof c.message).toBe('string');
    expect(FAILURE_KINDS).toContain(c.kind);
  });
});

describe('retry policy (safe + deterministic only)', () => {
  it('classifies only connect_timeout & transport_error as transient', () => {
    expect(isTransientKind('connect_timeout')).toBe(true);
    expect(isTransientKind('transport_error')).toBe(true);
    expect(isTransientKind('call_timeout')).toBe(false);
    expect(isTransientKind('tool_error')).toBe(false);
    expect(isTransientKind('audit_error')).toBe(false);
    expect(isTransientKind('parse_error')).toBe(false);
  });

  it('retries transient kinds up to MAX_RETRIES then stops', () => {
    expect(MAX_RETRIES).toBe(2);
    expect(shouldRetry('connect_timeout', 0)).toBe(true); // attempt 1 -> retry
    expect(shouldRetry('connect_timeout', 1)).toBe(true); // attempt 2 -> retry
    expect(shouldRetry('connect_timeout', 2)).toBe(false); // exhausted
    expect(shouldRetry('transport_error', 1)).toBe(true);
  });

  it('NEVER retries non-transient/deterministic kinds', () => {
    for (const k of ['call_timeout', 'tool_error', 'audit_error', 'parse_error'] as const) {
      expect(shouldRetry(k, 0)).toBe(false);
      expect(shouldRetry(k, 1)).toBe(false);
    }
  });
});

describe('envelope (correlation + dimensions)', () => {
  it('carries every required dimension and a uuid correlation id', () => {
    const env = buildEnvelope({
      consumer: 'llm_chat',
      tool: 'get_account_360',
      clientid: 7,
      environment: 'local',
      startedAt: 1000,
      now: 1421,
    });
    expect(env.consumer).toBe('llm_chat');
    expect(env.tool).toBe('get_account_360');
    expect(env.clientid).toBe(7);
    expect(env.environment).toBe('local');
    expect(env.started_at).toBe(new Date(1000).toISOString());
    expect(env.duration_ms).toBe(421);
    expect(env.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('produces a distinct correlation id per call', () => {
    const a = buildEnvelope({
      consumer: 'c',
      tool: 't',
      clientid: 1,
      environment: 'local',
      startedAt: 0,
      now: 1,
    });
    const b = buildEnvelope({
      consumer: 'c',
      tool: 't',
      clientid: 1,
      environment: 'local',
      startedAt: 0,
      now: 1,
    });
    expect(a.correlation_id).not.toBe(b.correlation_id);
  });
});

describe('structured failure report', () => {
  it('is ok:false, names the kind/message, carries dimensions & attempts', () => {
    const env = buildEnvelope({
      consumer: 'ops_operator',
      tool: 'get_reconciliation_snapshot',
      clientid: 3,
      environment: 'production',
      startedAt: 100,
      now: 9100,
    });
    const rep = buildFailureReport(env, {
      kind: 'connect_timeout',
      message: 'deadline',
      attempts: 3,
    });
    expect(rep.ok).toBe(false);
    expect(rep.failure.kind).toBe('connect_timeout');
    expect(rep.failure.message).toBe('deadline');
    expect(rep.attempts).toBe(3);
    expect(rep.consumer).toBe('ops_operator');
    expect(rep.tool).toBe('get_reconciliation_snapshot');
    expect(rep.clientid).toBe(3);
    expect(rep.environment).toBe('production');
    expect(rep.correlation_id).toBe(env.correlation_id);
    expect(rep.duration_ms).toBe(9000);
    // Never leak values in a failure report.
    expect(JSON.stringify(rep)).not.toMatch(/raw"/);
  });
});

describe('classmap source labelling', () => {
  it('is authoritative when an audit trace is present', () => {
    expect(classmapSourceFor({ tracePresent: true, fromTrace: true })).toBe(
      'authoritative'
    );
  });
  it('falls back & labels inference when trace absent', () => {
    expect(
      classmapSourceFor({ tracePresent: false, fromTrace: false })
    ).toMatch(/inferred/);
  });
  it('labels tool-output classmap distinctly', () => {
    expect(
      classmapSourceFor({
        tracePresent: false,
        fromTrace: false,
        toolClassmap: true,
      })
    ).toBe('tool-output');
  });
});

describe('metrics aggregation', () => {
  const mk = (
    ok: boolean,
    tool: string,
    consumer: string,
    kind?: string
  ): JobOutcome => ({
    ok,
    tool,
    consumer,
    clientid: 1,
    ...(kind ? { failure_kind: kind } : {}),
  });

  it('counts totals, ok/failed, and reliability_pct', () => {
    const m = aggregateMetrics([
      mk(true, 'get_stats', 'llm_chat'),
      mk(true, 'get_account_360', 'llm_chat'),
      mk(false, 'get_account_360', 'ops_operator', 'connect_timeout'),
      mk(false, 'get_reconciliation_snapshot', 'ops_operator', 'call_timeout'),
    ]);
    expect(m.total).toBe(4);
    expect(m.ok).toBe(2);
    expect(m.failed).toBe(2);
    expect(m.reliability_pct).toBe(50);
  });

  it('groups by_kind / by_tool / by_consumer', () => {
    const m = aggregateMetrics([
      mk(true, 'get_stats', 'llm_chat'),
      mk(false, 'get_account_360', 'llm_chat', 'connect_timeout'),
      mk(false, 'get_account_360', 'ops_operator', 'connect_timeout'),
      mk(false, 'get_reconciliation_snapshot', 'ops_operator', 'audit_error'),
    ]);
    expect(m.by_kind).toEqual({ connect_timeout: 2, audit_error: 1 });
    expect(m.by_tool.get_account_360).toEqual({ ok: 0, failed: 2 });
    expect(m.by_tool.get_stats).toEqual({ ok: 1, failed: 0 });
    expect(m.by_consumer.ops_operator).toEqual({ ok: 0, failed: 2 });
    expect(m.by_consumer.llm_chat).toEqual({ ok: 1, failed: 1 });
  });

  it('reliability is 100 on an all-ok set and 0 on empty', () => {
    expect(aggregateMetrics([mk(true, 't', 'c')]).reliability_pct).toBe(100);
    const empty = aggregateMetrics([]);
    expect(empty.total).toBe(0);
    expect(empty.reliability_pct).toBe(0);
  });
});
