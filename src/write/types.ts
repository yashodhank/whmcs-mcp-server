/**
 * Phase F — Controlled Write Automation: FROZEN CORE SEAM.
 *
 * Types + frozen constants only (no runtime logic here). Layers (intent
 * store, validation, idempotency, audit, support/billing draft tools,
 * execution gate) are built against THIS file.
 *
 * SAFETY INVARIANT: production execution is governed by a DENY-BY-DEFAULT
 * risk-tiered policy table (see executionGate.ts), NOT an absolute env block.
 * The keystone property holds: with no new env configured (kill switch off,
 * empty prod allowlist, zero caps) the gate's behaviour is byte-identical to
 * the legacy absolute-deny — production is fully sealed, zero live mutation.
 * The read-only WhmcsClient.mutate() MODE_RESTRICTED block remains an
 * independent backstop. Live production mutation requires explicit per-action
 * allowlisting (+ human approval & caps for high-risk) that is intentionally
 * absent in the default posture.
 */

import type { ContractName } from '../governance/types.js';

/* ───────────────────────────  Write scopes  ─────────────────────────────── */

export const WRITE_SCOPES = [
  'client_note:write',
  'ticket:create',
  'ticket:reply',
  'ticket:status',
  'billing:invoice:create',
  'billing:payment:add',
  'billing:credit:add',
  'billing:refund:record',
  'service:price_restore',
  'service:domain_rename',
  // Track C — service lifecycle + domain ops migrated off the legacy
  // direct-mutate tools into the governed tiered model.
  'service:suspend',
  'service:unsuspend',
  'service:terminate',
  'domain:nameservers:update',
] as const;

export type WriteScope = (typeof WRITE_SCOPES)[number];

/** Maps a write scope to the WHMCS action it would (eventually) call. */
export const SCOPE_ACTION: Readonly<Record<WriteScope, string>> = {
  'client_note:write': 'AddClientNote',
  'ticket:create': 'OpenTicket',
  'ticket:reply': 'AddTicketReply',
  'ticket:status': 'UpdateTicket',
  'billing:invoice:create': 'CreateInvoice',
  'billing:payment:add': 'AddInvoicePayment',
  'billing:credit:add': 'AddCredit',
  'billing:refund:record': 'AddTransaction',
  'service:price_restore': 'UpdateClientProduct',
  'service:domain_rename': 'UpdateClientProduct',
  'service:suspend': 'ModuleSuspend',
  'service:unsuspend': 'ModuleUnsuspend',
  'service:terminate': 'ModuleTerminate',
  'domain:nameservers:update': 'DomainUpdateNameservers',
} as const;

export const WRITE_RISK = ['low', 'medium', 'high'] as const;
export type WriteRisk = (typeof WRITE_RISK)[number];

/** Risk tier per scope — drives required approvals + rollout ordering. */
export const SCOPE_RISK: Readonly<Record<WriteScope, WriteRisk>> = {
  'client_note:write': 'low',
  'ticket:create': 'low',
  'ticket:reply': 'low',
  'ticket:status': 'medium',
  'billing:invoice:create': 'medium',
  'billing:payment:add': 'high',
  'billing:credit:add': 'high',
  'billing:refund:record': 'high',
  'service:price_restore': 'high',
  // Non-monetary, reversible metadata edit (hostname/domain field). Not low:
  // changing a live service's hostname can affect provisioning/module commands
  // that key off it. Medium ⇒ single approval, no money caps / human-approval
  // record required (those are high-risk only).
  'service:domain_rename': 'medium',
  // Suspend/unsuspend are reversible service-state changes → medium.
  'service:suspend': 'medium',
  'service:unsuspend': 'medium',
  // Terminate is destructive/irreversible → high. ALSO scope-blocked in prod
  // (PROD_NEVER_EXECUTABLE_SCOPES) and action-blocked (ModuleTerminate ∈
  // PROD_NEVER_EXECUTABLE): can be drafted/validated but never executes in prod.
  'service:terminate': 'high',
  // Nameserver change is reversible config → medium.
  'domain:nameservers:update': 'medium',
} as const;

/* ───────────────────────────  Write intent  ─────────────────────────────── */

export const WRITE_INTENT_STATES = [
  'draft',
  'validated',
  'rejected',
  'approved',
  'execution_blocked',
  'executed',
  'verified',
  'failed',
] as const;

export type WriteIntentState = (typeof WRITE_INTENT_STATES)[number];

