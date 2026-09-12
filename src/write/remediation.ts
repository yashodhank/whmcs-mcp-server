/**
 * Structured remediation guidance for execution denials.
 *
 * Maps each `ExecutionDeniedReason` to agent-readable remediation steps so
 * that AI agents (and humans) can self-service the fix without grepping env
 * vars, cat'ing token files, or killing MCP processes.
 *
 * SAFETY: this module NEVER echoes secrets, tokens, or file contents. It
 * emits only structural metadata (paths, boolean flags, action names).
 */

import type { ExecutionDeniedReason } from './types.js';

export interface RemediationStep {
  readonly code: string;
  readonly message: string;
  readonly next_tool?: string;
}

export interface ExecutionPreflight {
  readonly would_allow: boolean;
  readonly blocked_reason?: ExecutionDeniedReason;
  readonly missing_allowlist?: readonly string[];
  readonly allowlist_source?: 'file' | 'env' | 'empty';
  readonly allowlist_path?: string;
  readonly remediation: readonly RemediationStep[];
}

export interface PreflightContext {
  readonly allowlistSource: 'file' | 'env' | 'empty';
  readonly allowlistPath?: string;
  readonly prodAuthorizedActions: readonly string[];
  readonly action: string;
  readonly scope: string;
  readonly capsPerAction?: number;
  readonly capsDaily?: number;
  readonly intentAmount?: number;
}

