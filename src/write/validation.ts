/**
 * Phase F — pure write-intent validation.
 *
 * SAFETY: no WHMCS calls. Any read-derived precondition snapshot is supplied
 * by the caller via `ctx`; this module only inspects the in-memory intent.
 * It checks required params per scope, scope/action consistency against the
 * FROZEN SCOPE_ACTION map, presence of risk + idempotency_key, and a sane
 * preconditions shape, then emits WHMCS 8/9 compatibility advisories.
 */

import {
  SCOPE_ACTION,
  WRITE_RISK,
  type ValidationIssue,
  type ValidationResult,
  type WriteIntent,
  type WriteScope,
} from './types.js';

/** Already-read snapshots / flags the caller may pass; never fetched here. */
export interface ValidationContext {
  readonly preconditionSnapshots?: Readonly<Record<string, unknown>>;
}

/** Minimum required param keys per write scope. */
const REQUIRED_PARAMS: Readonly<Record<WriteScope, readonly string[]>> = {
  'client_note:write': ['clientid', 'note'],
  'ticket:create': ['subject', 'message'],
  'ticket:reply': ['ticketid', 'message'],
  'ticket:status': ['ticketid', 'status'],
  'billing:invoice:create': ['userid', 'items'],
  'billing:payment:add': ['invoiceid', 'amount'],
  'billing:credit:add': ['clientid', 'amount'],
  'billing:refund:record': ['invoiceid', 'amount'],
};

const WHMCS9_BILLING_ADVISORY =
  'WHMCS 9: non-draft invoices immutable; corrections via credit/debit notes';

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a draft intent. `ok=false` if any issue has severity='error'.
 * compat_warnings are non-blocking advisories.
 */
export function validateIntent(
  intent: WriteIntent,
  _ctx: ValidationContext,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const compat_warnings: string[] = [];

  // Required params per scope.
  const required = REQUIRED_PARAMS[intent.scope];
  for (const key of required) {
    if (!present(intent.params[key])) {
      issues.push({
        code: 'missing_required_param',
        severity: 'error',
        message: `Missing required param "${key}" for scope ${intent.scope}`,
      });
    }
  }

  // Scope/action consistency against the frozen map.
  if (intent.action !== SCOPE_ACTION[intent.scope]) {
    issues.push({
      code: 'scope_action_mismatch',
      severity: 'error',
      message: `Action "${intent.action}" inconsistent with scope ${intent.scope} (expected "${SCOPE_ACTION[intent.scope]}")`,
    });
  }

  // Risk present + valid.
  if (!(WRITE_RISK as readonly string[]).includes(intent.risk)) {
    issues.push({
      code: 'missing_risk',
      severity: 'error',
      message: `Risk tier missing or invalid: "${intent.risk}"`,
    });
  }

  // Idempotency key present.
  if (!present(intent.idempotency_key)) {
    issues.push({
      code: 'missing_idempotency_key',
      severity: 'error',
      message: 'idempotency_key is required',
    });
  }

  // Preconditions shape sane.
  if (!isPlainObject(intent.preconditions)) {
    issues.push({
      code: 'bad_preconditions',
      severity: 'error',
      message: 'preconditions must be a plain object',
    });
  }

  // WHMCS 9 compatibility advisory for billing scopes (non-blocking).
  if (intent.scope.startsWith('billing:')) {
    compat_warnings.push(WHMCS9_BILLING_ADVISORY);
  }

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues, compat_warnings };
}
