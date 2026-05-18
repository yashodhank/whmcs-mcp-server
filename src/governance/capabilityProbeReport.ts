/**
 * Phase G — PURE capability-probe report model.
 *
 * The deliberate, operator-run read-only verification probe
 * (`scripts/mcp-capability-probe.mjs`) issues at most ONE minimal
 * `limitnum:1` read-only call per UNVERIFIED action and feeds the raw
 * outcome here for classification. This module:
 *
 *   - owns NO transport, NO config, NO I/O, NO WHMCS;
 *   - performs NO read-allowlist promotion (the orchestrator handles any
 *     deliberate `READ_ALLOWLIST` / `capabilities.ts` change separately);
 *   - mirrors the EXACT classification pattern strings used by the live
 *     `capabilities.ts` probe so a verification run and a runtime probe
 *     agree byte-for-byte:
 *       access-denied / permission text → not_authorized
 *       unknown-action text             → unsupported
 *       any other result:'error'        → degraded
 *       a thrown transport/other error  → degraded
 *       a result:'success'              → supported
 *   - emits ONLY a short classification `evidence` string — NEVER the raw
 *     WHMCS response body (no PII can leak through a probe report).
 *
 * Imports the FROZEN seam `./types.js` only.
 */

import type { CapabilityStatusValue } from './types.js';

/* ─────────────────────────  Action → capability map  ─────────────────────── */

/**
 * The five UNVERIFIED reads this probe is built to verify, mirroring
 * `capabilities.ts` UNVERIFIED_READS verbatim. Kept as a local constant (no
 * import of the mutable registry) so this module stays pure and cannot be
 * coupled to runtime promotion state.
 */
const PROBE_CAPABILITY_MAP: Readonly<Record<string, string>> = {
  GetTransactions: 'list_client_transactions',
  GetStats: 'get_system_stats',
  GetToDoItems: 'list_todo_items',
  GetAutomationLog: 'list_automation_log',
  GetUsers: 'list_users',
};

/**
 * Derive a stable snake_case capability id for an action not in the probe
 * map. This is the SAME algorithm as `capabilities.ts` `synthesizeCapabilityId`
 * so the two modules never disagree on a name.
 */
function synthesizeCapabilityId(action: string): string {
  const snake = action
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  return snake.length > 0 ? snake : 'unknown_action';
}

function capabilityFor(action: string): string {
  return Object.hasOwn(PROBE_CAPABILITY_MAP, action)
    ? PROBE_CAPABILITY_MAP[action]
    : synthesizeCapabilityId(action);
}

/* ─────────────────────────  Classification patterns  ─────────────────────── */

/* These two arrays are copied VERBATIM from `capabilities.ts` so the
 * verification probe and the runtime probe classify identically. If
 * `capabilities.ts` changes its patterns, this list must change in lockstep. */
const ACCESS_DENIED_PATTERNS = [
  'access denied',
  'permission',
  'not permitted',
  'unauthor', // unauthorized / unauthorised
  'authentication failed',
  'invalid permission',
];

const UNKNOWN_ACTION_PATTERNS = [
  'action could not be found',
  'action not found',
  'invalid action',
  'unknown action',
  'requested api action',
];

/* ─────────────────────────────  Outcome shapes  ──────────────────────────── */

/** The raw outcome of a single probe attempt. Exactly one of the two fields
 * is expected; both absent ⇒ no usable outcome ⇒ `degraded`. */
export interface ProbeOutcome {
  /** A returned WHMCS response value (result:'success' or result:'error'). */
  readonly response?: unknown;
  /** A thrown transport/other error, OR a returned result:'error' payload. */
  readonly error?: unknown;
}

/** A classified, PII-free probe result. `evidence` is a short fixed-vocabulary
 * classification string — never the raw response body. */
export interface ProbeResult {
  readonly action: string;
  readonly capability: string;
  readonly status: 'supported' | 'not_authorized' | 'unsupported' | 'degraded';
  readonly evidence: string;
}

/* ─────────────────────────  Message extraction  ──────────────────────────── */

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return '';
}

function responseIsError(value: unknown): { isError: boolean; message: string } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    (value as { result: unknown }).result === 'error'
  ) {
    const msg =
      'message' in value &&
      typeof (value as { message: unknown }).message === 'string'
        ? (value as { message: string }).message
        : '';
    return { isError: true, message: msg };
  }
  return { isError: false, message: '' };
}

