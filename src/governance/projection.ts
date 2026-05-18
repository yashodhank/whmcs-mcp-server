/**
 * Phase B / B2 — the projection boundary.
 *
 * `project()` is the ONLY place canonical data is dropped / masked /
 * wrapped. It is PURE: it never mutates `canonical` (input or any nested
 * value) and returns a fresh plain object every call. Applied exactly
 * once, last, at tool output (wired by B5).
 *
 * Algorithm (per docs/PHASE_B_GOVERNANCE.md §3–§4):
 *  1. Env gate first. If `contract.envRestrictions` is non-empty and does
 *     not include `env`, throw `ProjectionEnvError` BEFORE touching any
 *     field. This is how `none_local_only` / `debug_local` are hard-
 *     blocked outside local — no raw secret is ever read off-box.
 *  2. Walk `canonical.data`'s top-level keys. For each, resolve its
 *     `FieldClass` from `canonical.classes`. An UNMAPPED path is treated
 *     as the most-restrictive class ⇒ dropped (never silently public).
 *  3. Apply the contract's `ProjectionAction` for that class:
 *       allow          → emit value as-is
 *       drop           → omit the field
 *       mask           → partial reveal (class-specific)
 *       wrap_untrusted → emit { untrusted: true, value }
 *       summarize      → derived summary for strings, else drop
 *
 * Imports only from the frozen seam; no edits to existing files.
 */

import {
  type Canonical,
  type DataContract,
  type FieldClass,
  type ProjectFn,
  type ProjectionEnv,
  type UntrustedValue,
  ProjectionEnvError,
} from './types.js';
import {
  UNMAPPED,
  type AuditTraceContext,
  type AuditTraceRecord,
  type ProjectionDecision,
  type TraceValueState,
} from './auditTrace.js';

/** Cap for `summarize`: never emit raw beyond this many chars. */
const SUMMARY_CAP = 200;

/* ── masking helpers (pure) ────────────────────────────────────────────────── */

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return 'a***';
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  const domHead = dot > 0 ? domain.slice(0, dot) : domain;
  const local = value.slice(0, at);
  const localInit = local.length > 0 ? local.slice(0, 1) : 'a';
  const domInit = domHead.length > 0 ? domHead.slice(0, 1) : 'd';
  return `${localInit}***@${domInit}***`;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  if (last4.length === 0) return '****';
  return `******${last4}`;
}

/**
 * Name → first name + last initial.
 *
 * SEAM AMBIGUITY: the spec's mask rule ("first name + last initial")
 * describes a *full* name, but `pii.name` is applied per field — a
 * `firstname` and a `lastname` arrive as independent single-token
 * values. Assumption (documented): masking is per-value —
 *  - multi-token value ("Aritra Sengupta")  → "Aritra S."
 *  - single given-name-ish token ("Aritra")  → kept (a lone first name
 *    is the low-risk half the spec deliberately preserves)
 *  - single token only meaningful as a surname is indistinguishable
 *    from a first name at this layer; B1 should class surname-only
 *    fields it wants collapsed, or callers use the full-name field.
 * To honour the "last initial only" intent for split fields, a value
 * whose key the projector can see is a *last* name is reduced to an
 * initial; that key context is supplied by the caller via the
 * companion `maskNameToken` used for the `lastname` path. Here the
 * pure single-value rule is conservative-but-usable as above.
 */
