/**
 * Phase B — B4 capability registry + read-only probe.
 *
 * Per WHMCS action the server keeps a declared capability status. Tools and
 * aggregators consult `getCapability` BEFORE calling WHMCS; `unverified`
 * entries may be promoted by a single small read-only `probeCapability` call
 * whose result is cached as target-scoped, expiring evidence. Probes respect
 * the existing read allowlist (`assertReadAction` / the injected
 * `isAllowlisted`): an action that
 * is not allowlisted is reported `unsupported` and NEVER called. We never fake
 * data and never broadly expand the read allowlist here — see
 * docs/design/governance.md §6.
 *
 * The declaration list is server-owned catalog metadata; evidence storage is
 * isolated in `capabilityEvidence.ts`.
 */

import type { CapabilityStatus, CapabilityStatusValue, CapabilityUnavailable } from './types.js';
import { DECLARED_WHMCS_CAPABILITIES } from '../catalog/declaredCapabilities.js';
import {
  __resetCapabilityEvidenceForTests,
  DEFAULT_CAPABILITY_EVIDENCE_TARGET,
  getCapabilityEvidence,
  recordCapabilityEvidence,
  resolveCapabilityEvidence,
  type CapabilityEvidenceTarget,
  type CapabilityFailureClass,
} from './capabilityEvidence.js';

const DECLARED_CAPABILITY_BY_ACTION = new Map(
  DECLARED_WHMCS_CAPABILITIES.map((declaration) => [declaration.action, declaration] as const)
);

/* ───────────────────────────  Static registry  ──────────────────────────── */

function buildRegistry(): Record<string, CapabilityStatus> {
  const registry: Record<string, CapabilityStatus> = {};
  for (const declaration of DECLARED_WHMCS_CAPABILITIES) {
    if (!declaration.exposeInLegacyMatrix) continue;
    registry[declaration.action] = {
      action: declaration.action,
      status: declaration.status,
      capability: declaration.capability,
      note:
        declaration.status === 'supported'
          ? 'Allowlisted read action, supported by this server build.'
          : 'Allowlisted but not yet prod-probed; run a capability probe to promote to supported.',
    };
  }
  return registry;
}

/** Static, declared capability per WHMCS action the server cares about. */
export const CAPABILITY_REGISTRY: Record<string, CapabilityStatus> = buildRegistry();

/** Test-only hook to clear target-scoped capability evidence. */
export function __resetCapabilityCacheForTests(): void {
  __resetCapabilityEvidenceForTests();
}

/* ─────────────────────────────  Lookups  ─────────────────────────────────── */

/**
 * Derive a stable snake_case capability id for an action that is not in the
 * static registry, so structured "unavailable" payloads still carry a name.
 */
function synthesizeCapabilityId(action: string): string {
  const snake = action
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  return snake.length > 0 ? snake : 'unknown_action';
}

/**
 * Return the current capability status for an action. Unexpired evidence for
 * the selected target wins over the static seed. An unknown action is
 * synthesized as `unsupported` (the most conservative status) — it is never
 * silently treated as supported.
 */
export function getCapability(
  action: string,
  target: CapabilityEvidenceTarget = DEFAULT_CAPABILITY_EVIDENCE_TARGET,
  nowMs = Date.now(),
  probeParams?: Readonly<Record<string, unknown>>
): CapabilityStatus {
  const evidence =
    probeParams === undefined
      ? resolveCapabilityEvidence(target, action, nowMs)
      : getCapabilityEvidence(target, action, nowMs, probeParams);
  if (evidence !== undefined) {
    return {
      action,
      status: evidence.status,
      capability: Object.hasOwn(CAPABILITY_REGISTRY, action)
        ? CAPABILITY_REGISTRY[action].capability
        : synthesizeCapabilityId(action),
      verifiedAt: evidence.observedAt,
      note: evidence.note,
    };
  }
  if (Object.hasOwn(CAPABILITY_REGISTRY, action)) {
    return CAPABILITY_REGISTRY[action];
  }
  return {
    action,
    status: 'unsupported',
    capability: synthesizeCapabilityId(action),
    note: 'Action is not in the capability registry.',
  };
}

