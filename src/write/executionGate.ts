/**
 * Phase G+ / tiered-friction — the risk-proportionate execution authorizer.
 *
 * SAFETY INVARIANT: this function NEVER calls WHMCS. It only returns a decision.
 *
 * TIERED-FRICTION POSTURE: friction is matched to risk, not applied uniformly.
 *   - LOW / MEDIUM scopes are AUDIT-GATED: they execute once the consumer is
 *     `execution_allowed` and the universal safety gates pass (kill switch off,
 *     not read_only, approved intent, no replay, action not permanently
 *     blocked). They need NO per-action allowlist — the low-friction path for
 *     ordinary work (notes, tickets, hostname/nameserver edits, suspend).
 *   - HIGH-RISK scopes (money + destructive) keep the FULL gate: per-environment
 *     allowlist + human approval + monetary caps + PROD_NEVER_EXECUTABLE.
 *
 * KEYSTONE (now scoped to high-risk): with no new env configured — killSwitch
 * off, empty prodAuthorizedActions, zero caps — a HIGH-RISK production request
 * can only ever reach `action_not_prod_authorized` (or an earlier denial).
 * High-risk production money/destruction stays 100% sealed by default.
 *
 * STRICT OVERRIDE: `req.strictAllowlist === true` restores allowlist
 * enforcement for ALL tiers (legacy posture) — a deployment-level lever.
 *
 * Gate priority (first failing gate wins):
 *
 *   1. killSwitch on                         → kill_switch_engaged
 *   2. mcpMode === 'read_only'               → read_only_mode
 *   3. intent.state !== 'approved'           → intent_not_approved
 *   4. consumer !== 'execution_allowed'      → consumer_not_execution_allowed
 *   5. alreadyExecuted(idempotency_key)      → idempotency_replay
 *   6. action ∈ PROD_NEVER_EXECUTABLE        → action_permanently_blocked
 *   7. allowlist (HIGH-RISK, scope ∈ strictScopes, or strictAllowlist):
 *        env==='production':
 *          intent unauthorized by prod allow → action_not_prod_authorized
 *        else:
 *          unauthorized by runtime allow     → action_not_runtime_authorized
 *
 *      "Authorized by an allowlist" means the allowlist names EITHER the
 *      intent's WHMCS action (BROAD grant — authorizes every scope mapping to
 *      that action) OR the intent's write SCOPE (NARROW grant — authorizes only
 *      that one scope). Scope entries are how two scopes that share a single
 *      WHMCS action (service:price_restore and service:domain_rename both →
 *      UpdateClientProduct) are gated independently. See `allowlistAuthorizes`.
 *   8. risk==='high':
 *        no humanApproval                    → human_approval_required
 *        approver == drafter                 → self_approval_forbidden
 *        amount/day over caps (default 0)    → amount_cap_exceeded
 *      risk low/medium (requireDistinctApprover + approval present):
 *        approver == drafter                 → self_approval_forbidden
 *
 * The read-only WhmcsClient.mutate() MODE_RESTRICTED check is an independent
 * backstop beneath this gate.
 */

