/**
 * Phase F — pure write-intent validation.
 *
 * SAFETY: no WHMCS calls. Any read-derived precondition snapshot is supplied
 * by the caller via `ctx`; this module only inspects the in-memory intent.
 * It checks required params per scope, scope/action consistency against the
 * FROZEN SCOPE_ACTION map, presence of risk + idempotency_key, and a sane
 * preconditions shape, then emits WHMCS 8/9 compatibility advisories.
 *
 * Phase G+ — required-param table is now the intent contract (semantic
 * names, NOT WHMCS field names) so the param mapper (src/write/paramMapping.ts)
 * is what bridges to WHMCS shapes at execute time. The mapper is invoked here
 * through a try/catch so any structural mapping problem surfaces at validate
 * stage (severity='error', code 'mapping_error') BEFORE approval, not at
 * execute stage.
 */

import { intentToWhmcsParams, normalizeDomain } from './paramMapping.js';
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

/**
 * Minimum required param keys per write scope. Names are INTENT-CONTRACT
 * (semantic) — the mapper translates to WHMCS field names at execute time.
 */
const REQUIRED_PARAMS: Readonly<Record<WriteScope, readonly string[]>> = {
  'client_note:write': ['clientid', 'note'],
  // ticket:create requires deptid + subject + message AND an identity check
  // (clientid OR (name+email)) modelled as a custom disjunction below.
  'ticket:create': ['deptid', 'subject', 'message'],
  'ticket:reply': ['ticketid', 'message'],
  'ticket:status': ['ticketid', 'status'],
  'billing:invoice:create': ['userid', 'items'],
  // billing:payment:add — gateway/transid are synthesized by the mapper.
  'billing:payment:add': ['invoiceid', 'amount'],
  // billing:credit:add — description is required (no silent placeholders).
  'billing:credit:add': ['clientid', 'amount', 'description'],
  // billing:refund:record — refund_type + paymentmethod required so the mapper
  // can produce the correct WHMCS `AddTransaction` payload (no `amountin`).
  'billing:refund:record': ['invoiceid', 'amount', 'refund_type', 'paymentmethod'],
  'service:price_restore': ['targets'],
  // service:domain_rename — single-call edit of a service's hostname/domain.
  'service:domain_rename': ['serviceid', 'domain'],
  // Track C — service lifecycle + domain nameservers (governed migration).
  'service:suspend': ['serviceid'],
  'service:unsuspend': ['serviceid'],
  'service:terminate': ['serviceid'],
  'domain:nameservers:update': ['domainid', 'nameservers'],
};

/**
 * Permissive hostname/domain validator for `service:domain_rename`. Accepts a
 * dot-separated set of LDH labels (letters/digits/hyphen, no leading/trailing
 * hyphen per label), 1..253 chars total. Rejects spaces, slashes, schemes,
 * and other shell/URL metacharacters so a malformed value can't reach WHMCS.
 */