/** A pure, non-executing description of a proposed mutation. */
export interface WriteIntent {
  readonly intent_id: string;
  readonly consumer_id: string;
  readonly scope: WriteScope;
  /** WHMCS action this intent WOULD call (never auto-called). */
  readonly action: string;
  readonly risk: WriteRisk;
  /** Validated, projection-safe params (no secrets echoed). */
  readonly params: Readonly<Record<string, unknown>>;
  readonly idempotency_key: string;
  /** Read-derived expectations re-checked at validate/execute. */
  readonly preconditions: Readonly<Record<string, unknown>>;
  /** Human + structured summary of the intended effect. */
  readonly projected_effect: string;
  readonly state: WriteIntentState;
  readonly created_at: string;
  readonly expires_at: string;
  readonly contract?: ContractName;
}

/* ───────────────────────────  Validation  ───────────────────────────────── */

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  readonly code: string;
  readonly severity: ValidationSeverity;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  /** WHMCS 8/9 compatibility advisories (non-blocking warnings). */
  readonly compat_warnings: readonly string[];
}

/* ───────────────────────────  Approval  ─────────────────────────────────── */

export interface ApprovalRecord {
  readonly intent_id: string;
  readonly approved_by: string;
  readonly consumer_id: string;
  readonly decision: 'approved' | 'rejected';
  readonly at: string;
  readonly reason?: string;
}

/* ───────────────────────────  Audit  ────────────────────────────────────── */

