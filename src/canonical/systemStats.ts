/**
 * Canonical mapper — WHMCS GetStats → Canonical<CanonicalSystemStats>.
 * Single object only — GetStats returns one aggregate snapshot, so there is
 * NO plural form. COMPLETE; projection later.
 *
 * GetStats is a GLOBAL/admin read of AGGREGATE counters (income totals,
 * order/client/ticket/service counts). It is not client-scoped and carries no
 * per-customer PII — values are roll-ups, never an individual's data.
 *
 * Canonical-entity assumption: the frozen CanonicalEntity union
 * (governance/types.ts) is NOT extended. An aggregate stats snapshot is an
 * admin operational record → closest frozen entity is 'activity'.
 *
 * The WHMCS shape is a flat-ish bag of counters whose exact keys vary by
 * build, so we model it as a single object with a permissive `metrics` map of
 * scalar values, and classify EVERY emitted path with a key-pattern
 * classifier so the classmap is always complete (an unmapped path would be
 * treated RESTRICTED downstream). Pattern:
 *   - income|revenue|amount|balance|fees|credit → financial.amount
 *   - *id / *_id (id-ish)                        → business.identifier
 *   - note|message|text|comment|announcement     → untrusted.free_text
 *   - everything else (aggregate counter)        → public.safe
 * See docs/PHASE_B_GOVERNANCE.md §3.
 */
import type { Canonical, FieldClass } from '../governance/types.js';
import { asRecord, isRecord, ClassMapBuilder } from './_shared.js';

export interface CanonicalSystemStats {
  /** Permissive map of scalar aggregate counters (string|number|boolean). */
  metrics: Record<string, string | number | boolean>;
}

const FINANCIAL_RE = /(income|revenue|amount|balance|fees|credit)/i;
const FREE_TEXT_RE = /(note|message|text|comment|announcement|description)/i;
const ID_RE = /(^|_)id$|(^|_)id_|^.*id$/i;

/** Classify a single metric key. UNKNOWN keys are still classified. */
function classifyKey(key: string): FieldClass {
  if (FINANCIAL_RE.test(key)) {
    return 'financial.amount';
  }
  if (FREE_TEXT_RE.test(key)) {
    return 'untrusted.free_text';
  }
  if (ID_RE.test(key)) {
    return 'business.identifier';
  }
  return 'public.safe';
}

/** Only scalar leaves are emitted; nested objects/arrays are skipped. */
function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    typeof v === 'boolean'
  );
}

/** Numeric strings become numbers; other scalars pass through unchanged. */
function coerce(v: string | number | boolean): string | number | boolean {
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return v;
}

export function mapToCanonicalSystemStats(
  raw: unknown
): Canonical<CanonicalSystemStats> {
  const src = asRecord(raw);
  const metrics: Record<string, string | number | boolean> = {};
  const builder = new ClassMapBuilder();
  // When `metrics` is empty {}, the completeness contract emits the container
  // path itself as a leaf — classify it (an empty aggregate container is
  // public.safe). Per-key paths below override with their precise class.
  builder.set('metrics', 'public.safe');

  for (const [key, value] of Object.entries(src)) {
    if (isRecord(value) || Array.isArray(value)) {
      continue;
    }
    if (!isScalar(value)) {
      continue;
    }
    metrics[key] = coerce(value);
    builder.set(`metrics.${key}`, classifyKey(key));
  }

  return {
    entity: 'activity',
    data: { metrics },
    classes: builder.build(),
  };
}
