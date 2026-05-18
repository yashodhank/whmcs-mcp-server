/**
 * Phase F — the DENY-BY-DEFAULT execution authorizer.
 *
 * SAFETY INVARIANT: this function NEVER calls WHMCS. It only returns a
 * decision. It returns `{ allowed: true }` ONLY when every gate passes:
 *
 *   1. mcpMode !== 'read_only'                    (else read_only_mode)
 *   2. intent.state === 'approved'                (else intent_not_approved)
 *   3. consumerWriteCapability === 'execution_allowed'
 *                                                 (else consumer_not_execution_allowed)
 *   4. runtimeAuthorizedActions includes the action
 *                                                 (else action_not_runtime_authorized)
 *   5. !alreadyExecuted(idempotency_key)          (else idempotency_replay)
 *
 * In the CURRENT default posture the MCP runs in `read_only` mode with an
 * EMPTY runtimeAuthorizedActions allowlist, so gates 1 and 4 can never pass:
 * this authorizer ALWAYS denies and no live production mutation can occur.
 */

import type {
  ExecutionDecision,
  ExecutionRequest,
} from './types.js';

const CONSUMER_EXECUTION_ALLOWED = 'execution_allowed';

/** Predicate the caller supplies to flag an idempotency replay. */
export type AlreadyExecuted = (idempotencyKey: string) => boolean;

const neverExecuted: AlreadyExecuted = () => false;

/**
 * DENY-BY-DEFAULT execution authorizer implementing the frozen seam gate
 * exactly. Pure: never contacts WHMCS.
 */
export function defaultExecutionAuthorizer(
  req: ExecutionRequest,
  alreadyExecuted: AlreadyExecuted = neverExecuted,
): ExecutionDecision {
  // Phase G HARD GATE — production can NEVER execute, regardless of mode,
  // consumer, runtime allowlist or approval. Checked FIRST, absolutely.
  if (req.env === 'production') {
    return { allowed: false, reason: 'production_execution_forbidden' };
  }
  if (req.mcpMode === 'read_only') {
    return { allowed: false, reason: 'read_only_mode' };
  }
  if (req.intent.state !== 'approved') {
    return { allowed: false, reason: 'intent_not_approved' };
  }
  if (req.consumerWriteCapability !== CONSUMER_EXECUTION_ALLOWED) {
    return { allowed: false, reason: 'consumer_not_execution_allowed' };
  }
  if (!req.runtimeAuthorizedActions.includes(req.intent.action)) {
    return { allowed: false, reason: 'action_not_runtime_authorized' };
  }
  if (alreadyExecuted(req.intent.idempotency_key)) {
    return { allowed: false, reason: 'idempotency_replay' };
  }
  return { allowed: true };
}
