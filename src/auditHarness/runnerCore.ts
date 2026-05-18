/**
 * PHASE H.1 — Track C: exposure-audit harness reliability core (PURE).
 *
 * The 150-job production pilot driving `scripts/mcp-exposure-audit.mjs` had
 * 43/150 runs (29%) produce NO report — silent stdio/timeout failures under
 * concurrency, disproportionately on the aggregator tools. That makes the
 * audit non-authoritative as a gate.
 *
 * This module owns the deterministic, side-effect-free decision logic that
 * makes the harness reliable so EVERY (consumer,tool,client) job yields
 * exactly one structured JSON object — either the redacted audit report OR a
 * structured failure — with:
 *
 *   - a stable failure taxonomy (six kinds) + a robust classifier,
 *   - a safe + deterministic retry predicate (transient kinds only),
 *   - a correlation/dimension envelope (uuid + consumer/tool/clientid/env +
 *     started_at/duration_ms),
 *   - a structured failure-report builder (never leaks values),
 *   - classmap-source labelling (authoritative trace vs inference fallback),
 *   - metrics aggregation for the batch rollup.
 *
 * It owns NO transport, NO config, NO I/O, NO WHMCS, NO MCP. Everything here
 * is unit-testable with synthetic inputs. The `.mjs` transport orchestration
 * (scripts/lib/auditRunner.mjs) is thin glue around these primitives.
 */

import { randomUUID } from 'node:crypto';

/* ─────────────────────────────  Failure taxonomy  ────────────────────────── */

/**
 * The closed set of failure kinds. Exactly the six the spec mandates.
 *   connect_timeout  — MCP client.connect() did not complete in time
 *   call_timeout     — client.callTool() did not complete in time
 *   transport_error  — stdio pipe broke / server died / spawn failed
 *   tool_error       — the governed tool returned an error result
 *   parse_error      — the tool payload was not parseable JSON we can audit
 *   audit_error      — the pure auditor (or trace adapter) threw
 */
export const FAILURE_KINDS = [
  'connect_timeout',
  'call_timeout',
  'transport_error',
  'tool_error',
  'parse_error',
  'audit_error',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The phase a failure was observed in (drives timeout disambiguation). */
export type Phase = 'connect' | 'call' | 'parse' | 'audit';

export interface ClassifiedFailure {
  readonly kind: FailureKind;
  readonly message: string;
}

function messageOf(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
    try {
      const json: string | undefined = JSON.stringify(err);
      return typeof json === 'string' ? json : 'unserializable error';
    } catch {
      return 'unserializable error';
    }
  }
  if (typeof err === 'number' || typeof err === 'bigint') {
    return err.toString();
  }
  if (typeof err === 'boolean') return err ? 'true' : 'false';
  if (typeof err === 'symbol') return err.toString();
  return 'non-string error';
}

function codeOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
    if (typeof c === 'number') return String(c);
  }
  return '';
}

function flagged(err: unknown, key: string): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as Record<string, unknown>)[key] === true
  );
}

const TIMEOUT_RE = /timed?\s*out|timeout|deadline|etimedout|esockettimedout/i;
const TRANSPORT_RE =
  /epipe|econnreset|econnrefused|broken pipe|closed|disconnect|spawn|exited|terminat|stream is not readable|premature close|server (?:crashed|died)|enoent/i;

/**
 * Classify any thrown/observed error into one of the six kinds, given the
 * phase it occurred in. Deterministic and total: ALWAYS returns a known
 * kind and a string message. Timeouts disambiguate by phase (connect vs
 * call); explicit flags (`mcpToolError`) and parse-phase syntax errors take
 * precedence so a deterministic failure is never misfiled as transient.
 */
export function classifyFailure(
  err: unknown,
  phase: Phase
): ClassifiedFailure {
  const message = messageOf(err);
  const code = codeOf(err);

  // Explicit, unambiguous signals first.
  if (flagged(err, 'mcpToolError')) {
    return { kind: 'tool_error', message };
  }
  if (phase === 'parse' || err instanceof SyntaxError) {
    return { kind: 'parse_error', message };
  }
  if (phase === 'audit' && !flagged(err, 'isTimeout')) {
    return { kind: 'audit_error', message };
  }

  const looksTimeout =
    flagged(err, 'isTimeout') ||
    code === 'TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    TIMEOUT_RE.test(message);
  if (looksTimeout) {
    return {
      kind: phase === 'call' ? 'call_timeout' : 'connect_timeout',
      message,
    };
  }

  const looksTransport =
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOENT' ||
    TRANSPORT_RE.test(message);
  if (looksTransport) {
    return { kind: 'transport_error', message };
  }

  // Unknown error: attribute to its phase so it is never silently dropped
  // and never mis-labelled retryable.
  if (phase === 'connect') return { kind: 'connect_timeout', message };
  if (phase === 'call') return { kind: 'transport_error', message };
  return { kind: 'audit_error', message };
}

/* ─────────────────────────────  Retry policy  ────────────────────────────── */

/** Retry budget for transient kinds (the original attempt is attempt 0). */
export const MAX_RETRIES = 2;

const TRANSIENT: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'connect_timeout',
  'transport_error',
]);

/**
 * Transient ⇔ safe to retry: the read is idempotent (governance read_only)
 * and the failure is a connection/stdio hiccup, NOT a deterministic outcome.
 * `call_timeout`, `tool_error`, `audit_error`, `parse_error` are NEVER
 * retried — retrying them would just burn time and could mask a real
 * deterministic problem behind eventual noise.
 */
export function isTransientKind(kind: FailureKind): boolean {
  return TRANSIENT.has(kind);
}

/**
 * `attemptIndex` is 0-based: 0 = original attempt just failed. Retry while
 * transient AND we have not yet consumed the MAX_RETRIES budget.
 */
