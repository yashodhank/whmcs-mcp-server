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
import {
  defaultExecutionAuthorizer,
  preAuthorizeIntent,
  allowlistAuthorizes,
} from '../../src/write/executionGate.js';
import type { ExecutionRequest, WriteIntent, WriteScope } from '../../src/write/types.js';

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

  it('denies action_not_runtime_authorized when a HIGH-RISK action is absent from allowlist', () => {
    // Tiered: only high-risk (or strictAllowlist) is allowlist-gated.
    const d = defaultExecutionAuthorizer(
      fullyOpenReq({ intent: approvedHighRiskIntent(), runtimeAuthorizedActions: [] })
    );
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

describe('defaultExecutionAuthorizer — keystone invariant (high-risk scope)', () => {
  // Tiered-friction: the keystone now seals HIGH-RISK by default. Low/medium
  // are audit-gated and intentionally execute without an allowlist (see the
  // tiered-friction describe below).
  it('KEYSTONE: no new env ⇒ HIGH-RISK production SEALED', () => {
    const d = defaultExecutionAuthorizer(prodReq({ intent: approvedHighRiskIntent() }), () => false);
    expect(d).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('KEYSTONE: explicit empty prodAuthorizedActions ⇒ high-risk still sealed', () => {
    const d = defaultExecutionAuthorizer(
      prodReq({ intent: approvedHighRiskIntent(), prodAuthorizedActions: [] }),
      () => false
    );
    expect(d).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('legacy default posture (prod, read_only) still denies', () => {
    expect(defaultExecutionAuthorizer(prodReq({ mcpMode: 'read_only' })).allowed).toBe(false);
  });
});

describe('defaultExecutionAuthorizer — tiered friction (low/medium audit-gated)', () => {
  it('LOW-risk scope executes in production with an EMPTY allowlist (audit-gated)', () => {
    // client_note:write (low) — no prod allowlist, no approval, no caps.
    const d = defaultExecutionAuthorizer(prodReq(), () => false);
    expect(d).toEqual({ allowed: true });
  });

  it('MEDIUM-risk scope executes in production with an EMPTY allowlist', () => {
    const med = approvedScopeIntent('service:domain_rename', {
      serviceid: 1,
      domain: 'a.example.com',
    });
    const d = defaultExecutionAuthorizer(prodReq({ intent: med }), () => false);
    expect(d).toEqual({ allowed: true });
  });

  it('but the universal gates still apply to low/medium (kill switch, read_only, consumer, replay)', () => {
    expect(defaultExecutionAuthorizer(prodReq({ killSwitch: true })).allowed).toBe(false);
    expect(defaultExecutionAuthorizer(prodReq({ mcpMode: 'read_only' })).allowed).toBe(false);
    expect(
      defaultExecutionAuthorizer(prodReq({ consumerWriteCapability: 'draft_only' })).allowed
    ).toBe(false);
    expect(defaultExecutionAuthorizer(prodReq(), () => true)).toEqual({
      allowed: false,
      reason: 'idempotency_replay',
    });
  });

  it('strictAllowlist=true restores allowlist enforcement for a LOW-risk scope', () => {
    const d = defaultExecutionAuthorizer(prodReq({ strictAllowlist: true }), () => false);
    expect(d).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('strictAllowlist=true + scope in allowlist ⇒ low-risk allowed again', () => {
    const intent = approvedIntent();
    const d = defaultExecutionAuthorizer(
      prodReq({ intent, strictAllowlist: true, prodAuthorizedActions: [intent.scope] }),
      () => false
    );
    expect(d).toEqual({ allowed: true });
  });

  it('strictScopes forces a medium scope to require the allowlist (e.g. billing:invoice:create)', () => {
    const inv = approvedScopeIntent('billing:invoice:create', {
      userid: 1,
      items: [{ description: 'x', amount: 10 }],
    });
    // Not in allowlist + listed in strictScopes ⇒ sealed.
    expect(
      defaultExecutionAuthorizer(
        prodReq({ intent: inv, strictScopes: ['billing:invoice:create'] }),
        () => false
      )
    ).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
    // Same scope NOT in strictScopes ⇒ audit-gated (medium) ⇒ allowed.
    expect(
      defaultExecutionAuthorizer(prodReq({ intent: inv, strictScopes: [] }), () => false)
    ).toEqual({ allowed: true });
    // In strictScopes BUT also in the allowlist ⇒ allowed.
    expect(
      defaultExecutionAuthorizer(
        prodReq({
          intent: inv,
          strictScopes: ['billing:invoice:create'],
          prodAuthorizedActions: ['billing:invoice:create'],
        }),
        () => false
      )
    ).toEqual({ allowed: true });
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

  it('action_not_prod_authorized when a HIGH-RISK action is absent from prod allowlist', () => {
    const d = defaultExecutionAuthorizer(
      prodReq({ intent: approvedHighRiskIntent(), prodAuthorizedActions: ['SomethingElse'] })
    );
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

  it('SCOPE-level permanent block: a blocked scope is denied even with a safe action + allowlist', () => {
    // service:terminate is reserved-blocked; its action could be a non-blocked
    // Module* string yet the scope still hard-blocks. Fully-open + allowlisted.
    const base = approvedIntent();
    const blockedScope: WriteIntent = {
      ...base,
      scope: 'service:terminate' as WriteScope,
      action: 'UpdateClientProduct', // a non-permanently-blocked action
    };
    const d = defaultExecutionAuthorizer(
      prodReq({ intent: blockedScope, prodAuthorizedActions: ['service:terminate', 'UpdateClientProduct'] })
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

/* ───────  Per-scope allowlist gating: two scopes, one WHMCS action  ──────── */

function approvedScopeIntent(scope: WriteScope, params: Record<string, unknown>): WriteIntent {
  const store = new IntentStore();
  const intent = createDraftIntent({
    consumer_id: 'c1',
    scope,
    params,
    naturalKey: `k-${scope}`,
    preconditions: {},
    projected_effect: scope,
  });
  store.put(intent);
  store.transition(intent.intent_id, 'validated');
  return store.transition(intent.intent_id, 'approved');
}

// Both scopes map to the SAME WHMCS action (UpdateClientProduct); they must be
// independently gateable via their scope strings.
const domainRename = (): WriteIntent =>
  approvedScopeIntent('service:domain_rename', { serviceid: 1, domain: 'a.example.com' });
const priceRestore = (): WriteIntent =>
  approvedScopeIntent('service:price_restore', { targets: [{ serviceid: 1, new_amount: 100 }] });

describe('allowlistAuthorizes — action OR scope semantics', () => {
  it('matches on the bare WHMCS action (BROAD grant)', () => {
    expect(allowlistAuthorizes(['UpdateClientProduct'], 'UpdateClientProduct', 'service:x')).toBe(
      true
    );
  });
  it('matches on the write scope (NARROW grant)', () => {
    expect(allowlistAuthorizes(['service:domain_rename'], 'UpdateClientProduct', 'service:domain_rename')).toBe(
      true
    );
  });
  it('an empty allowlist matches nothing (sealed)', () => {
    expect(allowlistAuthorizes([], 'UpdateClientProduct', 'service:domain_rename')).toBe(false);
  });
  it('a scope entry does NOT authorize a sibling scope on the same action', () => {
    expect(
      allowlistAuthorizes(['service:price_restore'], 'UpdateClientProduct', 'service:domain_rename')
    ).toBe(false);
  });
});

describe('preAuthorizeIntent — independent gating of UpdateClientProduct scopes', () => {
  it('NARROW grant of service:domain_rename does NOT authorize service:price_restore', () => {
    const allow = ['service:domain_rename'];
    expect(
      preAuthorizeIntent(prodReq({ intent: domainRename(), prodAuthorizedActions: allow }))
    ).toEqual({ allowed: true });
    expect(
      preAuthorizeIntent(prodReq({ intent: priceRestore(), prodAuthorizedActions: allow }))
    ).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('NARROW grant of service:price_restore does NOT authorize service:domain_rename', () => {
    const allow = ['service:price_restore'];
    expect(
      preAuthorizeIntent(prodReq({ intent: priceRestore(), prodAuthorizedActions: allow }))
    ).toEqual({ allowed: true });
    // domain_rename is MEDIUM (audit-gated) — under tiered friction it isn't
    // allowlist-gated at all. To assert the SCOPE separation we force strict
    // mode so the medium scope is allowlist-checked too; the price_restore
    // grant must still not authorize it.
    expect(
      preAuthorizeIntent(
        prodReq({ intent: domainRename(), prodAuthorizedActions: allow, strictAllowlist: true })
      )
    ).toEqual({ allowed: false, reason: 'action_not_prod_authorized' });
  });

  it('BROAD grant of the bare action authorizes BOTH scopes (backward compatible)', () => {
    const allow = ['UpdateClientProduct'];
    expect(
      preAuthorizeIntent(prodReq({ intent: domainRename(), prodAuthorizedActions: allow }))
    ).toEqual({ allowed: true });
    expect(
      preAuthorizeIntent(prodReq({ intent: priceRestore(), prodAuthorizedActions: allow }))
    ).toEqual({ allowed: true });
  });

  it('same separation holds on the non-prod runtime allowlist', () => {
    expect(
      preAuthorizeIntent(
        fullyOpenReq({ intent: domainRename(), runtimeAuthorizedActions: ['service:domain_rename'] })
      )
    ).toEqual({ allowed: true });
    expect(
      preAuthorizeIntent(
        fullyOpenReq({ intent: priceRestore(), runtimeAuthorizedActions: ['service:domain_rename'] })
      )
    ).toEqual({ allowed: false, reason: 'action_not_runtime_authorized' });
  });

  it('defaultExecutionAuthorizer: medium-risk domain_rename allowed under its scope grant', () => {
    // domain_rename is medium ⇒ no money tier; a scope grant fully authorizes it.
    const d = defaultExecutionAuthorizer(
      prodReq({ intent: domainRename(), prodAuthorizedActions: ['service:domain_rename'] }),
      () => false
    );
    expect(d).toEqual({ allowed: true });
  });
});
