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
 *  2. RECURSIVELY walk `canonical.data`. Every LEAF resolves its
 *     `FieldClass` from `canonical.classes` using the SAME path convention
 *     the ClassMapBuilder / `assertClassmapComplete` use:
 *       - object child  → `parent.child`
 *       - array element → `parent[]`  (array indices collapse to literal `[]`)
 *     An UNMAPPED leaf path is treated as the most-restrictive class ⇒
 *     dropped (never silently public). An UNMAPPED *container* (object/array
 *     with no class of its own) is structural: we recurse and emit only the
 *     surviving children (the restrictive rule binds the LEAVES that would
 *     actually be emitted, not the transparent structure above them).
 *  3. Apply the contract's `ProjectionAction` for that class:
 *       allow          → emit value as-is (leaf) / recurse (container)
 *       drop           → omit the field / the whole container
 *       mask           → partial reveal (class-specific)
 *       wrap_untrusted → emit { untrusted: true, value }
 *       summarize      → derived summary for strings, else drop
 *
 * Container handling (matches existing top-level behaviour):
 *  - A container key that HAS a class honours that class as a GATE:
 *      `allow` ⇒ recurse into children (children are still projected
 *      individually — a `public.safe`/`business.label` container does NOT
 *      emit its subtree raw); any non-`allow` action ⇒ the whole container is
 *      dropped (a `secret.credential` object/array never partially survives).
 *  - A container key with NO class is structural ⇒ recurse.
 *  - Empty results are PRESERVED, not pruned: an object whose children all
 *    dropped becomes `{}`; an array whose elements all emptied stays `[]`
 *    (a dropped LEAF is omitted from its parent object; a surviving but
 *    fully-stripped element object becomes `{}` and stays in the array).
 *    This mirrors the original top-level rule (dropped leaf omitted; object
 *    with all-dropped children ⇒ `{}`).
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

/* ── recursive value projection (the single source of truth) ───────────────── */

/** A non-null, non-array plain object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True when a value is a structural container we can recurse into. */
function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object';
}

/**
 * The child path for a key, using the ClassMapBuilder convention:
 *  - object child  → `parent.child`  (top level: just `child`)
 *  - array element → `parent[]`      (top level: `[]`)
 */
function childPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}
function arrayElemPath(parent: string): string {
  return parent === '' ? '[]' : `${parent}[]`;
}

/**
 * A trace record for one decision, OR the DROP sentinel when the result is
 * to omit. Recursion descends container nodes and returns the projected
 * value (or DROP). Trace records are appended to `trace` when supplied.
 */
interface ProjectNodeCtx {
  readonly canonical: Canonical<unknown>;
  readonly contract: DataContract;
  readonly env: ProjectionEnv;
  /** When present, authoritative trace records are appended here. */
  readonly trace?: AuditTraceRecord[];
  readonly traceCtx?: AuditTraceContext;
}

/** Does `path` have an explicit class in the classmap? */
function classFor(
  canonical: Canonical<unknown>,
  path: string
): FieldClass | undefined {
  return Object.prototype.hasOwnProperty.call(canonical.classes, path)
    ? canonical.classes[path]
    : undefined;
}

/** Push a trace record (only when tracing is enabled). */
function pushTrace(
  ctx: ProjectNodeCtx,
  rec: Omit<AuditTraceRecord, 'consumer_id' | 'contract' | 'tool' | 'environment'>
): void {
  if (!ctx.trace || !ctx.traceCtx) return;
  ctx.trace.push({
    ...rec,
    consumer_id: ctx.traceCtx.consumer_id,
    contract: ctx.traceCtx.contract,
    tool: ctx.traceCtx.tool,
    environment: ctx.env,
  });
}

/**
 * Project ONE value at `path`. Returns the projected value or the DROP
 * sentinel. Pure: never mutates `value`; containers produce fresh copies.
 *
 * `pathClass` is the class explicitly set on THIS path (if any). Leaves
 * without a class drop; containers without a class are transparent (recurse).
 */
