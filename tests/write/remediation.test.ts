/**
 * Tests for the structured remediation module.
 */
import { describe, it, expect } from 'vitest';
import { remediationForDeny, buildPreflight, type PreflightContext } from '../../src/write/remediation.js';

describe('remediationForDeny', () => {
  it('returns kill_switch remediation', () => {
    const steps = remediationForDeny('kill_switch_engaged');
    expect(steps.length).toBe(1);
    expect(steps[0].code).toBe('kill_switch');
  });

  it('returns mode_read_only remediation', () => {
    const steps = remediationForDeny('read_only_mode');
    expect(steps.length).toBe(1);
    expect(steps[0].code).toBe('mode_read_only');
  });

  it('returns needs_approval remediation with next_tool', () => {
    const steps = remediationForDeny('intent_not_approved');
    expect(steps[0].code).toBe('needs_approval');
    expect(steps[0].next_tool).toBe('approve_write_intent');
  });

  it('returns not_allowlisted remediation with file source', () => {
    const ctx: PreflightContext = {
      allowlistSource: 'file',
      allowlistPath: '/etc/mcp/allowed.json',
      prodAuthorizedActions: [],
      action: 'AddCredit',
      scope: 'billing:credit:add',
    };
    const steps = remediationForDeny('action_not_prod_authorized', ctx);
    expect(steps[0].code).toBe('not_allowlisted');
    expect(steps[0].message).toContain('/etc/mcp/allowed.json');
    expect(steps[0].message).toContain('no restart');
    expect(steps[0].next_tool).toBe('get_write_posture');
  });

  it('returns not_allowlisted remediation with env source', () => {
    const ctx: PreflightContext = {
      allowlistSource: 'env',
      prodAuthorizedActions: ['SomeOtherAction'],
      action: 'AddCredit',
      scope: 'billing:credit:add',
    };
    const steps = remediationForDeny('action_not_prod_authorized', ctx);
    expect(steps[0].message).toContain('MCP_PROD_WRITE_AUTHORIZED');
    expect(steps[0].message).toContain('restart');
  });

  it('returns not_allowlisted remediation with empty source', () => {
    const ctx: PreflightContext = {
      allowlistSource: 'empty',
      prodAuthorizedActions: [],
      action: 'AddCredit',
      scope: 'billing:credit:add',
    };
    const steps = remediationForDeny('action_not_prod_authorized', ctx);
    expect(steps[0].message).toContain('MCP_PROD_WRITE_AUTHORIZED_FILE');
  });

  it('returns cap_exceeded remediation with caps and amount context', () => {
    const ctx: PreflightContext = {
      allowlistSource: 'empty',
      prodAuthorizedActions: [],
      action: 'AddCredit',
      scope: 'billing:credit:add',
      capsPerAction: 100,
      capsDaily: 500,
      intentAmount: 200,
    };
    const steps = remediationForDeny('amount_cap_exceeded', ctx);
    expect(steps[0].code).toBe('cap_exceeded');
    expect(steps[0].message).toContain('per_action_cap=100');
    expect(steps[0].message).toContain('daily_cap=500');
    expect(steps[0].message).toContain('intent_amount=200');
    expect(steps[0].next_tool).toBe('get_write_posture');
  });

  it('returns cap_exceeded remediation with zero-note when caps are 0', () => {
    const ctx: PreflightContext = {
      allowlistSource: 'empty',
      prodAuthorizedActions: [],
      action: 'AddCredit',
      scope: 'billing:credit:add',
      capsPerAction: 0,
      capsDaily: 0,
    };
    const steps = remediationForDeny('amount_cap_exceeded', ctx);
    expect(steps[0].message).toContain('default to 0');
    expect(steps[0].message).toContain('deny-all');
  });

  it('returns cap_exceeded remediation without context (backward compat)', () => {
    const steps = remediationForDeny('amount_cap_exceeded');
    expect(steps[0].code).toBe('cap_exceeded');
    expect(steps[0].next_tool).toBe('get_write_posture');
  });

  it('returns generic remediation for unknown reasons', () => {
    const steps = remediationForDeny('verification_failed');
    expect(steps[0].code).toBe('other');
    expect(steps[0].next_tool).toBe('get_write_posture');
  });
});

describe('buildPreflight', () => {
  const ctx: PreflightContext = {
    allowlistSource: 'empty',
    prodAuthorizedActions: [],
    action: 'AddCredit',
    scope: 'billing:credit:add',
  };

  it('returns would_allow:true when decision.allowed', () => {
    const pf = buildPreflight({ allowed: true }, ctx);
    expect(pf.would_allow).toBe(true);
    expect(pf.blocked_reason).toBeUndefined();
    expect(pf.remediation).toEqual([]);
    expect(pf.allowlist_source).toBe('empty');
  });

  it('returns would_allow:false with missing_allowlist for prod denial', () => {
    const pf = buildPreflight(
      { allowed: false, reason: 'action_not_prod_authorized' },
      ctx
    );
    expect(pf.would_allow).toBe(false);
    expect(pf.blocked_reason).toBe('action_not_prod_authorized');
    expect(pf.missing_allowlist).toBeDefined();
    expect(pf.missing_allowlist!.length).toBeGreaterThan(0);
    expect(pf.missing_allowlist).toContain('billing:credit:add');
    expect(pf.remediation.length).toBeGreaterThan(0);
  });

  it('does not set missing_allowlist for non-allowlist denials', () => {
    const pf = buildPreflight(
      { allowed: false, reason: 'read_only_mode' },
      ctx
    );
    expect(pf.missing_allowlist).toBeUndefined();
  });
});
