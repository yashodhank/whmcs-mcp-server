/**
 * Phase H — PURE exposure-audit model.
 *
 * This module answers a single, narrow question: given a projected output
 * (exactly what a tool emitted for a consumer under a named contract) plus
 * the canonical entity's `FieldClassMap` and the contract's per-`FieldClass`
 * policy, WHAT did we actually expose and is each emitted field safe under
 * that contract?
 *
 * It is the read-side counterpart of `governance/projection.ts`. It does NOT
 * re-project, redact, or block anything — projection already happened. It
 * only *inspects* the result and reports:
 *
 *   - every emitted leaf path + its classification (UNKNOWN if the canonical
 *     classmap has no entry for that path),
 *   - the value-state (present | null | masked | omitted),
 *   - whether the contract policy *permits* that class to be emitted,
 *   - a PII-SAFE sample — by default ONLY `{ length, sha8 }` (the first 8 hex
 *     chars of the value's sha256). The raw value is included ONLY when the
 *     caller passes `localShowValues: true` (operator, local, synthetic data).
 *
 * It owns NO transport, NO config, NO I/O, NO WHMCS, and imports ONLY the
 * frozen governance seam `governance/types.js` (for the `FieldClass` union).
 * `redactedReport()` produces a copy guaranteed free of any `sample.raw` for
 * safe stdout / committed artifacts.
 */

import { createHash } from 'node:crypto';

import type { FieldClass } from '../governance/types.js';
import {
  UNMAPPED,
  type AuditTraceRecord,
  type ProjectionDecision,
} from '../governance/auditTrace.js';

/* ─────────────────────────────  Public shapes  ───────────────────────────── */

/** Where a class label comes from: the canonical map, or unmatched. */
export const UNKNOWN_CLASS = 'UNKNOWN' as const;
export type ClassificationLabel = FieldClass | typeof UNKNOWN_CLASS;

/**
 * State of an emitted (or expected-but-absent) leaf.
 *   present  — a non-null value was emitted
 *   null     — the key was emitted with a literal null
 *   masked   — emitted, but the string looks partially redacted
 *   omitted  — a classified canonical leaf that was NOT emitted at all
 */
export type ValueState = 'present' | 'null' | 'masked' | 'omitted';

/** PII-safe value fingerprint. `raw` ONLY when localShowValues was set. */
export interface ValueSample {
  /** Character length of the stringified value (0 for null/omitted). */
  readonly length: number;
  /** First 8 hex chars of sha256 of the stringified value. */
  readonly sha8: string;
  /** The raw value — present ONLY under operator localShowValues. */
  readonly raw?: unknown;
}

export interface ExposedField {
  /** Dot/`[]` leaf path, e.g. `client.email`, `replies[].message`. */
  readonly path: string;
  readonly classification: ClassificationLabel;
  readonly value_state: ValueState;
  /**
   * True if the contract policy for this field's class permits emission
   * (allow / mask / summarize / wrap_untrusted). False for `drop` or an
   * UNKNOWN (unclassified) emitted path.
   */
  readonly allowed: boolean;
  readonly sample: ValueSample;
}

export interface ExposureAuditSummary {
  readonly emitted_count: number;
  /** Emitted but the contract says drop, OR an unknown-class emitted path. */
  readonly violations: readonly string[];
  /** Contract allows the class but the path was omitted or masked. */
  readonly over_masked: readonly string[];
  /**
   * Risky class (pii.* / secret.* / financial.reference) emitted RAW while
   * the contract said mask / summarize / drop.
   */
  readonly under_masked: readonly string[];
  /** Emitted leaf path with no classification in the canonical map. */
  readonly unknown_fields: readonly string[];
}

export interface ExposureAuditReport {
  readonly consumer_id: string;
  readonly contract: string;
  readonly tool: string;
  readonly fields: readonly ExposedField[];
  readonly summary: ExposureAuditSummary;
}

export interface ExposureAuditInput {
  readonly consumer_id: string;
  readonly contract: string;
  readonly tool: string;
  /** Canonical field-path → FieldClass map (the projection's truth source). */
  readonly canonicalClasses: Record<string, FieldClass>;
  /** Exactly what the tool emitted for this consumer/contract. */
  readonly projected: Record<string, unknown>;
  /** The contract's per-FieldClass action (allow|mask|drop|summarize|wrap_*). */
  readonly contractPolicy: Record<FieldClass, string>;
  /**
   * Operator/local ONLY (synthetic data): include the raw value in each
   * sample. NEVER set this for a production-read or committed artifact.
   */
  readonly localShowValues?: boolean;
}

/* ─────────────────────────────  Helpers (pure)  ───────────────────────────── */