export function shouldRetry(kind: FailureKind, attemptIndex: number): boolean {
  return isTransientKind(kind) && attemptIndex < MAX_RETRIES;
}

/** Fixed (deterministic, non-jittered) backoff in ms before retry N. */
export function backoffMs(attemptIndex: number): number {
  const SLOTS = [250, 750];
  return SLOTS[Math.min(attemptIndex, SLOTS.length - 1)] ?? 750;
}

/* ──────────────────────  Correlation + dimensions  ──────────────────────── */

export interface EnvelopeInput {
  readonly consumer: string;
  readonly tool: string;
  readonly clientid: number | string;
  readonly environment: string;
  readonly startedAt: number;
  /** Defaults to Date.now(); injectable for deterministic tests. */
  readonly now?: number;
}

export interface Envelope {
  readonly correlation_id: string;
  readonly consumer: string;
  readonly tool: string;
  readonly clientid: number | string;
  readonly environment: string;
  readonly started_at: string;
  readonly duration_ms: number;
}

/**
 * Build the correlation/dimension envelope every report or failure carries.
 * A fresh uuid per job lets the batch rollup and external logs join silent
 * gaps to their structured failure.
 */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  const now = input.now ?? Date.now();
  return {
    correlation_id: randomUUID(),
    consumer: input.consumer,
    tool: input.tool,
    clientid: input.clientid,
    environment: input.environment,
    started_at: new Date(input.startedAt).toISOString(),
    duration_ms: Math.max(0, now - input.startedAt),
  };
}

/* ─────────────────────────  Structured failure  ──────────────────────────── */

export interface FailureDetail {
  readonly kind: FailureKind;
  readonly message: string;
  readonly attempts: number;
}

export interface FailureReport {
  readonly ok: false;
  readonly failure: { readonly kind: FailureKind; readonly message: string };
  readonly attempts: number;
  readonly correlation_id: string;
  readonly consumer: string;
  readonly tool: string;
  readonly clientid: number | string;
  readonly environment: string;
  readonly started_at: string;
  readonly duration_ms: number;
}

/**
 * The structured failure object emitted (exactly once) on stdout when a job
 * cannot produce an audit report. Carries the full envelope + attempts so
 * the gate can classify and explain residual failures instead of silently
 * counting them as success. Never contains a raw value.
 */
export function buildFailureReport(
  env: Envelope,
  detail: FailureDetail
): FailureReport {
  return {
    ok: false,
    failure: { kind: detail.kind, message: detail.message },
    attempts: detail.attempts,
    correlation_id: env.correlation_id,
    consumer: env.consumer,
    tool: env.tool,
    clientid: env.clientid,
    environment: env.environment,
    started_at: env.started_at,
    duration_ms: env.duration_ms,
  };
}

/* ─────────────────────────  Classmap source label  ───────────────────────── */

export interface ClassmapSourceInput {
  /** `payload.__audit_trace` was present (Track-A producer emitted it). */
  readonly tracePresent: boolean;
  /** `auditFromTrace` was available AND consumed the trace successfully. */
  readonly fromTrace: boolean;
  /** A `payload.__classmap` was surfaced by the tool (legacy path). */
  readonly toolClassmap?: boolean;
}

/**
 * Single source of truth for the `classmap_source` label so reliability
 * metrics can show authoritative-trace coverage vs inference fallback.
 */
export function classmapSourceFor(input: ClassmapSourceInput): string {
  if (input.tracePresent && input.fromTrace) return 'authoritative';
  if (input.toolClassmap === true) return 'tool-output';
  return 'inferred (classmap unavailable from tool output)';
}

/* ───────────────────────────  Metrics rollup  ────────────────────────────── */

export interface JobOutcome {
  readonly ok: boolean;
  readonly tool: string;
  readonly consumer: string;
  readonly clientid: number | string;
  /** Present iff !ok. */
  readonly failure_kind?: string;
}

export interface DimensionCount {
  ok: number;
  failed: number;
}

export interface MetricsRollup {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly by_kind: Record<string, number>;
  readonly by_tool: Record<string, DimensionCount>;
  readonly by_consumer: Record<string, DimensionCount>;
  /** Percentage of jobs that produced an audit report, 0–100, 1 decimal. */
  readonly reliability_pct: number;
}

function bump(
  map: Record<string, DimensionCount>,
  key: string,
  ok: boolean
): void {
  const slot = (map[key] ??= { ok: 0, failed: 0 });
  if (ok) slot.ok += 1;
  else slot.failed += 1;
}

/**
 * Aggregate per-job outcomes into the batch rollup the pilot prints to
 * stdout (redacted) and writes to .audit-local/. `reliability_pct` is the
 * authoritative gate number: % of jobs that produced an audit report. A
 * structured failure counts as failed (NOT masked as success), so residual
 * production failures stay visible and classifiable.
 */
export function aggregateMetrics(
  outcomes: readonly JobOutcome[]
): MetricsRollup {
  const total = outcomes.length;
  let okCount = 0;
  const byKind: Record<string, number> = {};
  const byTool: Record<string, DimensionCount> = {};
  const byConsumer: Record<string, DimensionCount> = {};

  for (const o of outcomes) {
    if (o.ok) {
      okCount += 1;
    } else {
      const k = o.failure_kind ?? 'unknown';
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    bump(byTool, o.tool, o.ok);
    bump(byConsumer, o.consumer, o.ok);
  }

  const failed = total - okCount;
  const reliability =
    total === 0 ? 0 : Math.round((okCount / total) * 1000) / 10;

  return {
    total,
    ok: okCount,
    failed,
    by_kind: byKind,
    by_tool: byTool,
    by_consumer: byConsumer,
    reliability_pct: reliability,
  };
}
