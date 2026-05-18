/**
 * Phase B governance — FROZEN CORE SEAM.
 *
 * Tier-1 modules (canonical mappers B1, contracts/projection B2, consumer
 * registry B3, capability registry B4) are built in parallel against THIS
 * file only. Do not add runtime logic here; types + frozen constants only.
 * See docs/PHASE_B_GOVERNANCE.md.
 */

/* ─────────────────────────  Field classification (B1)  ───────────────────── */

export const FIELD_CLASSES = [
  'business.identifier',
  'financial.amount',
  'financial.reference',
  'pii.name',
  'pii.email',
  'pii.phone',
  'pii.address',
  'pii.tax',
  'pii.custom_field',
  'secret.credential',
  'untrusted.free_text',
  'internal.private_note',
  'system.audit',
  'public.safe',
  // PHASE H.1 / Track B — taxonomy expansion. These let the auditor and
  // contracts distinguish non-sensitive business DISPLAY labels and
  // operational status/diagnostic signals from PII/financial data, so the
  // exposure audit stops mis-flagging product/department labels as PII and
  // status flags as UNKNOWN. Compile-enforced: every ContractPolicy MUST
  // add an action for each (see contracts.ts).
  'business.label',
  'system.status',
  'system.diagnostic',
] as const;

export type FieldClass = (typeof FIELD_CLASSES)[number];

/**
 * Maps a canonical field path to its classification. Paths use dot notation;
 * array elements use `[]` (e.g. `replies[].message`). A path absent from the
 * map is treated as RESTRICTED by the projector (never silently public.safe).
 */
export type FieldClassMap = Readonly<Record<string, FieldClass>>;

/** A canonical entity packaged with its classification map. Data is COMPLETE. */
export interface Canonical<T> {
  readonly entity: CanonicalEntity;
  readonly data: T;
  readonly classes: FieldClassMap;
}

export type CanonicalEntity =
  | 'client'
  | 'invoice'
  | 'transaction'
  | 'service'
  | 'domain'
  | 'ticket'
  | 'order'
  | 'activity';

/* ─────────────────────────  Data contracts (B2)  ─────────────────────────── */

export const CONTRACT_NAMES = [
  'llm_safe_summary',
  'ops_operator',
  'billing_reconciliation',
  'renewal_automation',
  'support_triage',
  'client_portal_self',
  'admin_full_trusted',
  'debug_local',
  'none_local_only',
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

export const PROJECTION_ACTIONS = [
  'allow',
  'mask',
  'drop',
  'wrap_untrusted',
  'summarize',
] as const;

export type ProjectionAction = (typeof PROJECTION_ACTIONS)[number];

export type ProjectionEnv = 'local' | 'staging' | 'production';

/** Per-class policy. Every FieldClass must have an entry. */
export type ContractPolicy = Readonly<Record<FieldClass, ProjectionAction>>;

export interface DataContract {
  readonly name: ContractName;
  readonly policy: ContractPolicy;
  /** Contract is only valid in these environments. Empty ⇒ all. */
  readonly envRestrictions: readonly ProjectionEnv[];
  /** Requires an authenticated (non-anonymous) consumer. */
  readonly requiresAuth: boolean;
}

/** A field marked untrusted for LLM consumers. */
export interface UntrustedValue {
  readonly untrusted: true;
  readonly value: unknown;
}

/**
 * The projection boundary. PURE. Applied exactly once at tool output.
 * Throws ProjectionEnvError if the contract is not permitted in `env`.
 */
export type ProjectFn = <T>(
  canonical: Canonical<T>,
  contract: DataContract,
  env: ProjectionEnv
) => Record<string, unknown>;

export class ProjectionEnvError extends Error {
  constructor(contract: ContractName, env: ProjectionEnv) {
    super(`Contract '${contract}' is not permitted in environment '${env}'`);
    this.name = 'ProjectionEnvError';
  }
}

/* ─────────────────────────  Consumer registry (B3)  ──────────────────────── */

export const WRITE_CAPABILITIES = [
  'false',
  'draft_only',
  'approval_required',
  'disabled',
  // Phase F (additive): a consumer explicitly cleared for gated execution.
  // Still inert unless runtime execution authorization is also present —
  // never grants live production mutation by itself.
  'execution_allowed',
] as const;

export type WriteCapability = (typeof WRITE_CAPABILITIES)[number];

export interface ConsumerProfile {
  readonly id: string;
  readonly allowedScopes: readonly string[];
  readonly defaultContract: ContractName;
  readonly allowedContracts: readonly ContractName[];
  /** Capability/action names this consumer may invoke. */
  readonly allowedActions: readonly string[];
  /** Modeled but inert this engagement — production writes stay disabled. */
  readonly writeCapability: WriteCapability;
  /** Empty ⇒ all environments. */
  readonly envRestrictions: readonly ProjectionEnv[];
  /** True for the deliberate anonymous fallback profile. */
  readonly anonymous: boolean;
}

export type ConsumerResolution =
  | { readonly ok: true; readonly profile: ConsumerProfile }
  | { readonly ok: false; readonly reason: ConsumerDenyReason };

export type ConsumerDenyReason =
  | 'no_token'
  | 'unknown_token'
  | 'env_forbidden'
  | 'anonymous_disabled';

/* ─────────────────────────  Capability registry (B4)  ────────────────────── */

/**
 * All representable capability statuses. Note: `fallback_available` is
 * RESERVED — this read-only gateway never fabricates a fallback, so no code
 * path currently *produces* it, but it remains a valid, representable status
 * for forward compatibility and must not be removed.
 */
export const CAPABILITY_STATUSES = [
  'supported',
  'unsupported',
  'not_authorized',
  'unverified',
  'degraded',
  'fallback_available',
] as const;

export type CapabilityStatusValue = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilityStatus {
  /** WHMCS action name, e.g. 'GetTransactions'. */
  readonly action: string;
  readonly status: CapabilityStatusValue;
  /** ISO timestamp of last probe, if probed. */
  readonly verifiedAt?: string;
  readonly note?: string;
  /** Capability name a consumer references in allowedActions. */
  readonly capability: string;
}

/**
 * Structured payload returned when a capability is not usable.
 *
 * The first four fields are a FROZEN seam — consumers depend on their exact
 * shape; never remove or rename them. The trailing fields are ADDITIVE and
 * optional: they make the response more app-handleable (a client can branch on
 * the snake_case `capability`, decide whether to retry from `retriable`, and
 * surface `guidance` to an operator) WITHOUT changing any safety behavior.
 */
export interface CapabilityUnavailable {
  readonly capability_unavailable: true;
  readonly action: string;
  readonly status: CapabilityStatusValue;
  readonly note?: string;
  /** Snake_case capability id (CapabilityStatus.capability). */
  readonly capability?: string;
  /**
   * Whether re-attempting (e.g. an operator probe) could plausibly change the
   * outcome. True for `unverified`/`degraded`; false for
   * `unsupported`/`not_authorized`.
   */
  readonly retriable?: boolean;
  /** Short, stable, human-facing next-step hint. Never fabricated data. */
  readonly guidance?: string;
}