/** Classes whose RAW emission under a non-allow policy is high-risk. */
function isRiskyClass(cls: ClassificationLabel): boolean {
  return (
    cls === 'financial.reference' ||
    cls.startsWith('pii.') ||
    cls.startsWith('secret.')
  );
}

/** Policy actions that permit a value to leave the projector. */
function policyEmits(action: string | undefined): boolean {
  return (
    action === 'allow' ||
    action === 'mask' ||
    action === 'summarize' ||
    action === 'wrap_untrusted'
  );
}

const MASK_HINT = /\*{2,}|•{2,}|\[redacted/i;

/**
 * Heuristic: does a STRING value look like a partial-redaction mask?
 * Mirrors the mask shapes `governance/projection.ts` emits: `***`,
 * `j***@d***`, `******1234`, `****1234`, `***[redacted:N]`, bullet runs.
 * Never inspects non-strings.
 */
function looksMasked(value: unknown): boolean {
  return typeof value === 'string' && MASK_HINT.test(value);
}

function stableString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'undefined') return '';
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '[function]';
  // object (incl. arrays): stable JSON, falling back to a fixed sentinel
  // for non-serializable graphs (cycles) or `undefined`-yielding inputs —
  // never the unhelpful default `[object Object]`.
  try {
    const json: string | undefined = JSON.stringify(value);
    return typeof json === 'string' ? json : '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

function sha8Of(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
}

function buildSample(value: unknown, localShowValues: boolean): ValueSample {
  const s = stableString(value);
  const base: ValueSample = { length: s.length, sha8: sha8Of(s) };
  if (localShowValues) {
    return { ...base, raw: value };
  }
  return base;
}

/**
 * Recursively collect every LEAF path of an emitted object into
 * `out[path] = value`. Arrays collapse the index to `[]` so a path matches
 * the canonical map's `replies[].message` convention. A leaf is anything
 * that is not a plain walkable object/array (including `null`, primitives,
 * empty objects and empty arrays).
 */
function collectLeaves(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, value);
      return;
    }
    for (const el of value) {
      collectLeaves(el, `${prefix}[]`, out);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      out.set(prefix, value);
      return;
    }
    for (const k of keys) {
      const childPath = prefix.length === 0 ? k : `${prefix}.${k}`;
      collectLeaves(obj[k], childPath, out);
    }
    return;
  }
  // primitive | null | undefined → a leaf
  out.set(prefix, value);
}

/* ─────────────────────────────  Public API  ──────────────────────────────── */

/**
 * Audit a projected output against the canonical classmap + contract policy.
 *
 * PURE: no I/O, no mutation of inputs. Returns a fresh report. By default the
 * report embeds NO raw values — only `{ length, sha8 }` per field. Pass
 * `localShowValues: true` ONLY for an operator, local, synthetic-data run.
 */
export function auditExposure(input: ExposureAuditInput): ExposureAuditReport {
  const {
    consumer_id,
    contract,
    tool,
    canonicalClasses,
    projected,
    contractPolicy,
  } = input;
  const localShowValues = input.localShowValues === true;

  const leaves = new Map<string, unknown>();
  collectLeaves(projected, '', leaves);
  // A degenerate empty-object projection produces a single '' key — drop it;
  // there is no emitted field to report.
  leaves.delete('');

  const fields: ExposedField[] = [];
  const violations: string[] = [];
  const overMasked: string[] = [];
  const underMasked: string[] = [];
  const unknownFields: string[] = [];

  for (const [path, value] of leaves) {
    const mapped = Object.prototype.hasOwnProperty.call(
      canonicalClasses,
      path
    )
      ? canonicalClasses[path]
      : undefined;
    const classification: ClassificationLabel = mapped ?? UNKNOWN_CLASS;

    let valueState: ValueState;
    if (value === null) {
      valueState = 'null';
    } else if (looksMasked(value)) {
      valueState = 'masked';
    } else {
      valueState = 'present';
    }

    const action =
      mapped === undefined ? undefined : contractPolicy[mapped];
    const allowed = mapped !== undefined && policyEmits(action);

    fields.push({
      path,
      classification,
      value_state: valueState,
      allowed,
      sample: buildSample(value, localShowValues),
    });

    if (mapped === undefined) {
      // Unclassified emitted leaf: both an unknown field and a violation
      // (we exposed something governance never sanctioned).
      unknownFields.push(path);
      violations.push(path);
      continue;
    }

    if (action === 'drop') {
      // Contract said this class must never be emitted, yet it was.
      violations.push(path);
    } else if (
      isRiskyClass(classification) &&
      action !== 'allow' &&
      valueState === 'present'
    ) {
      // A masking/summarizing/dropping contract for a risky class, but a
      // raw (non-masked, non-null) value made it out.
      underMasked.push(path);
    }
  }

  // over_masked: a classified canonical leaf the contract WOULD allow to be
  // emitted, but the projection either omitted it entirely or masked it.
  for (const canonicalPath of Object.keys(canonicalClasses)) {
    const cls = canonicalClasses[canonicalPath];
    if (!policyEmits(contractPolicy[cls])) continue;
    if (contractPolicy[cls] !== 'allow') continue;

    if (!leaves.has(canonicalPath)) {
      overMasked.push(canonicalPath);
      fields.push({
        path: canonicalPath,
        classification: cls,
        value_state: 'omitted',
        allowed: true,
        sample: { length: 0, sha8: sha8Of('') },
      });
      continue;
    }
    const emitted = leaves.get(canonicalPath);
    if (emitted !== null && looksMasked(emitted)) {
      overMasked.push(canonicalPath);
    }
  }

  return {
    consumer_id,
    contract,
    tool,
    fields,
    summary: {
      emitted_count: leaves.size,
      violations,
      over_masked: overMasked,
      under_masked: underMasked,
      unknown_fields: unknownFields,
    },
  };
}