/* ─────────────────────────────  Probe  ───────────────────────────────────── */

/** Dependencies injected into the probe so it never owns transport/policy. */
export interface ProbeDeps {
  /** Read-only WHMCS boundary (WhmcsClient.read). */
  read: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** True iff the action is in the existing read allowlist (assertReadAction). */
  isAllowlisted: (action: string) => boolean;
  /** Opaque installation + configuration fingerprints used to isolate evidence. */
  target?: CapabilityEvidenceTarget;
  /** Evidence lifetime. Defaults to five minutes. */
  evidenceTtlMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

const DEFAULT_EVIDENCE_TTL_MS = 5 * 60_000;

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
  return String(error);
}

function readResultIsError(value: unknown): { isError: boolean; message: string } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    (value as { result: unknown }).result === 'error'
  ) {
    const msg =
      'message' in value && typeof (value as { message: unknown }).message === 'string'
        ? (value as { message: string }).message
        : '';
    return { isError: true, message: msg };
  }
  return { isError: false, message: '' };
}

function classifyFailure(message: string): {
  status: CapabilityStatusValue;
  failureClass: CapabilityFailureClass;
  note: string;
} {
  const lower = message.toLowerCase();
  if (ACCESS_DENIED_PATTERNS.some((p) => lower.includes(p))) {
    return {
      status: 'not_authorized',
      failureClass: 'access_denied',
      note: 'WHMCS denied access for the configured API credentials.',
    };
  }
  if (UNKNOWN_ACTION_PATTERNS.some((p) => lower.includes(p))) {
    return {
      status: 'unsupported',
      failureClass: 'unsupported_action',
      note: 'WHMCS reports this action does not exist on the install.',
    };
  }
  return {
    status: 'degraded',
    failureClass: 'transport_or_other',
    note: 'Probe could not be completed (transport/other error).',
  };
}

/**
 * Issue at most ONE minimal read-only probe to resolve an `unverified`
 * capability, caching the result in-process.
 *
 * - Not allowlisted ⇒ `unsupported`, and `read` is NOT called.
 * - Success ⇒ `supported` with `verifiedAt`.
 * - `result:'error'` (or thrown) with access-denied/permission text ⇒
 *   `not_authorized`.
 * - `result:'error'` (or thrown) with unknown-action text ⇒ `unsupported`.
 * - transport / any other error ⇒ `degraded`.
 *
 * The first resolved status is cached for the target + configuration + catalog
 * version + safe probe shape until expiry; matching calls do not re-probe.
 */
