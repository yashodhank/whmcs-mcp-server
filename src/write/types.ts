/**
 * Phase F — Controlled Write Automation: FROZEN CORE SEAM.
 *
 * Types + frozen constants only (no runtime logic here). Layers (intent
 * store, validation, idempotency, audit, support/billing draft tools,
 * execution gate) are built against THIS file.
 *
 * SAFETY INVARIANT: nothing in this framework calls a WHMCS mutating
 * action against production. The execution stage is gated by an explicit
 * ExecutionAuthorizer that DENIES by default; the existing read-only
 * WhmcsClient.mutate() MODE_RESTRICTED block remains the ultimate backstop.
 * Live production mutation requires separate, explicit, per-action runtime
 * authorization that is intentionally absent in the default posture.
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

export interface ExecutionRequest {
  readonly intent: WriteIntent;
  readonly env: ExecutionEnv;
  /** MCP mode — execution is impossible unless this is NOT read_only. */
  readonly mcpMode: 'read_only' | 'simulate' | 'full';
  readonly consumerWriteCapability: string;
  /** Actions explicitly authorized at runtime (env allowlist). Empty ⇒ none. */
  readonly runtimeAuthorizedActions: readonly string[];
}

export type ExecutionDeniedReason =
  | 'read_only_mode'
  | 'consumer_not_execution_allowed'
  | 'action_not_runtime_authorized'
  | 'intent_not_approved'
  | 'idempotency_replay';

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
  readonly would_call: { readonly action: string; readonly params: Readonly<Record<string, unknown>> };
  readonly executed: false;
  readonly execution: {
    readonly attempted: false;
    readonly blocked_reason?: ExecutionDeniedReason;
    /** Set when gates passed but no live write path is wired (never executed). */
    readonly note?: string;
  };
}