/**
 * Return a deep-ish copy of a report with every `sample.raw` stripped, safe
 * to print to stdout, log, or commit. Does NOT mutate the input report.
 * Idempotent.
 *
 * Overloaded for BOTH report families:
 *  - the inference `ExposureAuditReport` (strips `sample.raw`), and
 *  - the trace-driven `AuthoritativeAuditReport` (already value-free by
 *    construction — returns a deep, stable copy).
 */
export function redactedReport(
  report: ExposureAuditReport
): ExposureAuditReport;
export function redactedReport(
  report: AuthoritativeAuditReport
): AuthoritativeAuditReport;
export function redactedReport(
  report: ExposureAuditReport | AuthoritativeAuditReport
): ExposureAuditReport | AuthoritativeAuditReport {
  if (isAuthoritative(report)) {
    return {
      classmap_source: 'authoritative',
      consumer_id: report.consumer_id,
      contract: report.contract,
      tool: report.tool,
      fields: report.fields.map((f) => ({
        source_path: f.source_path,
        output_path: f.output_path,
        field_classification: f.field_classification,
        projection_decision: f.projection_decision,
        value_state: f.value_state,
        rule_id: f.rule_id,
        allowed: f.allowed,
      })),
      summary: {
        emitted_count: report.summary.emitted_count,
        emitted: [...report.summary.emitted],
        masked: [...report.summary.masked],
        omitted: [...report.summary.omitted],
        violations: [...report.summary.violations],
        over_masked: [...report.summary.over_masked],
        under_masked: [...report.summary.under_masked],
        unknown_fields: [...report.summary.unknown_fields],
      },
    };
  }
  return {
    consumer_id: report.consumer_id,
    contract: report.contract,
    tool: report.tool,
    fields: report.fields.map((f) => {
      const { length, sha8 } = f.sample;
      return {
        path: f.path,
        classification: f.classification,
        value_state: f.value_state,
        allowed: f.allowed,
        sample: { length, sha8 },
      };
    }),
    summary: {
      emitted_count: report.summary.emitted_count,
      violations: [...report.summary.violations],
      over_masked: [...report.summary.over_masked],
      under_masked: [...report.summary.under_masked],
      unknown_fields: [...report.summary.unknown_fields],
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * PHASE H.1 / Track A3 — the AUTHORITATIVE, trace-driven auditor.
 *
 * `auditFromTrace` computes the exposure report PURELY from the value-free
 * `AuditTraceRecord[]` emitted by `projectWithTrace()` (the SAME per-key
 * decision `project()` makes). It performs NO name inference, so there are
 * NEVER UNKNOWN fields invented for nested aggregator leaves — every emitted
 * leaf rides its traced top-level key's REAL class. `classmap_source` is
 * `'authoritative'`. `auditExposure` (above) stays intact as the labelled
 * inference fallback.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Where the report's classifications came from. */
export type ClassmapSource = 'authoritative' | 'inferred';

/** One field as recorded by the authoritative trace (value-free). */
export interface AuthoritativeField {
  readonly source_path: string;
  readonly output_path: string;
  readonly field_classification: FieldClass | typeof UNMAPPED;
  readonly projection_decision: ProjectionDecision;
  readonly value_state: AuditTraceRecord['value_state'];
  readonly rule_id: string;
  /** True if the projection actually emitted (or masked/wrapped) the value. */
  readonly allowed: boolean;
}

export interface AuthoritativeAuditSummary {
  readonly emitted_count: number;
  /** source_paths the projector emitted (allow/summarize, value present). */
  readonly emitted: readonly string[];
  /** source_paths emitted as a partial-reveal mask. */
  readonly masked: readonly string[];
  /** source_paths the contract dropped (governance honoured — safe). */
  readonly omitted: readonly string[];
  /**
   * AUTHORITATIVE leak signal: the trace says a field was emitted whose
   * rule_id resolves to `->drop` (a real exposure of a drop-class field).
   */
  readonly violations: readonly string[];
  /** Emitted-but-masked where the class's action was a plain `allow`. */
  readonly over_masked: readonly string[];
  /** A risky class whose trace decision was `emit` (raw) under a non-allow rule. */
  readonly under_masked: readonly string[];
  /** Unmapped top-level keys (rule_id 'unmapped_dropped'). */
  readonly unknown_fields: readonly string[];
}

export interface AuthoritativeAuditReport {
  readonly classmap_source: ClassmapSource;
  readonly consumer_id: string;
  readonly contract: string;
  readonly tool: string;
  readonly fields: readonly AuthoritativeField[];
  readonly summary: AuthoritativeAuditSummary;
}

export interface AuditFromTraceMeta {
  readonly consumer_id: string;
  readonly contract: string;
  readonly tool: string;
}

function isAuthoritative(
  r: ExposureAuditReport | AuthoritativeAuditReport
): r is AuthoritativeAuditReport {
  return (
    (r as AuthoritativeAuditReport).classmap_source === 'authoritative'
  );
}

/** Risk classes whose RAW (`emit`) trace decision under a non-allow rule leaks. */
function isRiskyAuthoritative(
  cls: FieldClass | typeof UNMAPPED
): boolean {
  return (
    cls === 'financial.reference' ||
    cls.startsWith('pii.') ||
    cls.startsWith('secret.')
  );
}

/** Parse the action suffix of a rule_id (`contract:class->action`). */
function actionOf(rule_id: string): string | null {
  const arrow = rule_id.indexOf('->');
  return arrow >= 0 ? rule_id.slice(arrow + 2) : null;
}

/**
 * Build the authoritative exposure report from a projection trace.
 *
 * PURE. No I/O, no inference. The report is value-free (the trace itself
 * never carried a value), so it is safe under a production read-only run.
 */
export function auditFromTrace(
  trace: readonly AuditTraceRecord[],
  meta: AuditFromTraceMeta
): AuthoritativeAuditReport {
  const fields: AuthoritativeField[] = [];
  const emitted: string[] = [];
  const masked: string[] = [];
  const omitted: string[] = [];
  const violations: string[] = [];
  const overMasked: string[] = [];
  const underMasked: string[] = [];
  const unknownFields: string[] = [];

  for (const r of trace) {
    // The env-gate deny record has an empty source_path and represents a
    // whole-projection refusal — record the field, count nothing emitted.
    const decision = r.projection_decision;
    const action = actionOf(r.rule_id);
    const wasEmitted =
      decision === 'emit' ||
      decision === 'mask' ||
      decision === 'wrap_untrusted';

    fields.push({
      source_path: r.source_path,
      output_path: r.output_path,
      field_classification: r.field_classification,
      projection_decision: decision,
      value_state: r.value_state,
      rule_id: r.rule_id,
      allowed: wasEmitted,
    });

    if (r.rule_id === 'env_forbidden' || decision === 'deny') {
      continue;
    }

    if (r.rule_id === 'unmapped_dropped') {
      // Unmapped key: governance DROPPED it (omit) → safe, not a violation.
      // Still reported as an unknown field for visibility.
      unknownFields.push(r.source_path);
      omitted.push(r.source_path);
      continue;
    }

    if (decision === 'omit') {
      omitted.push(r.source_path);
      continue;
    }

    if (decision === 'mask') {
      masked.push(r.source_path);
    } else {
      // emit / wrap_untrusted → value left the projector.
      emitted.push(r.source_path);
    }

    // AUTHORITATIVE leak: the rule says `->drop` but the trace emitted it.
    if (action === 'drop') {
      violations.push(r.source_path);
      continue;
    }

    // over_masked: the class's action is a plain `allow` but it was masked.
    if (decision === 'mask' && action === 'allow') {
      overMasked.push(r.source_path);
    }

    // under_masked: a risky class emitted RAW (`emit`, value present) under
    // a non-allow rule (mask/summarize/wrap) — the trace is the truth.
    if (
      decision === 'emit' &&
      r.value_state === 'present' &&
      action !== 'allow' &&
      isRiskyAuthoritative(r.field_classification)
    ) {
      underMasked.push(r.source_path);
    }
  }

  return {
    classmap_source: 'authoritative',
    consumer_id: meta.consumer_id,
    contract: meta.contract,
    tool: meta.tool,
    fields,
    summary: {
      emitted_count: emitted.length + masked.length,
      emitted,
      masked,
      omitted,
      violations,
      over_masked: overMasked,
      under_masked: underMasked,
      unknown_fields: unknownFields,
    },
  };
}