export const AUDIT_EVENT_TYPES = [
  'intent.drafted',
  'intent.validated',
  'intent.rejected',
  'intent.approved',
  'intent.execution_blocked',
  'intent.executed',
  'intent.verified',
  'intent.failed',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** Append-only. Records consumer_id, never tokens; params redacted upstream. */
export interface AuditEvent {
  readonly event: AuditEventType;
  readonly intent_id: string;
  readonly consumer_id: string;
  readonly scope: WriteScope;
  readonly action: string;
  readonly idempotency_key: string;
  readonly at: string;
  readonly detail?: string;
}

/* ───────────────────────────  Execution gate  ───────────────────────────── */

export type ExecutionEnv = 'local' | 'staging' | 'production';

/**
 * Phase G+ — actions PERMANENTLY blocked in production, even if mistakenly
 * added to the prod allowlist. Destructive client/invoice/transaction/service/
 * domain/admin/config mutations and any mass/bulk or raw-DB write path. This
 * gate is checked BEFORE the prod allowlist, so an allowlist mistake cannot
 * reach a catastrophic action. Frozen.
 */
export const PROD_NEVER_EXECUTABLE: ReadonlySet<string> = new Set<string>([
  // Destructive client / billing record deletion
  'DeleteClient',
  'DeleteInvoice',
  'DeleteTransaction',
  'DeletePayMethod',
  // Service / module termination
  'TerminateService',
  'ModuleTerminate',
  'MassTerminate',
  // Domain destructive
  'DomainTransfer',
  'DomainRelease',
  'DeleteDomain',
  // Admin / API credential / security / config mutations
  'SetConfigurationValue',
  'UpdateAdmin',
  'CreateAdmin',
  'DeleteAdmin',
  'CreateOAuthCredential',
  'DeleteOAuthCredential',
  'UpdateApiCredential',
]);

/**
 * Scope-level permanent block — complements the action-keyed set above. Needed
 * because two scopes can share one WHMCS action (e.g. UpdateClientProduct), so
 * action-keying alone cannot hard-block ONE scope while allowing its sibling.
 * Scopes here can NEVER execute in production even if allowlisted. Destructive
 * scopes (e.g. a future `service:terminate`) are born blocked-by-default; an
 * operator must consciously remove them here to enable. Frozen.
 */
export const PROD_NEVER_EXECUTABLE_SCOPES: ReadonlySet<string> = new Set<string>([
  // Reserved for destructive scopes added by later tracks (Track C). Listing a
  // not-yet-defined scope is harmless (the gate matches the intent's scope
  // string) and makes the scope hard-blocked the moment it is introduced.
  'service:terminate',
  'domain:transfer',
  'domain:release',
]);

/** Recorded human approval for a high-risk (money) production action. */
export interface HumanApprovalRecord {
  readonly approver: string;
  readonly at: string;
}

/** Monetary context + day-running-total for high-risk cap enforcement. */
export interface AmountContext {
  /** This action's monetary magnitude (absolute value). */
  readonly amount: number;
  /** Sum of same-tier amounts already executed in the current day window. */
  readonly dayTotal: number;
}

/** High-risk caps. Default 0 ⇒ every money action denied until configured. */
export interface HighRiskCaps {
  readonly perAction: number;
  readonly daily: number;
}

export interface ExecutionRequest {
  readonly intent: WriteIntent;
  readonly env: ExecutionEnv;
  /** MCP mode — execution is impossible unless this is NOT read_only. */
  readonly mcpMode: 'read_only' | 'simulate' | 'full';
  readonly consumerWriteCapability: string;
  /** Non-prod actions explicitly authorized at runtime. Empty ⇒ none. */
  readonly runtimeAuthorizedActions: readonly string[];
  /* ── Phase G+ production policy inputs. ALL OPTIONAL: the defaults
     (kill switch off, empty prod allowlist, no approval, zero caps) keep
     the sealed-by-default posture byte-identical to the legacy gate. ── */
  /** Global instant seal. Default false. */
  readonly killSwitch?: boolean;
  /** Production per-action allowlist. Default [] ⇒ production sealed. */
  readonly prodAuthorizedActions?: readonly string[];
  /** Human approval record (required for high-risk in any env). */
  readonly humanApproval?: HumanApprovalRecord;
  /** Monetary context for high-risk cap checks. */
  readonly amountContext?: AmountContext;
  /** High-risk caps. Default { perAction: 0, daily: 0 } ⇒ money denied. */
  readonly caps?: HighRiskCaps;
  /**
   * Tiered-friction override. Default false ⇒ the per-environment allowlist is
   * enforced for HIGH-RISK intents only; low/medium scopes are audit-gated
   * (consumer execution capability + always-on audit) and need no per-action
   * allowlisting. Set true to restore strict allowlist-for-ALL-tiers (the
   * legacy posture) — a deployment-level safety lever for cautious operators.
   */
  readonly strictAllowlist?: boolean;
  /**
   * Per-scope tightening. Scopes listed here ALWAYS require the allowlist even
   * if their risk tier is low/medium (e.g. `billing:invoice:create` —
   * financial-document creation an operator may want opt-in per env). This can
   * only TIGHTEN: it never loosens a high-risk scope below its full gate.
   * Sourced from `MCP_WRITE_STRICT_SCOPES`. Default-empty here.
   */
  readonly strictScopes?: readonly string[];
}

export type ExecutionDeniedReason =
  // Legacy (retained for compat; no longer emitted by the default authorizer
  // now that production is governed by the deny-by-default policy table).
  | 'production_execution_forbidden'
  | 'action_not_low_risk_executable'
  // Core gates (priority order).
  | 'kill_switch_engaged'
  | 'read_only_mode'
  | 'intent_not_approved'
  | 'consumer_not_execution_allowed'
  | 'idempotency_replay'
  | 'action_permanently_blocked'
  | 'action_not_prod_authorized'
  | 'action_not_runtime_authorized'
  // Risk-tier policy.
  | 'human_approval_required'
  | 'amount_cap_exceeded'
  // Execution-stage (emitted by the write-flow, not the pure gate).
  | 'audit_write_failed'
  | 'verification_failed'
  | 'precondition_mismatch'
  | 'halt_after_target'
  | 'target_amount_cap_exceeded'
  | 'target_output_assertion_failed';

export type ExecutionDecision =
  | { readonly allowed: false; readonly reason: ExecutionDeniedReason }
  | { readonly allowed: true };

/**
 * The execution authorizer. DENY-BY-DEFAULT. Returns `allowed:true` ONLY
 * when every gate passes (approved intent, non-read_only mode, consumer
 * `execution_allowed`, action in the runtime authorization allowlist, no
 * idempotency replay). The default posture (read_only, empty runtime
 * allowlist) always denies — no live production mutation can occur.
 */
export type ExecutionAuthorizer = (req: ExecutionRequest) => ExecutionDecision;

/* ───────────────────────────  App result  ──────────────────────────────── */

/** Structured result for app consumers of any write-flow tool. */
export interface WriteToolResult {
  readonly intent: WriteIntent;
  readonly stage: 'draft' | 'validate' | 'approve' | 'execute' | 'verify';
  readonly validation?: ValidationResult;
  readonly risk_flags: readonly string[];
  readonly required_approvals: number;
  readonly idempotency_key: string;
  /** What WHMCS call WOULD be made — for dry-run/preview. Never executed here. */
  readonly would_call: {
    readonly action: string;
    readonly params: Readonly<Record<string, unknown>>;
  };
  /**
   * Phase G: widened from the Phase-F literal `false` to `boolean`. Still
   * `false` in production / read-only / non-approved / non-low-risk paths;
   * `true` only after a gated dev/staging low-risk mutation actually ran.
   */
  readonly executed: boolean;
  readonly execution: {
    readonly attempted: boolean;
    readonly blocked_reason?: ExecutionDeniedReason;
    /** Set when gates passed but no live write path is wired (never executed). */
    readonly note?: string;
    /** Phase G: post-action read-back verification result, when executed. */
    readonly verified?: boolean;
  };
}
