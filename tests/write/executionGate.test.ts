/**
 * Phase F — DENY-BY-DEFAULT execution gate tests.
 *
 * Proves each independent denial reason in priority order, that the gate
 * allows ONLY when every condition passes (full mode, approved intent,
 * execution_allowed consumer, action runtime-authorized, no replay), and
 * that the real default posture (read_only, empty runtime allowlist) is
 * ALWAYS denied. Pure — no WHMCS.
 */

import { describe, it, expect } from 'vitest';
import { createDraftIntent, IntentStore } from '../../src/write/intents.js';
import { defaultExecutionAuthorizer } from '../../src/write/executionGate.js';
import type { ExecutionRequest, WriteIntent } from '../../src/write/types.js';

function approvedIntent(): WriteIntent {
  const store = new IntentStore();
  const intent = createDraftIntent({
    consumer_id: 'c1',
    scope: 'client_note:write',
    params: { clientid: 1, note: 'n' },
    naturalKey: 'k',
    preconditions: {},
    projected_effect: 'note',
  });
  store.put(intent);
  store.transition(intent.intent_id, 'validated');
  return store.transition(intent.intent_id, 'approved');
}

function fullyOpenReq(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const intent = approvedIntent();
  return {
    intent,
    env: 'staging',
    mcpMode: 'full',
    consumerWriteCapability: 'execution_allowed',
    runtimeAuthorizedActions: [intent.action],
    ...overrides,
  };
}

describe('defaultExecutionAuthorizer', () => {
  it('denies read_only_mode when mcpMode is read_only', () => {
    const d = defaultExecutionAuthorizer(fullyOpenReq({ mcpMode: 'read_only' }));
    expect(d).toEqual({ allowed: false, reason: 'read_only_mode' });
  });

  it('denies intent_not_approved when intent is not approved', () => {
    const draft = createDraftIntent({
      consumer_id: 'c1',
      scope: 'ticket:create',
      params: { subject: 's', message: 'm' },
      naturalKey: 'k',
      preconditions: {},
      projected_effect: 'p',
    });
    const d = defaultExecutionAuthorizer(fullyOpenReq({ intent: draft }));
    expect(d).toEqual({ allowed: false, reason: 'intent_not_approved' });
  });

  it('denies consumer_not_execution_allowed for a non-execution_allowed consumer', () => {
    const d = defaultExecutionAuthorizer(fullyOpenReq({ consumerWriteCapability: 'draft_only' }));
    expect(d).toEqual({ allowed: false, reason: 'consumer_not_execution_allowed' });
  });

  it('denies action_not_runtime_authorized when action absent from allowlist', () => {
    const d = defaultExecutionAuthorizer(fullyOpenReq({ runtimeAuthorizedActions: [] }));
    expect(d).toEqual({ allowed: false, reason: 'action_not_runtime_authorized' });
  });

  it('denies idempotency_replay when alreadyExecuted predicate is true', () => {
    const req = fullyOpenReq();
    const d = defaultExecutionAuthorizer(req, () => true);
    expect(d).toEqual({ allowed: false, reason: 'idempotency_replay' });
  });

  it('allows ONLY when every gate passes', () => {
    const d = defaultExecutionAuthorizer(fullyOpenReq(), () => false);
    expect(d).toEqual({ allowed: true });
  });

  it('ALWAYS denies in the real default posture (read_only, empty allowlist)', () => {
    const intent = approvedIntent();
    const posture: ExecutionRequest = {
      intent,
      env: 'production',
      mcpMode: 'read_only',
      consumerWriteCapability: 'execution_allowed',
      runtimeAuthorizedActions: [],
    };
    const d = defaultExecutionAuthorizer(posture);
    expect(d.allowed).toBe(false);
  });
});

/* ─────────────  Phase G+ risk-tiered production policy table  ───────────── */

function approvedHighRiskIntent(): WriteIntent {
  const store = new IntentStore();
  const intent = createDraftIntent({
    consumer_id: 'c1',
    scope: 'billing:credit:add', // SCOPE_RISK ⇒ 'high', action 'AddCredit'
    params: { clientid: 1, amount: 50 },
    naturalKey: 'k-credit',
    preconditions: {},
    projected_effect: 'credit',
  });
  store.put(intent);
  store.transition(intent.intent_id, 'validated');
  return store.transition(intent.intent_id, 'approved');
}

/** Production request, fully open EXCEPT the (intentionally absent) prod allowlist. */
function prodReq(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const intent = approvedIntent(); // client_note:write (low), action AddClientNote
  return {
    intent,
    env: 'production',
    mcpMode: 'full',
    consumerWriteCapability: 'execution_allowed',
    runtimeAuthorizedActions: [],
    ...overrides,
  };
}