export function remediationForDeny(
  reason: ExecutionDeniedReason,
  ctx?: PreflightContext
): readonly RemediationStep[] {
  switch (reason) {
    case 'kill_switch_engaged':
      return [
        {
          code: 'kill_switch',
          message:
            'MCP_WRITE_KILL_SWITCH is engaged. An operator must set MCP_WRITE_KILL_SWITCH=false and restart the MCP process.',
        },
      ];
    case 'read_only_mode':
      return [
        {
          code: 'mode_read_only',
          message:
            'MCP_MODE is read_only. An operator must set MCP_MODE=full (or simulate) and restart the MCP process.',
        },
      ];
    case 'intent_not_approved':
      return [
        {
          code: 'needs_approval',
          message: 'Call approve_write_intent with a distinct approver consumer before executing.',
          next_tool: 'approve_write_intent',
        },
      ];
    case 'consumer_not_execution_allowed':
      return [
        {
          code: 'consumer_capability',
          message:
            'The current consumer does not have writeCapability=execution_allowed. Check get_write_posture for your consumer profile or use a consumer with execution_allowed.',
          next_tool: 'get_write_posture',
        },
      ];
    case 'idempotency_replay':
      return [
        {
          code: 'replay',
          message:
            'This intent has already been executed (idempotency replay). Draft a new intent with a different naturalKey if you need to re-execute.',
          next_tool: 'draft_write_intent',
        },
      ];
    case 'action_permanently_blocked':
      return [
        {
          code: 'never_executable',
          message:
            'This action/scope is in the PROD_NEVER_EXECUTABLE set and cannot be executed in production under any configuration.',
        },
      ];
    case 'action_not_prod_authorized': {
      const steps: RemediationStep[] = [
        {
          code: 'not_allowlisted',
          message: ctx
            ? `Action "${ctx.action}" (scope "${ctx.scope}") is not in the production allowlist. ` +
              (ctx.allowlistSource === 'file'
                ? `Add it to the live allowlist file (${ctx.allowlistPath ?? 'MCP_PROD_WRITE_AUTHORIZED_FILE'}) — no restart needed.`
                : ctx.allowlistSource === 'env'
                  ? 'Add it to MCP_PROD_WRITE_AUTHORIZED env var and restart the MCP process.'
                  : 'No production allowlist is configured. Set MCP_PROD_WRITE_AUTHORIZED_FILE (preferred) or MCP_PROD_WRITE_AUTHORIZED.')
            : 'Action is not in the production write allowlist. Use get_write_posture to see current allowlist source and contents.',
          next_tool: 'get_write_posture',
        },
      ];
      return steps;
    }
    case 'action_not_runtime_authorized':
      return [
        {
          code: 'not_runtime_allowlisted',
          message:
            'Action is not in MCP_WRITE_EXECUTION_AUTHORIZED (non-prod runtime allowlist). Add the action/scope and restart.',
        },
      ];
    case 'human_approval_required':
      return [
        {
          code: 'needs_human_approval',
          message:
            'High-risk action requires a human approval record from a distinct approver consumer. Call approve_write_intent.',
          next_tool: 'approve_write_intent',
        },
      ];
    case 'self_approval_forbidden':
      return [
        {
          code: 'distinct_approver',
          message:
            'High-risk intents require a DISTINCT approver (approver_consumer_id !== drafter consumer_id). Use a second consumer token to approve.',
          next_tool: 'approve_write_intent',
        },
      ];
    case 'amount_cap_exceeded': {
      const parts: string[] = [];
      if (ctx?.capsPerAction !== undefined) {
        parts.push(`per_action_cap=${ctx.capsPerAction}`);
      }
      if (ctx?.capsDaily !== undefined) {
        parts.push(`daily_cap=${ctx.capsDaily}`);
      }
      if (ctx?.intentAmount !== undefined) {
        parts.push(`intent_amount=${ctx.intentAmount}`);
      }
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      const zeroNote =
        (ctx?.capsPerAction ?? 0) <= 0 || (ctx?.capsDaily ?? 0) <= 0
          ? ' Caps default to 0 (deny-all); configure positive values to enable high-risk execution.'
          : '';
      return [
        {
          code: 'cap_exceeded',
          message: `The action amount exceeds configured monetary caps${detail}.${zeroNote} An operator must raise MCP_PROD_HIGH_RISK_PER_ACTION_CAP and/or MCP_PROD_HIGH_RISK_DAILY_CAP (restart required).`,
          next_tool: 'get_write_posture',
        },
      ];
    }
    case 'destructive_confirmation_required':
      return [
        {
          code: 'destructive_phrase',
          message:
            'Destructive scope requires a typed confirmation phrase matching MCP_WRITE_DESTRUCTIVE_CONFIRM_PHRASE. Re-draft the intent with the confirmation param.',
          next_tool: 'draft_write_intent',
        },
      ];
    case 'audit_write_failed':
      return [
        {
          code: 'audit_failed',
          message:
            'Durable audit write failed (fail-closed). Check MCP_WRITE_AUDIT_PATH is writable. No mutation occurred.',
        },
      ];
    case 'scope_not_allowed':
      return [
        {
          code: 'scope_revoked',
          message:
            "The consumer's write-scope grant for this scope was revoked after approval. Re-check consumer registry.",
          next_tool: 'get_write_posture',
        },
      ];
    default:
      return [
        {
          code: 'other',
          message: `Execution blocked: ${reason}. Use get_write_posture to inspect the current write posture.`,
          next_tool: 'get_write_posture',
        },
      ];
  }
}

/**
 * Build a full ExecutionPreflight from a gate decision and context. Used by
 * both validate (dry-run) and execute (real denial) to return a uniform shape.
 */
export function buildPreflight(
  decision: { allowed: boolean; reason?: ExecutionDeniedReason },
  ctx: PreflightContext
): ExecutionPreflight {
  if (decision.allowed) {
    return {
      would_allow: true,
      allowlist_source: ctx.allowlistSource,
      allowlist_path: ctx.allowlistPath,
      remediation: [],
    };
  }
  if (decision.reason === undefined) {
    return { would_allow: false, remediation: [] };
  }
  const reason = decision.reason;
  const missing =
    reason === 'action_not_prod_authorized' || reason === 'action_not_runtime_authorized'
      ? [ctx.scope, ctx.action].filter((x) => !ctx.prodAuthorizedActions.includes(x))
      : undefined;
  return {
    would_allow: false,
    blocked_reason: reason,
    missing_allowlist: missing,
    allowlist_source: ctx.allowlistSource,
    allowlist_path: ctx.allowlistPath,
    remediation: remediationForDeny(reason, ctx),
  };
}