import {
  PROD_NEVER_EXECUTABLE,
  PROD_NEVER_EXECUTABLE_SCOPES,
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
 * An allowlist authorizes an intent when it names EITHER the intent's WHMCS
 * action (BROAD grant — authorizes EVERY write scope that maps to that action)
 * OR the intent's write scope (NARROW grant — authorizes ONLY that scope).
 *
 * This is the mechanism that lets two scopes sharing one WHMCS action
 * (`service:price_restore` and `service:domain_rename`, both → UpdateClientProduct)
 * be gated independently: list the scope string, not the action. An empty
 * allowlist matches neither ⇒ sealed (keystone invariant preserved). Action
 * entries remain valid for backward compatibility with existing deployments.
 */
export function allowlistAuthorizes(
  allow: readonly string[],
  action: string,
  scope: string
): boolean {
  return allow.includes(action) || allow.includes(scope);
}

/**
 * Steps 1–7 of the gate: every NON-monetary deny-by-default check —
 * killSwitch, mode, approval, consumer execution capability, idempotency
 * replay, permanently-blocked actions, and (for high-risk or under
 * `strictAllowlist`) the per-environment allowlist. Returns `allowed:true`
 * when all applicable gates pass; the caller handles any risk-tier (monetary)
 * cap enforcement.
 *
 * Exposed separately so a scope with its own per-target cap logic (the
 * `service:price_restore` batch executor — HIGH risk) can reuse the IDENTICAL
 * gates instead of re-implementing — or worse, silently bypassing — them.
 * Because price_restore is high-risk, the allowlist is enforced for it here.
 */
export function preAuthorizeIntent(
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
  // 6. Permanently-blocked actions OR scopes — checked BEFORE any allowlist so
  //    an allowlist mistake can never reach a catastrophic action. The scope
  //    set hard-blocks one scope even when its WHMCS action is shared with a
  //    safe sibling scope.
  if (
    PROD_NEVER_EXECUTABLE.has(req.intent.action) ||
    PROD_NEVER_EXECUTABLE_SCOPES.has(req.intent.scope)
  ) {
    return deny('action_permanently_blocked');
  }
  // 7. Per-environment allowlist — TIERED. Enforced for HIGH-RISK intents
  //    always, and for ALL intents when strictAllowlist is set. Low/medium are
  //    otherwise audit-gated (consumer capability + always-on audit) and need
  //    no allowlist. The empty-allowlist keystone therefore still seals
  //    high-risk production money/destruction by default.
  const allowlistRequired =
    req.intent.risk === 'high' ||
    req.strictAllowlist === true ||
    (req.strictScopes?.includes(req.intent.scope) ?? false);
  if (allowlistRequired) {
    if (req.env === 'production') {
      const prodAllow = req.prodAuthorizedActions ?? [];
      if (!allowlistAuthorizes(prodAllow, req.intent.action, req.intent.scope)) {
        return deny('action_not_prod_authorized');
      }
    } else {
      if (
        !allowlistAuthorizes(req.runtimeAuthorizedActions, req.intent.action, req.intent.scope)
      ) {
        return deny('action_not_runtime_authorized');
      }
    }
  }
  return { allowed: true };
}

/**
 * DENY-BY-DEFAULT risk-tiered execution authorizer. Pure: never contacts
 * WHMCS. Optional Phase G+ fields default to the sealed posture.
 */
export function defaultExecutionAuthorizer(
  req: ExecutionRequest,
  alreadyExecuted: AlreadyExecuted = neverExecuted
): ExecutionDecision {
  // Steps 1–7: all non-monetary gates (shared with the batch executor).
  const pre = preAuthorizeIntent(req, alreadyExecuted);
  if (!pre.allowed) {
    return pre;
  }
  // 8. Risk-tier policy. High-risk (money) actions require a human approval
  //    record AND must sit within explicitly-configured caps. Caps default
  //    to zero, so a high-risk action is denied until caps are configured.
  if (req.intent.risk === 'high') {
    if (req.humanApproval === undefined) {
      return deny('human_approval_required');
    }
    // Separation of duties: a high-risk intent can never be self-approved. The
    // approving consumer must differ from the drafting consumer.
    if (req.humanApproval.approver_consumer_id === req.intent.consumer_id) {
      return deny('self_approval_forbidden');
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
  // Low/medium: enforce distinct approver only when the operator opted in AND an
  // approval record exists (low/medium need no approval, so absence is allowed).
  else if (req.requireDistinctApprover === true && req.humanApproval !== undefined) {
    if (req.humanApproval.approver_consumer_id === req.intent.consumer_id) {
      return deny('self_approval_forbidden');
    }
  }
  // medium / low: allowed once allowlisted (medium caps are a future, optional
  // refinement — deliberately not enforced here per the approved spec).
  return { allowed: true };
}
