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
 */
export function redactedReport(
  report: ExposureAuditReport
): ExposureAuditReport {
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