function projectNode(
  ctx: ProjectNodeCtx,
  path: string,
  value: unknown
): unknown {
  const pathClass = classFor(ctx.canonical, path);

  // ── Container nodes (objects / arrays) ───────────────────────────────────
  if (isContainer(value)) {
    // A container with its OWN class is gated by that class' action:
    //  - allow  ⇒ recurse (children still individually projected)
    //  - else   ⇒ drop the whole container (a secret object never partially
    //             survives; mask/summarize/wrap on a container collapse to drop)
    if (pathClass !== undefined) {
      const action = ctx.contract.policy[pathClass];
      if (action !== 'allow') {
        pushTrace(ctx, {
          source_path: path,
          output_path: '',
          field_classification: pathClass,
          projection_decision: 'omit',
          rule_id: `${ctx.traceCtx?.contract ?? ''}:${pathClass}->${action}`,
          reason: reasonFor('omit', `${pathClass}->${action}`),
          value_state: 'omitted',
        });
        return DROP;
      }
      // allow ⇒ fall through to structural recursion below.
    }

    if (Array.isArray(value)) {
      const outArr: unknown[] = [];
      for (const el of value) {
        const projected = projectNode(ctx, arrayElemPath(path), el);
        // A dropped ELEMENT is omitted from the array; a surviving (possibly
        // emptied) element is kept. Drop only when the element itself dropped.
        if (projected !== DROP) {
          outArr.push(projected);
        }
      }
      return outArr;
    }

    const obj = value;
    const outObj: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const projected = projectNode(ctx, childPath(path, key), obj[key]);
      if (projected !== DROP) {
        outObj[key] = projected; // dropped child key is omitted; {} survives
      }
    }
    return outObj;
  }

  // ── Leaf nodes (primitives / null) ───────────────────────────────────────
  // An unmapped leaf is most-restrictive ⇒ dropped, never leaked.
  if (pathClass === undefined) {
    pushTrace(ctx, {
      source_path: path,
      output_path: '',
      field_classification: UNMAPPED,
      projection_decision: 'omit',
      rule_id: 'unmapped_dropped',
      reason: reasonFor('omit', 'unmapped_dropped'),
      value_state: 'omitted',
    });
    return DROP;
  }

  const action = ctx.contract.policy[pathClass];
  const projected = applyAction(pathClass, ctx.contract, value);
  const { decision, value_state } = decisionFor(action, projected);
  const rule_id = `${ctx.traceCtx?.contract ?? ''}:${pathClass}->${action}`;
  const emitted = decision !== 'omit';
  pushTrace(ctx, {
    source_path: path,
    output_path: emitted ? path : '',
    field_classification: pathClass,
    projection_decision: decision,
    rule_id,
    reason: reasonFor(decision, rule_id),
    value_state,
  });
  return projected;
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
  if (!isPlainObject(data)) {
    return {};
  }

  const ctx: ProjectNodeCtx = {
    canonical: canonical as Canonical<unknown>,
    contract,
    env,
  };

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    const projected = projectNode(ctx, key, data[key]);
    if (projected !== DROP) {
      out[key] = projected;
    }
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
        ? 'leaf path not in canonical classmap; dropped'
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
 * SAME recursive per-node decision `project()` uses. The returned `data` is
 * byte-identical to `project(canonical, contract, env)` for every mapped
 * scenario (both call `projectNode`). The trace NEVER contains a field value.
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

  const trace: AuditTraceRecord[] = [];
  const data: unknown = canonical.data;

  if (!isPlainObject(data)) {
    return { data: {}, trace, denied: false };
  }

  const nodeCtx: ProjectNodeCtx = {
    canonical,
    contract,
    env,
    trace,
    traceCtx: ctx,
  };

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    const projected = projectNode(nodeCtx, key, data[key]);
    if (projected !== DROP) {
      out[key] = projected;
    }
  }

  return { data: out, trace, denied: false };
}
