/**
 * Phase G+ — the DENY-BY-DEFAULT, risk-tiered execution authorizer.
 *
 * SAFETY INVARIANT: this function NEVER calls WHMCS. It only returns a
 * decision. The absolute `env==='production' ⇒ deny` block is REPLACED by a
 * deny-by-default policy table, but the KEYSTONE property is preserved:
 *
 *   With no new env configured — killSwitch off (default), empty
 *   prodAuthorizedActions (default), zero caps (default) — a production
 *   request can only ever reach `action_not_prod_authorized` (or an earlier
 *   denial). Production stays 100% sealed; behaviour is byte-identical to the
 *   legacy absolute-deny gate.
 *
 * Gate priority (first failing gate wins):
 *
 *   1. killSwitch on                         → kill_switch_engaged
 *   2. mcpMode === 'read_only'               → read_only_mode
 *   3. intent.state !== 'approved'           → intent_not_approved
 *   4. consumer !== 'execution_allowed'      → consumer_not_execution_allowed
 *   5. alreadyExecuted(idempotency_key)      → idempotency_replay
 *   6. action ∈ PROD_NEVER_EXECUTABLE        → action_permanently_blocked
 *   7. env==='production':
 *        action ∉ prodAuthorizedActions      → action_not_prod_authorized
 *      else:
 *        action ∉ runtimeAuthorizedActions   → action_not_runtime_authorized
 *   8. risk==='high':
 *        no humanApproval                    → human_approval_required
 *        amount/day over caps (default 0)    → amount_cap_exceeded
 *
 * The read-only WhmcsClient.mutate() MODE_RESTRICTED check is an independent
 * backstop beneath this gate.
 */

import {
  PROD_NEVER_EXECUTABLE,
  type ExecutionDecision,
  type ExecutionDeniedReason,
  type ExecutionRequest,
  type HighRiskCaps,
} from './types.js';

const CONSUMER_EXECUTION_ALLOWED = 'execution_allowed';

/** Default caps — zero ⇒ every high-risk (money) action is denied. */
const ZERO_CAPS: HighRiskCaps = { perAction: 0, daily: 0 };

/** Predicate the caller supplies to flag an idempotency replay. */
export type AlreadyExecuted = (idempotencyKey: string) => boolean;

const neverExecuted: AlreadyExecuted = () => false;

function deny(reason: ExecutionDeniedReason): ExecutionDecision {
  return { allowed: false, reason };
}

/**
 * DENY-BY-DEFAULT risk-tiered execution authorizer. Pure: never contacts
 * WHMCS. Optional Phase G+ fields default to the sealed posture.
 */
export function defaultExecutionAuthorizer(
  req: ExecutionRequest,
  alreadyExecuted: AlreadyExecuted = neverExecuted
): ExecutionDecision {
  // 1. Global instant seal.
  if (req.killSwitch === true) {
    return deny('kill_switch_engaged');
  }
  // 2. Mode. (Mirrors the WhmcsClient.mutate() MODE_RESTRICTED backstop.)
  if (req.mcpMode === 'read_only') {
    return deny('read_only_mode');
  }
  // 3. Intent must be explicitly approved.
  if (req.intent.state !== 'approved') {
    return deny('intent_not_approved');
  }
  // 4. Consumer must be explicitly cleared for execution.
  if (req.consumerWriteCapability !== CONSUMER_EXECUTION_ALLOWED) {
    return deny('consumer_not_execution_allowed');
  }
  // 5. No idempotency replay.
  if (alreadyExecuted(req.intent.idempotency_key)) {
    return deny('idempotency_replay');
  }
  // 6. Permanently-blocked actions — checked BEFORE any allowlist so an
  //    allowlist mistake can never reach a catastrophic action.
  if (PROD_NEVER_EXECUTABLE.has(req.intent.action)) {
    return deny('action_permanently_blocked');
  }
  // 7. Per-environment allowlist. Production uses its own allowlist that is
  //    EMPTY by default ⇒ production sealed (keystone invariant).
  if (req.env === 'production') {
    const prodAllow = req.prodAuthorizedActions ?? [];
    if (!prodAllow.includes(req.intent.action)) {
      return deny('action_not_prod_authorized');
    }
  } else {
    if (!req.runtimeAuthorizedActions.includes(req.intent.action)) {
      return deny('action_not_runtime_authorized');
    }
  }
  // 8. Risk-tier policy. High-risk (money) actions require a human approval
  //    record AND must sit within explicitly-configured caps. Caps default
  //    to zero, so a high-risk action is denied until caps are configured.
  if (req.intent.risk === 'high') {
    if (req.humanApproval === undefined) {
      return deny('human_approval_required');
    }
    const rawCaps = req.caps ?? ZERO_CAPS;
    // Defensive coercion: a non-finite / missing / negative cap is treated as
    // ZERO (deny), never as "unbounded". A malformed caps object must never
    // widen the money posture.
    const perAction = Number.isFinite(rawCaps.perAction) ? rawCaps.perAction : 0;
    const daily = Number.isFinite(rawCaps.daily) ? rawCaps.daily : 0;
    const amt = req.amountContext;
    // A money action with no bounding amount context cannot be capped ⇒ deny.
    if (amt === undefined) {
      return deny('amount_cap_exceeded');
    }
    if (perAction <= 0 || amt.amount > perAction) {
      return deny('amount_cap_exceeded');
    }
    if (daily <= 0 || amt.dayTotal + amt.amount > daily) {
      return deny('amount_cap_exceeded');
    }
  }
  // medium / low: allowed once allowlisted (medium caps are a future, optional
  // refinement — deliberately not enforced here per the approved spec).
  return { allowed: true };
}
