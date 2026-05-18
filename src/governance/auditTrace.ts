/**
 * PHASE H.1 / Track A1 — the shared, AUTHORITATIVE audit-trace seam.
 *
 * A `project()` call makes exactly ONE decision per top-level canonical key:
 * resolve its `FieldClass`, look up the contract's `ProjectionAction`, apply
 * it. The exposure auditor previously had to RE-DERIVE that decision by
 * name-inferring classes off the projected leaves — a non-authoritative path
 * that produced false `violations == unknown_fields` artifacts in the pilot.
 *
 * This module defines the record `projectWithTrace()` emits from the SAME
 * internal decision `project()` uses, so the auditor can compute its report
 * PURELY from the trace (no inference). The trace is VALUE-FREE by
 * construction: it carries only paths, classes, decisions, reasons — NEVER a
 * field value — so it is safe to surface even under a production read-only
 * deployment.
 *
 * Imports only the frozen seam `governance/types.js`.
 */

import type { FieldClass } from './types.js';

/**
 * Sentinel `field_classification` for a top-level canonical key that has NO
 * entry in `canonical.classes`. It is NOT a member of `FIELD_CLASSES` (an
 * unmapped key is genuinely unclassified — it is dropped, never "safe"); the
 * auditor special-cases this literal alongside `rule_id === 'unmapped_dropped'`.
 */
export const UNMAPPED = 'unmapped' as const;

/** The real, authoritative decision the projector took for one path. */
export type ProjectionDecision =
  | 'emit'
  | 'mask'
  | 'omit'
  | 'wrap_untrusted'
  | 'deny';

/** State of the source value WITHOUT ever carrying the value itself. */
export type TraceValueState =
  | 'present'
  | 'null'
  | 'missing'
  | 'masked'
  | 'omitted';

export interface AuditTraceRecord {
  /**
   * The `canonical.data` path the decision was made on. For aggregators this
   * is the TOP-LEVEL key (nested leaves ride their ancestor's decision); for
   * entity classmaps it is the field path.
   */
  readonly source_path: string;
  /** Path in the projected output. `''` when omitted / denied. */
  readonly output_path: string;
  /** The REAL resolved class (never guessed), or `UNMAPPED`. */
  readonly field_classification: FieldClass | typeof UNMAPPED;
  readonly consumer_id: string;
  /** ContractName (kept as string — the seam stays decoupled from the union). */
  readonly contract: string;
  readonly projection_decision: ProjectionDecision;
  /**
   * Stable rule id:
   *   `${contract}:${field_classification}->${action}` for a normal decision,
   *   `'env_forbidden'`  for an env-gate deny,
   *   `'unmapped_dropped'` for an unmapped top-level key.
   */
  readonly rule_id: string;
  /** Short, human-facing reason. Never a field value. */
  readonly reason: string;
  readonly value_state: TraceValueState;
  /** ProjectionEnv the decision was evaluated in. */
  readonly environment: string;
  /** Tool / workflow name. */
  readonly tool: string;
}

/** Caller-supplied identity for the records a single projection produces. */
export interface AuditTraceContext {
  readonly consumer_id: string;
  readonly contract: string;
  readonly tool: string;
}