describe('defaultExecutionAuthorizer — keystone invariant', () => {
  it('KEYSTONE: no new env (no killSwitch, no prodAuthorizedActions, zero caps) ⇒ production SEALED', () => {
    // Everything else fully open; the ONLY thing not configured is the prod
    // allowlist — production must still be sealed.
    const d = defaultExecutionAuthorizer(prodReq(), () => false);
    expect(d).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('KEYSTONE: explicit empty prodAuthorizedActions ⇒ still sealed', () => {
    const d = defaultExecutionAuthorizer(prodReq({ prodAuthorizedActions: [] }), () => false);
    expect(d).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('legacy default posture (prod, read_only) still denies', () => {
    expect(defaultExecutionAuthorizer(prodReq({ mcpMode: 'read_only' })).allowed).toBe(false);
  });
});

describe('defaultExecutionAuthorizer — gate priority & new reasons', () => {
  it('kill_switch_engaged wins over everything (even a fully-open allowlisted prod req)', () => {
    const intent = approvedIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({ killSwitch: true, prodAuthorizedActions: [intent.action] })
    );
    expect(d).toEqual({ allowed: false, reason: 'kill_switch_engaged' });
  });

  it('kill switch precedes read_only', () => {
    const d = defaultExecutionAuthorizer(prodReq({ killSwitch: true, mcpMode: 'read_only' }));
    expect(d).toEqual({ allowed: false, reason: 'kill_switch_engaged' });
  });

  it('action_not_prod_authorized when action absent from prod allowlist', () => {
    const d = defaultExecutionAuthorizer(prodReq({ prodAuthorizedActions: ['SomethingElse'] }));
    expect(d).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('allows a low-risk action explicitly in the prod allowlist (AddClientNote canary)', () => {
    const intent = approvedIntent(); // AddClientNote, low risk
    const d = defaultExecutionAuthorizer(
      prodReq({ intent, prodAuthorizedActions: [intent.action] }),
      () => false
    );
    expect(d).toEqual({ allowed: true });
  });

  it('action_permanently_blocked even when allowlisted (prod)', () => {
    const base = approvedIntent();
    const forbidden: WriteIntent = { ...base, action: 'DeleteClient' };
    const d = defaultExecutionAuthorizer(
      prodReq({ intent: forbidden, prodAuthorizedActions: ['DeleteClient'] })
    );
    expect(d).toEqual({ allowed: false, reason: 'action_permanently_blocked' });
  });

  it('action_permanently_blocked even in non-prod env', () => {
    const base = approvedIntent();
    const forbidden: WriteIntent = { ...base, action: 'TerminateService' };
    const d = defaultExecutionAuthorizer(
      fullyOpenReq({ intent: forbidden, runtimeAuthorizedActions: ['TerminateService'] })
    );
    expect(d).toEqual({ allowed: false, reason: 'action_permanently_blocked' });
  });
});

describe('defaultExecutionAuthorizer — high-risk (money) tier', () => {
  it('human_approval_required for a high-risk action with no approval record', () => {
    const intent = approvedHighRiskIntent(); // AddCredit, high
    const d = defaultExecutionAuthorizer(
      prodReq({ intent, prodAuthorizedActions: [intent.action] }),
      () => false
    );
    expect(d).toEqual({ allowed: false, reason: 'human_approval_required' });
  });

  it('amount_cap_exceeded when approved but caps default to 0', () => {
    const intent = approvedHighRiskIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({
        intent,
        prodAuthorizedActions: [intent.action],
        humanApproval: { approver: 'ops@securiace', at: new Date().toISOString() },
        amountContext: { amount: 50, dayTotal: 0 },
        // caps omitted ⇒ default { 0, 0 }
      }),
      () => false
    );
    expect(d).toEqual({ allowed: false, reason: 'amount_cap_exceeded' });
  });

  it('amount_cap_exceeded when no amountContext for a high-risk action', () => {
    const intent = approvedHighRiskIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({
        intent,
        prodAuthorizedActions: [intent.action],
        humanApproval: { approver: 'ops', at: 'now' },
        caps: { perAction: 100, daily: 1000 },
        // amountContext omitted
      }),
      () => false
    );
    expect(d).toEqual({ allowed: false, reason: 'amount_cap_exceeded' });
  });

  it('amount_cap_exceeded when over the per-action cap', () => {
    const intent = approvedHighRiskIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({
        intent,
        prodAuthorizedActions: [intent.action],
        humanApproval: { approver: 'ops', at: 'now' },
        amountContext: { amount: 250, dayTotal: 0 },
        caps: { perAction: 100, daily: 1000 },
      }),
      () => false
    );
    expect(d).toEqual({ allowed: false, reason: 'amount_cap_exceeded' });
  });

  it('amount_cap_exceeded when over the daily cap', () => {
    const intent = approvedHighRiskIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({
        intent,
        prodAuthorizedActions: [intent.action],
        humanApproval: { approver: 'ops', at: 'now' },
        amountContext: { amount: 80, dayTotal: 950 },
        caps: { perAction: 100, daily: 1000 },
      }),
      () => false
    );
    expect(d).toEqual({ allowed: false, reason: 'amount_cap_exceeded' });
  });

  it('allows a high-risk action with approval + within both caps', () => {
    const intent = approvedHighRiskIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({
        intent,
        prodAuthorizedActions: [intent.action],
        humanApproval: { approver: 'ops', at: 'now' },
        amountContext: { amount: 80, dayTotal: 100 },
        caps: { perAction: 100, daily: 1000 },
      }),
      () => false
    );
    expect(d).toEqual({ allowed: true });
  });

  it('human_approval_required precedes the cap check', () => {
    const intent = approvedHighRiskIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({
        intent,
        prodAuthorizedActions: [intent.action],
        amountContext: { amount: 999999, dayTotal: 0 },
        caps: { perAction: 1, daily: 1 },
      }),
      () => false
    );
    expect(d).toEqual({ allowed: false, reason: 'human_approval_required' });
  });
});