function responseIsSuccess(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    (value as { result: unknown }).result === 'success'
  );
}

/**
 * Map a WHMCS error message to a status using the SAME precedence as
 * `capabilities.ts` classifyFailure: access-denied/permission first
 * (not_authorized), then unknown-action (unsupported), else degraded.
 * Returns a short classification `evidence` string only — never the message
 * body itself (the message could echo PII).
 */
function classifyMessage(
  message: string
): { status: ProbeResult['status']; evidence: string } {
  const lower = message.toLowerCase();
  if (ACCESS_DENIED_PATTERNS.some((p) => lower.includes(p))) {
    return {
      status: 'not_authorized',
      evidence: 'whmcs denied access for the configured api credentials',
    };
  }
  if (UNKNOWN_ACTION_PATTERNS.some((p) => lower.includes(p))) {
    return {
      status: 'unsupported',
      evidence: 'whmcs reports this action does not exist on the install',
    };
  }
  return {
    status: 'degraded',
    evidence: 'probe could not be completed (transport/other error)',
  };
}

/* ─────────────────────────────  Public API  ──────────────────────────────── */

/**
 * Classify a single probe outcome into a PII-free {@link ProbeResult}.
 *
 * - `response` with result:'success'      → supported
 * - `response`/`error` with result:'error':
 *     access-denied/permission text       → not_authorized
 *     unknown-action text                 → unsupported
 *     any other message                   → degraded
 * - a thrown transport/other `error`      → degraded
 * - neither a usable response nor error   → degraded
 *
 * PURE: no WHMCS, no I/O, no allowlist read/write. Never returns the raw
 * response body — only a short classification `evidence` string.
 */
export function classifyProbeOutcome(
  action: string,
  outcome: ProbeOutcome
): ProbeResult {
  const capability = capabilityFor(action);

  // A returned response wins when present (success or structured error).
  if (outcome.response !== undefined) {
    if (responseIsSuccess(outcome.response)) {
      return {
        action,
        capability,
        status: 'supported',
        evidence: 'probe succeeded against the live whmcs install',
      };
    }
    const asError = responseIsError(outcome.response);
    if (asError.isError) {
      const c = classifyMessage(asError.message);
      return { action, capability, status: c.status, evidence: c.evidence };
    }
    // A response with neither result:'success' nor result:'error' is not an
    // outcome we can trust — treat conservatively as degraded.
    return {
      action,
      capability,
      status: 'degraded',
      evidence: 'probe returned an unrecognized response shape',
    };
  }

  // No response: a thrown error, or a structured result:'error' payload.
  if (outcome.error !== undefined) {
    const structured = responseIsError(outcome.error);
    const message = structured.isError
      ? structured.message
      : extractErrorMessage(outcome.error);
    const c = classifyMessage(message);
    return { action, capability, status: c.status, evidence: c.evidence };
  }

  // Nothing usable — conservative.
  return {
    action,
    capability,
    status: 'degraded',
    evidence: 'no probe outcome was produced',
  };
}

/** Aggregate report over a probe run. PII-free by construction. */
export interface ProbeReportSummary {
  readonly total: number;
  readonly supported: number;
  readonly not_authorized: number;
  readonly unsupported: number;
  readonly degraded: number;
}

export interface ProbeReport {
  readonly generated_at: string;
  readonly results: readonly ProbeResult[];
  readonly summary: ProbeReportSummary;
}

/**
 * Build the final report from classified results. PURE. The output contains
 * ONLY {action, capability, status, evidence} per result plus counts — never
 * a raw WHMCS response body.
 */
export function buildProbeReport(
  results: readonly ProbeResult[]
): ProbeReport {
  const summary: {
    total: number;
    supported: number;
    not_authorized: number;
    unsupported: number;
    degraded: number;
  } = {
    total: results.length,
    supported: 0,
    not_authorized: 0,
    unsupported: 0,
    degraded: 0,
  };

  for (const r of results) {
    const key: keyof ProbeReportSummary = r.status;
    summary[key] += 1;
  }

  return {
    generated_at: new Date().toISOString(),
    results: [...results],
    summary,
  };
}

/* `CapabilityStatusValue` is imported to bind this module to the frozen seam
 * vocabulary; the probe's four-value subset is a strict subset of it. */
const _STATUS_SUBSET: readonly CapabilityStatusValue[] = [
  'supported',
  'not_authorized',
  'unsupported',
  'degraded',
];
void _STATUS_SUBSET;