export async function probeCapability(
  action: string,
  deps: ProbeDeps,
  params?: Record<string, unknown>
): Promise<CapabilityStatus> {
  const target = deps.target ?? DEFAULT_CAPABILITY_EVIDENCE_TARGET;
  const nowMs = deps.now?.() ?? Date.now();
  const ttlMs = deps.evidenceTtlMs ?? DEFAULT_EVIDENCE_TTL_MS;
  const probeParams: Record<string, unknown> = { ...params, limitnum: 1 };
  const cached = getCapabilityEvidence(target, action, nowMs, probeParams);
  if (cached !== undefined) {
    return {
      action,
      status: cached.status,
      capability: Object.hasOwn(CAPABILITY_REGISTRY, action)
        ? CAPABILITY_REGISTRY[action].capability
        : synthesizeCapabilityId(action),
      verifiedAt: cached.observedAt,
      note: cached.note,
    };
  }

  const base = getCapability(action, target, nowMs);
  const capability = base.capability;

  // A caller-provided allowlist cannot make an unknown or external-only action
  // probeable. Operator evidence is recorded through recordCapabilityEvidence.
  const declaration = DECLARED_CAPABILITY_BY_ACTION.get(action);
  if (declaration?.probe !== 'read_safe') return base;

  // Allowlist is the hard gate — never call read() for a non-allowlisted
  // action; report unsupported without expanding the allowlist.
  if (!deps.isAllowlisted(action)) {
    const evidence = recordCapabilityEvidence({
      target,
      action,
      probeParams,
      status: 'unsupported',
      source: 'policy',
      observedAtMs: nowMs,
      ttlMs,
      failureClass: 'policy_denied',
      note: 'Action is not in the read allowlist; not probed.',
    });
    return {
      action,
      status: evidence.status,
      capability,
      verifiedAt: evidence.observedAt,
      note: evidence.note,
    };
  }

  let status: CapabilityStatusValue;
  let failureClass: CapabilityFailureClass = 'none';
  let note = 'Probe succeeded against the live WHMCS install.';
  try {
    const response = await deps.read(action, probeParams);
    const result = readResultIsError(response);
    if (result.isError) {
      const classified = classifyFailure(result.message);
      status = classified.status;
      failureClass = classified.failureClass;
      note = classified.note;
    } else {
      status = 'supported';
    }
  } catch (error) {
    const classified = classifyFailure(extractErrorMessage(error));
    status = classified.status;
    failureClass = classified.failureClass;
    note = classified.note;
  }

  const evidence = recordCapabilityEvidence({
    target,
    action,
    probeParams,
    status,
    source: 'read_probe',
    observedAtMs: nowMs,
    ttlMs,
    failureClass,
    note,
  });
  return {
    action,
    status: evidence.status,
    capability,
    verifiedAt: evidence.observedAt,
    note: evidence.note,
  };
}

/* ─────────────────────────────  Unavailable payload  ────────────────────── */

/**
 * `retriable` is true only for statuses where a fresh operator probe could
 * plausibly change the outcome. `unsupported`/`not_authorized` are terminal
 * for this build; `supported`/`fallback_available` are not "unavailable" but
 * are kept representable (false — nothing to retry).
 */
const RETRIABLE_STATUSES: ReadonlySet<CapabilityStatusValue> = new Set<CapabilityStatusValue>([
  'unverified',
  'degraded',
]);

/**
 * Short, STABLE next-step hints per status. Stable strings let an app branch
 * or display without parsing free-form notes. These describe the operator's
 * next step only — they never imply fabricated data.
 */
const GUIDANCE_BY_STATUS: Readonly<Record<CapabilityStatusValue, string>> = {
  supported: 'Capability is supported; this payload should not normally be emitted.',
  unsupported: 'Action is not supported on this WHMCS install or build; do not retry.',
  not_authorized:
    'The configured WHMCS API credentials lack permission for this action; an operator must adjust API role permissions.',
  unverified:
    'Action not yet verified on this WHMCS install; an operator must run a read-only probe.',
  degraded:
    'A previous probe failed for a transport/other reason; an operator may retry the read-only probe.',
  fallback_available: 'A safe fallback is available for this capability (reserved status).',
};

/**
 * Structured payload a tool returns when a capability is not usable. This is
 * the ONLY thing a governed tool emits for an unsupported / not_authorized /
 * unverified / degraded capability — never fabricated data.
 *
 * The first four fields are unchanged (frozen seam). `capability`, `retriable`
 * and `guidance` are additive, making the response app-handleable without any
 * change to safety behavior.
 */
export function capabilityUnavailablePayload(c: CapabilityStatus): CapabilityUnavailable {
  const payload: {
    capability_unavailable: true;
    action: string;
    status: CapabilityStatusValue;
    note?: string;
    capability?: string;
    retriable?: boolean;
    guidance?: string;
  } = {
    capability_unavailable: true,
    action: c.action,
    status: c.status,
    capability: c.capability,
    retriable: RETRIABLE_STATUSES.has(c.status),
    guidance: GUIDANCE_BY_STATUS[c.status],
  };
  if (c.note !== undefined) {
    payload.note = c.note;
  }
  return payload;
}