const DOMAIN_LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const DOMAIN_RE = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`);

/** Allowed values for `ticket:status` `status`. */
const TICKET_STATUS_ENUM: readonly string[] = [
  'Open',
  'Answered',
  'Closed',
  'Customer-Reply',
  'In Progress',
  'On Hold',
];

/** Allowed values for `billing:refund:record` `refund_type`. */
const REFUND_TYPE_ENUM: readonly string[] = ['Credit', 'GatewayRecord'];

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
export function validateIntent(intent: WriteIntent, _ctx: ValidationContext): ValidationResult {
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

  // ticket:create — identity disjunction: clientid OR (name AND email).
  if (intent.scope === 'ticket:create') {
    const hasClientId = present(intent.params.clientid);
    const hasNameAndEmail = present(intent.params.name) && present(intent.params.email);
    if (!hasClientId && !hasNameAndEmail) {
      issues.push({
        code: 'missing_required_param',
        severity: 'error',
        message:
          'ticket:create requires "clientid" OR both "name" and "email" (one identity is required)',
      });
    }
  }

  // ticket:status — status must be a recognized WHMCS ticket status.
  if (intent.scope === 'ticket:status' && present(intent.params.status)) {
    const s = intent.params.status;
    if (typeof s !== 'string' || !TICKET_STATUS_ENUM.includes(s)) {
      issues.push({
        code: 'invalid_status_enum',
        severity: 'error',
        message: `Invalid ticket status "${String(s)}"; allowed: ${TICKET_STATUS_ENUM.join(', ')}`,
      });
    }
  }

  // billing:invoice:create — items must be a non-empty array of {description, amount}.
  if (intent.scope === 'billing:invoice:create' && intent.params.items !== undefined) {
    const items = intent.params.items;
    if (!Array.isArray(items) || items.length === 0) {
      issues.push({
        code: 'invalid_items_shape',
        severity: 'error',
        message: 'billing:invoice:create "items" must be a non-empty array',
      });
    } else {
      items.forEach((raw, i) => {
        if (!isPlainObject(raw)) {
          issues.push({
            code: 'invalid_items_shape',
            severity: 'error',
            message: `items[${i}] must be an object with description+amount`,
          });
          return;
        }
        if (!present(raw.description)) {
          issues.push({
            code: 'invalid_items_shape',
            severity: 'error',
            message: `items[${i}].description is required`,
          });
        }
        if (!present(raw.amount)) {
          issues.push({
            code: 'invalid_items_shape',
            severity: 'error',
            message: `items[${i}].amount is required`,
          });
        }
      });
    }
  }

  // billing:refund:record — refund_type must be Credit or GatewayRecord.
  if (intent.scope === 'billing:refund:record' && present(intent.params.refund_type)) {
    const t = intent.params.refund_type;
    if (typeof t !== 'string' || !REFUND_TYPE_ENUM.includes(t)) {
      issues.push({
        code: 'invalid_refund_type',
        severity: 'error',
        message: `Invalid refund_type "${String(t)}"; allowed: ${REFUND_TYPE_ENUM.join(', ')}`,
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

  // Mapping-error backstop: invoke the mapper and surface any thrown error
  // here so structural problems are caught at validate stage (before approval),
  // not at execute stage.
  //
  // Batch-shaped scopes (e.g. service:price_restore) are SKIPPED — their
  // dispatcher case is intentionally a defensive throw because batch intents
  // don't fit the single-call mapper contract; the write-flow calls the
  // per-target mapper directly. The batch-shape validator above (per-scope
  // custom block) is the structural check for these intents.
  if (intent.scope !== 'service:price_restore') {
    try {
      intentToWhmcsParams(intent.scope, intent.params as Record<string, unknown>, {
        idempotency_key: intent.idempotency_key,
      });
    } catch (e) {
      issues.push({
        code: 'mapping_error',
        severity: 'error',
        message: `Intent → WHMCS mapping failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // WHMCS 9 compatibility advisory for billing scopes (non-blocking).
  if (intent.scope.startsWith('billing:')) {
    compat_warnings.push(WHMCS9_BILLING_ADVISORY);
  }

  // ── Enhanced billing business-logic validators ──────────────────────────

  // billing:invoice:create — line-item amount warnings + taxed advisory.
  if (intent.scope === 'billing:invoice:create' && Array.isArray(intent.params.items)) {
    const items = intent.params.items as Record<string, unknown>[];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (isPlainObject(item)) {
        if (typeof item.amount === 'number' && item.amount < 0) {
          issues.push({
            code: 'negative_item_amount',
            severity: 'warning',
            message: `items[${idx}].amount is negative (${item.amount}); unusual but not always wrong`,
          });
        }
        if (item.taxed === true) {
          compat_warnings.push(
            `items[${idx}].taxed is true; tax behavior may differ between WHMCS 8 and 9`
          );
        }
      }
    }
  }

  // billing:credit:add — amount sign + threshold.
  if (intent.scope === 'billing:credit:add' && present(intent.params.amount)) {
    const amt = intent.params.amount;
    if (typeof amt === 'number') {
      if (amt < 0) {
        issues.push({
          code: 'negative_credit_amount',
          severity: 'error',
          message: 'Credit amount must be positive',
        });
      } else if (amt > 10000) {
        issues.push({
          code: 'large_credit_amount',
          severity: 'warning',
          message: 'Large credit amount detected (>10000); verify this is intentional',
        });
      }
    }
  }

  // billing:refund:record — amount sign + threshold.
  if (intent.scope === 'billing:refund:record' && present(intent.params.amount)) {
    const amt = intent.params.amount;
    if (typeof amt === 'number') {
      if (amt < 0) {
        issues.push({
          code: 'negative_refund_amount',
          severity: 'error',
          message: 'Refund amount must be positive',
        });
      } else if (amt > 50000) {
        issues.push({
          code: 'large_refund_amount',
          severity: 'warning',
          message: 'Very large refund amount detected; verify this is intentional',
        });
      }
    }
  }

  // billing:payment:add — amount must be positive.
  if (intent.scope === 'billing:payment:add' && present(intent.params.amount)) {
    const amt = intent.params.amount;
    if (typeof amt === 'number' && amt <= 0) {
      issues.push({
        code: 'non_positive_payment_amount',
        severity: 'error',
        message: 'Payment amount must be positive',
      });
    }
  }

  // service:price_restore — batch-shape: targets is a non-empty array of
  // { serviceid:int>0, new_amount:number>0, expected_old_amount?:number>0 };
  // optional intent-level dry_run:boolean.
  if (intent.scope === 'service:price_restore') {
    const targets = intent.params.targets;
    if (!Array.isArray(targets) || targets.length === 0) {
      issues.push({
        code: 'invalid_targets_shape',
        severity: 'error',
        message: 'service:price_restore requires a non-empty `targets` array',
      });
    } else {
      targets.forEach((t, i) => {
        if (!isPlainObject(t)) {
          issues.push({
            code: 'invalid_target_entry',
            severity: 'error',
            message: `targets[${String(i)}] must be an object`,
          });
          return;
        }
        const sid = t.serviceid;
        const na = t.new_amount;
        const eoa = t.expected_old_amount;
        if (typeof sid !== 'number' || !Number.isInteger(sid) || sid <= 0) {
          issues.push({
            code: 'invalid_target_entry',
            severity: 'error',
            message: `targets[${String(i)}].serviceid must be a positive integer`,
          });
        }
        if (typeof na !== 'number' || !Number.isFinite(na) || na <= 0) {
          issues.push({
            code: 'invalid_target_entry',
            severity: 'error',
            message: `targets[${String(i)}].new_amount must be a positive number`,
          });
        }
        if (eoa !== undefined) {
          if (typeof eoa !== 'number' || !Number.isFinite(eoa) || eoa <= 0) {
            issues.push({
              code: 'invalid_target_entry',
              severity: 'error',
              message: `targets[${String(i)}].expected_old_amount must be a positive number when provided`,
            });
          }
        }
      });
    }
    if (intent.params.dry_run !== undefined && typeof intent.params.dry_run !== 'boolean') {
      issues.push({
        code: 'invalid_dry_run',
        severity: 'error',
        message: 'service:price_restore `dry_run` must be a boolean when provided',
      });
    }
  }

  // service:domain_rename — serviceid positive int; domain a valid
  // hostname/domain string. The mapper already restricts output to exactly
  // {serviceid, domain}; these checks reject malformed values before approval.
  if (intent.scope === 'service:domain_rename') {
    const sid = intent.params.serviceid;
    if (typeof sid !== 'number' || !Number.isInteger(sid) || sid <= 0) {
      issues.push({
        code: 'invalid_serviceid',
        severity: 'error',
        message: 'service:domain_rename `serviceid` must be a positive integer',
      });
    }
    const domain = intent.params.domain;
    if (typeof domain !== 'string') {
      // present() above already errors on missing; only add a type error if a
      // non-string value slipped through (e.g. number/object).
      if (present(domain)) {
        issues.push({
          code: 'invalid_domain',
          severity: 'error',
          message: 'service:domain_rename `domain` must be a string',
        });
      }
    } else {
      // Validate the NORMALIZED form — the exact string the mapper will send to
      // WHMCS (normalizeDomain trims, lowercases, strips a trailing root dot).
      // This keeps validate and execute in agreement; a leading-space or
      // trailing-dot value can never pass validation yet reach WHMCS un-cleaned.
      const d = normalizeDomain(domain);
      if (d.length === 0 || d.length > 253 || !DOMAIN_RE.test(d)) {
        issues.push({
          code: 'invalid_domain',
          severity: 'error',
          message: `Invalid domain/hostname "${domain}"; expected a dot-separated set of LDH labels (no spaces, scheme, or path)`,
        });
      }
    }
    // Optional precondition: expected_old_domain (the current domain the caller
    // believes is set). When present it must be a valid domain; the execute
    // path read-checks it against the live service before renaming.
    const expectedOld = intent.params.expected_old_domain;
    if (expectedOld !== undefined && present(expectedOld)) {
      if (typeof expectedOld !== 'string') {
        issues.push({
          code: 'invalid_expected_old_domain',
          severity: 'error',
          message: 'service:domain_rename `expected_old_domain` must be a string when provided',
        });
      } else {
        const eod = normalizeDomain(expectedOld);
        if (eod.length === 0 || eod.length > 253 || !DOMAIN_RE.test(eod)) {
          issues.push({
            code: 'invalid_expected_old_domain',
            severity: 'error',
            message: `Invalid expected_old_domain "${expectedOld}"`,
          });
        }
      }
    }
  }

  // Track C — service lifecycle: serviceid must be a positive integer.
  if (
    intent.scope === 'service:suspend' ||
    intent.scope === 'service:unsuspend' ||
    intent.scope === 'service:terminate'
  ) {
    const sid = intent.params.serviceid;
    if (typeof sid !== 'number' || !Number.isInteger(sid) || sid <= 0) {
      issues.push({
        code: 'invalid_serviceid',
        severity: 'error',
        message: `${intent.scope} \`serviceid\` must be a positive integer`,
      });
    }
  }

  // Track C — domain:nameservers:update: domainid positive int; nameservers a
  // 2..5 array of valid hostnames (DomainUpdateNameservers needs ≥2 NS).
  if (intent.scope === 'domain:nameservers:update') {
    const did = intent.params.domainid;
    if (typeof did !== 'number' || !Number.isInteger(did) || did <= 0) {
      issues.push({
        code: 'invalid_domainid',
        severity: 'error',
        message: 'domain:nameservers:update `domainid` must be a positive integer',
      });
    }
    const ns = intent.params.nameservers;
    if (!Array.isArray(ns) || ns.length < 2 || ns.length > 5) {
      issues.push({
        code: 'invalid_nameservers',
        severity: 'error',
        message: 'domain:nameservers:update `nameservers` must be an array of 2–5 hostnames',
      });
    } else {
      ns.forEach((n, i) => {
        const h = typeof n === 'string' ? n.trim().toLowerCase() : '';
        if (h.length === 0 || h.length > 253 || !DOMAIN_RE.test(h)) {
          issues.push({
            code: 'invalid_nameservers',
            severity: 'error',
            message: `nameservers[${String(i)}] is not a valid hostname`,
          });
        }
      });
    }
  }

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues, compat_warnings };
}
