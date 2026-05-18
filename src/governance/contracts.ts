/**
 * Phase B / B2 — frozen named data contracts.
 *
 * A `DataContract` is a per-`FieldClass` `ProjectionAction` policy plus
 * environment + auth metadata. These objects are the ONLY place the
 * per-class visibility decision is encoded; `project()` (projection.ts)
 * is the pure function that applies them at the output boundary.
 *
 * Source of truth: docs/PHASE_B_GOVERNANCE.md §4 (FROZEN). Each policy
 * MUST have an entry for every member of FIELD_CLASSES — enforced at
 * compile time by `ContractPolicy = Record<FieldClass, ProjectionAction>`.
 *
 * Hard rules implemented here:
 *  - `secret.credential` is `drop` in every contract except
 *    `debug_local` (`mask`) and `none_local_only` (`allow`, local-only).
 *  - `none_local_only` and `debug_local` carry `envRestrictions: ['local']`
 *    so `project()` hard-rejects them outside local.
 *
 * No edits to existing files; imports only from the frozen seam.
 */

import type {
  ContractName,
  ContractPolicy,
  DataContract,
} from './types.js';

/* ── policy builders ───────────────────────────────────────────────────────── */

/**
 * `llm_safe_summary` — default for unknown / LLM consumers.
 * Drops secrets + internal notes, summarizes untrusted free text so the
 * model treats it as quoted/derived data, masks PII, allows financials.
 */
const LLM_SAFE_SUMMARY: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'mask',
  'pii.email': 'mask',
  'pii.phone': 'mask',
  'pii.address': 'mask',
  'pii.tax': 'mask',
  'pii.custom_field': 'mask',
  'secret.credential': 'drop',
  'untrusted.free_text': 'summarize',
  'internal.private_note': 'drop',
  'system.audit': 'drop',
  'public.safe': 'allow',
  // Track B: business display labels are non-sensitive; status flags safe;
  // raw diagnostic text MUST NOT reach an LLM consumer.
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'drop',
};

/**
 * `ops_operator` — internal human operator UI. Full PII + financials,
 * but untrusted free text is wrapped (never raw instructions to an LLM).
 */
const OPS_OPERATOR: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'drop',
  'untrusted.free_text': 'wrap_untrusted',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
  // Track B: trusted operator sees raw diagnostic text.
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'allow',
};

/**
 * `billing_reconciliation` — reconcile payments. Keeps txn refs + invoice
 * numbers + identifiers + amounts; name/email allowed for matching; the
 * rest of PII masked; untrusted free text dropped entirely.
 */
const BILLING_RECONCILIATION: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'mask',
  'pii.address': 'mask',
  'pii.tax': 'mask',
  'pii.custom_field': 'drop',
  'secret.credential': 'drop',
  'untrusted.free_text': 'drop',
  'internal.private_note': 'drop',
  'system.audit': 'allow',
  'public.safe': 'allow',
  // Track B: labels/status safe; diagnostic text is conservatively
  // summarized (may carry internal detail an automation shouldn't echo raw).
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'summarize',
};

/**
 * `renewal_automation` — renewal workers. Needs the contact email +
 * domain/expiry dates; masks the rest of PII; drops secrets & free text.
 */
const RENEWAL_AUTOMATION: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'mask',
  'pii.email': 'allow',
  'pii.phone': 'mask',
  'pii.address': 'mask',
  'pii.tax': 'mask',
  'pii.custom_field': 'mask',
  'secret.credential': 'drop',
  'untrusted.free_text': 'drop',
  'internal.private_note': 'drop',
  'system.audit': 'allow',
  'public.safe': 'allow',
  // Track B: labels/status safe; diagnostic conservatively summarized.
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'summarize',
};

/**
 * `support_triage` — support tooling for an authorized human. Ticket
 * content is emitted verbatim (the operator needs the exact words);
 * secrets still dropped.
 */
const SUPPORT_TRIAGE: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'drop',
  'untrusted.free_text': 'allow',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
  // Track B: labels/status safe; diagnostic conservatively summarized for
  // an automation-shaped triage consumer (not a raw operator console).
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'summarize',
};