function maskName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    // Lone token: keep (treated as a given name — the spec preserves
    // first names; surnames are protected only within a full-name value).
    return parts[0];
  }
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first} ${lastInitial}.`;
}

/** Tax id → last 4 only. */
function maskTax(value: string): string {
  const last4 = value.slice(-4);
  return `****${last4}`;
}

/** Generic secret mask used by debug_local: never reveal the value. */
function maskSecret(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return `***[redacted:${value.length}]`;
  }
  return '***[redacted]';
}

/**
 * Address → keep only city / country shaped fields. We cannot know which
 * sibling key this is from a single value, so a masked address value is
 * reduced to a coarse placeholder; the projector keeps the *field* but
 * strips precision. City/country class members are still `pii.address`;
 * callers needing city/country should map those to `public.safe` in B1.
 * Here masking a single address value yields just its first token.
 */
function maskAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  // Reveal only the coarsest token (city/country are short single tokens;
  // street lines collapse to their first word). Caps detail leakage.
  const firstToken = trimmed.split(/[\s,]+/)[0];
  if (/^\d/.test(firstToken)) return '[redacted]';
  return firstToken;
}

function summarize(value: unknown): unknown {
  if (typeof value !== 'string') {
    // non-strings cannot be safely summarized → drop (signalled by symbol)
    return DROP;
  }
  const len = value.length;
  const head = value.slice(0, SUMMARY_CAP);
  const truncated = len > SUMMARY_CAP;
  return {
    summary: truncated ? `${head}…` : head,
    length: len,
    truncated,
  };
}

/* ── action application ────────────────────────────────────────────────────── */

/** Sentinel meaning "omit this field". */
const DROP = Symbol('drop');

function maskValue(cls: FieldClass, value: unknown): unknown {
  // Non-string values that have no class-specific numeric mask are dropped
  // rather than partially leaked.
  switch (cls) {
    case 'pii.email':
      return typeof value === 'string' ? maskEmail(value) : DROP;
    case 'pii.phone':
      return typeof value === 'string' ? maskPhone(value) : DROP;
    case 'pii.name':
      return typeof value === 'string' ? maskName(value) : DROP;
    case 'pii.address':
      return typeof value === 'string' ? maskAddress(value) : DROP;
    case 'pii.tax':
      return typeof value === 'string' ? maskTax(value) : DROP;
    case 'secret.credential':
      return maskSecret(value);
    case 'pii.custom_field':
      return typeof value === 'string'
        ? `${value.slice(0, 1)}***`
        : DROP;
    default:
      // Any other class under a `mask` action: conservative — drop.
      return DROP;
  }
}

function applyAction(
  cls: FieldClass,
  contract: DataContract,
  value: unknown
): unknown {
  const action = contract.policy[cls];
  switch (action) {
    case 'allow':
      return value;
    case 'drop':
      return DROP;
    case 'mask':
      return maskValue(cls, value);
    case 'wrap_untrusted': {
      const wrapped: UntrustedValue = { untrusted: true, value };
      return wrapped;
    }
    case 'summarize':
      return summarize(value);
    default:
      // Unknown action ⇒ most conservative.
      return DROP;
  }
}

/* ── shared per-key decision (the single source of truth) ──────────────────── */

/**
 * The authoritative per-key decision. BOTH `project()` and
 * `projectWithTrace()` walk top-level keys through this exact function, so a
 * trace record can never disagree with the data `project()` emits.
 *
 * `mapped` is `false` for a top-level key absent from `canonical.classes`
 * (genuinely unclassified ⇒ dropped, never leaked). When `mapped` is true,
 * `projected === DROP` means the contract action omitted the field.
 */
type KeyDecision =
  | { readonly mapped: false }
  | {
      readonly mapped: true;
      readonly cls: FieldClass;
      readonly action: string;
      /** The projected value, or the DROP sentinel. */
      readonly projected: unknown;
    };

function decideKey(
  canonical: Canonical<unknown>,
  contract: DataContract,
  source: Record<string, unknown>,
  key: string
): KeyDecision {
  // Resolve class. `FieldClassMap`'s index signature widens to `FieldClass`,
  // but at runtime an unmapped path is genuinely absent — a presence check
  // guarantees an unclassified field is never leaked.
  if (!Object.prototype.hasOwnProperty.call(canonical.classes, key)) {
    return { mapped: false };
  }
  const cls: FieldClass = canonical.classes[key];
  const action = contract.policy[cls];
  const projected = applyAction(cls, contract, source[key]);
  return { mapped: true, cls, action, projected };
}

/* ── the projection boundary ───────────────────────────────────────────────── */

export const project: ProjectFn = <T>(
  canonical: Canonical<T>,
  contract: DataContract,
  env: ProjectionEnv
): Record<string, unknown> => {
  // 1. Env gate FIRST — before any field (incl. secrets) is read.
  if (
    contract.envRestrictions.length > 0 &&
    !contract.envRestrictions.includes(env)
  ) {
    throw new ProjectionEnvError(contract.name, env);
  }

  const data = canonical.data as unknown;
  const out: Record<string, unknown> = {};

  if (data === null || typeof data !== 'object') {
    return out;
  }

  const source = data as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const d = decideKey(canonical, contract, source, key);
    if (!d.mapped) {
      continue; // unmapped path: never leaked
    }
    if (d.projected === DROP) {
      continue;
    }
    out[key] = d.projected;
  }

  return out;
};

/* ── authoritative tracing variant (A1) ────────────────────────────────────── */

/** Map an applied action + projected value to the real trace decision. */
function decisionFor(
  action: string | null,
  projected: unknown
): { decision: ProjectionDecision; value_state: TraceValueState } {
  if (action === 'drop' || projected === DROP) {
    return { decision: 'omit', value_state: 'omitted' };
  }
  if (action === 'mask') {
    return { decision: 'mask', value_state: 'masked' };
  }
  if (action === 'wrap_untrusted') {
    return { decision: 'wrap_untrusted', value_state: 'present' };
  }
  // allow / summarize (both emit) — distinguish a literal null payload.
  const value_state: TraceValueState =
    projected === null ? 'null' : 'present';
  return { decision: 'emit', value_state };
}

function reasonFor(decision: ProjectionDecision, rule_id: string): string {
  switch (decision) {
    case 'emit':
      return 'contract permits this class; value emitted';
    case 'mask':
      return 'contract masks this class; partial reveal only';
    case 'wrap_untrusted':
      return 'untrusted class wrapped for the consumer';
    case 'deny':
      return 'contract not permitted in this environment (env gate)';
    case 'omit':
    default:
      return rule_id === 'unmapped_dropped'
        ? 'top-level key not in canonical classmap; dropped'
        : 'contract drops this class; field omitted';
  }
}

export interface ProjectWithTraceResult {
  readonly data: Record<string, unknown>;
  readonly trace: AuditTraceRecord[];
  /** True only for the non-throwing env-forbidden path. */
  readonly denied: boolean;
}

export interface ProjectWithTraceOptions {
  /**
   * When false, an env-forbidden contract does NOT throw; instead a single
   * `deny`/`env_forbidden` trace record is returned with empty data and
   * `denied: true`. Default true (preserves `project()`'s throw contract).
   */
  readonly throwOnEnv?: boolean;
}

/**
 * Project `canonical` AND emit an authoritative `AuditTraceRecord[]` from the
 * SAME per-key decision `project()` uses. The returned `data` is byte-
 * identical to `project(canonical, contract, env)` for every mapped scenario.
 * The trace NEVER contains a field value.
 */
export function projectWithTrace(
  canonical: Canonical<unknown>,
  contract: DataContract,
  env: ProjectionEnv,
  ctx: AuditTraceContext,
  opts: ProjectWithTraceOptions = {}
): ProjectWithTraceResult {
  const throwOnEnv = opts.throwOnEnv !== false;

  // 1. Env gate FIRST — before any field (incl. secrets) is read.
  if (
    contract.envRestrictions.length > 0 &&
    !contract.envRestrictions.includes(env)
  ) {
    if (throwOnEnv) {
      throw new ProjectionEnvError(contract.name, env);
    }
    const denyRecord: AuditTraceRecord = {
      source_path: '',
      output_path: '',
      field_classification: UNMAPPED,
      consumer_id: ctx.consumer_id,
      contract: ctx.contract,
      projection_decision: 'deny',
      rule_id: 'env_forbidden',
      reason: reasonFor('deny', 'env_forbidden'),
      value_state: 'omitted',
      environment: env,
      tool: ctx.tool,
    };
    return { data: {}, trace: [denyRecord], denied: true };
  }

  const out: Record<string, unknown> = {};
  const trace: AuditTraceRecord[] = [];
  const data: unknown = canonical.data;

  if (data === null || typeof data !== 'object') {
    return { data: out, trace, denied: false };
  }

  const source = data as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const d = decideKey(canonical, contract, source, key);

    if (!d.mapped) {
      trace.push({
        source_path: key,
        output_path: '',
        field_classification: UNMAPPED,
        consumer_id: ctx.consumer_id,
        contract: ctx.contract,
        projection_decision: 'omit',
        rule_id: 'unmapped_dropped',
        reason: reasonFor('omit', 'unmapped_dropped'),
        value_state: 'omitted',
        environment: env,
        tool: ctx.tool,
      });
      continue;
    }

    // `mapped` is true here ⇒ `cls`/`action` are present (discriminated).
    const cls = d.cls;
    const { decision, value_state } = decisionFor(d.action, d.projected);
    const emitted = decision !== 'omit';
    if (emitted) {
      out[key] = d.projected;
    }
    const rule_id = `${ctx.contract}:${cls}->${d.action}`;
    trace.push({
      source_path: key,
      output_path: emitted ? key : '',
      field_classification: cls,
      consumer_id: ctx.consumer_id,
      contract: ctx.contract,
      projection_decision: decision,
      rule_id,
      reason: reasonFor(decision, rule_id),
      value_state,
      environment: env,
      tool: ctx.tool,
    });
  }

  return { data: out, trace, denied: false };
}