/**
 * `client_portal_self` — the portal, scoped to the caller's own data
 * (ownership enforced upstream in B3). Full own PII; secrets dropped.
 */
const CLIENT_PORTAL_SELF: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'drop',
  'untrusted.free_text': 'allow',
  // a client must not see admin-only internal notes about themselves
  'internal.private_note': 'drop',
  'system.audit': 'drop',
  'public.safe': 'allow',
  // Track B: business display labels + status flags are safe for the
  // client's own portal; raw internal diagnostic text is NOT shown.
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'drop',
};

/**
 * `admin_full_trusted` — admin dashboards for a profile-permitted
 * consumer. Everything except secrets (secrets are never emitted in any
 * non-local contract).
 */
const ADMIN_FULL_TRUSTED: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'drop',
  'untrusted.free_text': 'allow',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
  // Track B: a fully-trusted admin sees raw diagnostic text.
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'allow',
};

/**
 * `debug_local` — local debugging only. Secrets are *masked* (never raw)
 * so logs/screenshots during debugging cannot leak full credentials.
 */
const DEBUG_LOCAL: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'mask',
  'untrusted.free_text': 'allow',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
  // Track B: local debugging sees everything (raw diagnostic included).
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'allow',
};

/**
 * `none_local_only` — raw passthrough, NO projection. Local only; the
 * projector throws `ProjectionEnvError` outside local before any field
 * is touched, so raw secrets can never leave a local box.
 */
const NONE_LOCAL_ONLY: ContractPolicy = {
  'business.identifier': 'allow',
  'financial.amount': 'allow',
  'financial.reference': 'allow',
  'pii.name': 'allow',
  'pii.email': 'allow',
  'pii.phone': 'allow',
  'pii.address': 'allow',
  'pii.tax': 'allow',
  'pii.custom_field': 'allow',
  'secret.credential': 'allow',
  'untrusted.free_text': 'allow',
  'internal.private_note': 'allow',
  'system.audit': 'allow',
  'public.safe': 'allow',
  // Track B: raw passthrough (local only) — everything allowed.
  'business.label': 'allow',
  'system.status': 'allow',
  'system.diagnostic': 'allow',
};

/* ── contract registry ─────────────────────────────────────────────────────── */

export const CONTRACTS: Record<ContractName, DataContract> = {
  llm_safe_summary: {
    name: 'llm_safe_summary',
    policy: LLM_SAFE_SUMMARY,
    envRestrictions: [],
    requiresAuth: false,
  },
  ops_operator: {
    name: 'ops_operator',
    policy: OPS_OPERATOR,
    envRestrictions: [],
    requiresAuth: true,
  },
  billing_reconciliation: {
    name: 'billing_reconciliation',
    policy: BILLING_RECONCILIATION,
    envRestrictions: [],
    requiresAuth: true,
  },
  renewal_automation: {
    name: 'renewal_automation',
    policy: RENEWAL_AUTOMATION,
    envRestrictions: [],
    requiresAuth: true,
  },
  support_triage: {
    name: 'support_triage',
    policy: SUPPORT_TRIAGE,
    envRestrictions: [],
    requiresAuth: true,
  },
  client_portal_self: {
    name: 'client_portal_self',
    policy: CLIENT_PORTAL_SELF,
    envRestrictions: [],
    requiresAuth: true,
  },
  admin_full_trusted: {
    name: 'admin_full_trusted',
    policy: ADMIN_FULL_TRUSTED,
    envRestrictions: [],
    requiresAuth: true,
  },
  debug_local: {
    name: 'debug_local',
    policy: DEBUG_LOCAL,
    envRestrictions: ['local'],
    requiresAuth: true,
  },
  none_local_only: {
    name: 'none_local_only',
    policy: NONE_LOCAL_ONLY,
    envRestrictions: ['local'],
    requiresAuth: true,
  },
};

/** Resolve a frozen contract by its canonical name. */
export function getContract(name: ContractName): DataContract {
  return CONTRACTS[name];
}
