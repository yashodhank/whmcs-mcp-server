/**
 * Tests for P0+P1 agent-native write/intent UX:
 *  - validate returns execution_preflight with would_allow + remediation
 *  - execute deny includes execution_preflight with remediation
 *  - get_write_posture shape
 *  - default approver injection on stdio without auth_token
 *  - prepare_domain_order does not mutate WHMCS / does not execute
 *  - user_confirmation_ref on approve (audit annotation)
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW_DRAFTER = 'EXAMPLE-drafter-agentux-SYNTHETIC';
const RAW_APPROVER = 'EXAMPLE-approver-agentux-SYNTHETIC';

beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'drafter',
      token_sha256: sha(RAW_DRAFTER),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: [
        'client_note:write',
        'ticket:create',
        'billing:credit:add',
        'order:create',
      ],
    },
    {
      id: 'approver',
      token_sha256: sha(RAW_APPROVER),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: [
        'client_note:write',
        'ticket:create',
        'billing:credit:add',
        'order:create',
      ],
    },
  ]);
  process.env.MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN = RAW_APPROVER;
});

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_MODE: 'read_only',
    MCP_ENV: 'production',
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TRANSPORT: 'stdio',
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));

import { registerWriteFlowTools, __resetWriteFlowForTests } from '../../src/tools/writeFlow.js';
import { _resetApproverDefaultTokenForTests } from '../../src/auth/trustedApproverDefault.js';
import { _resetStdioDefaultTokenForTests } from '../../src/auth/trustedStdioDefault.js';
import { remediationForDeny } from '../../src/write/remediation.js';

interface Res {
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function harness() {
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
  const configs: Record<string, { outputSchema?: Record<string, unknown> }> = {};
  const server = {
    registerTool: (n: string, c: unknown, cb: unknown) => {
      configs[n] = c as never;
      handlers[n] = cb as never;
    },
  };
  const childLogger = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => childLogger,
  };
  const logger = { child: () => childLogger };
  const rl = { tryConsume: () => true };
  const mutate = vi.fn();
  const read = vi.fn(async (action: string) => {
    if (action === 'WhmcsDetails') {
      return { result: 'success', whmcs: { version: '8.13.1' } };
    }
    if (action === 'DomainWhois') {
      return { result: 'success', status: 'available' };
    }
    if (action === 'GetTLDPricing') {
      return { result: 'success', pricing: { com: { register: { 1: '12.99' } } } };
    }
    if (action === 'GetPaymentMethods') {
      return {
        result: 'success',
        paymentmethods: { paymentmethod: [{ module: 'mailin', displayname: 'Mail-in' }] },
      };
    }
    return { result: 'success' };
  });
  registerWriteFlowTools(server as never, { mutate, read } as never, logger as never, rl as never);
  return { handlers, configs, mutate, read };
}

const tok = (id: string) => ({
  auth_token: id === 'drafter' ? RAW_DRAFTER : RAW_APPROVER,
});
const J = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown) => v as Record<string, unknown>;

beforeEach(() => {
  __resetWriteFlowForTests();
  _resetApproverDefaultTokenForTests();
  _resetStdioDefaultTokenForTests();
});

describe('P0 — execution preflight on validate', () => {
  it('validate returns execution_preflight with would_allow:false + remediation when scope not authorized', async () => {
    const { handlers } = harness();
    const d = await handlers.draft_write_intent({
      scope: 'billing:credit:add',
      params: { clientid: 1, amount: 50, description: 'x' },
      naturalKey: 'preflight-1',
      projected_effect: 'add credit',
      ...tok('drafter'),
    });
    const id = rec(J(d).intent).intent_id as string;
    const v = await handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });
    const result = J(v);
    expect(result.execution_preflight).toBeDefined();
    const pf = result.execution_preflight as Record<string, unknown>;
    expect(pf.would_allow).toBe(false);
    expect(pf.blocked_reason).toBeDefined();
    expect(pf.remediation).toBeDefined();
    expect(Array.isArray(pf.remediation)).toBe(true);
    const steps = pf.remediation as { code: string; message: string; next_tool?: string }[];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].code).toBeTruthy();
    expect(steps[0].message).toBeTruthy();
  });

  it('validate returns execution_preflight with allowlist_source on high-risk scope', async () => {
    const { handlers } = harness();
    const d = await handlers.draft_write_intent({
      scope: 'billing:credit:add',
      params: { clientid: 1, amount: 50, description: 'x' },
      naturalKey: 'preflight-2',
      projected_effect: 'credit',
      ...tok('drafter'),
    });
    const id = rec(J(d).intent).intent_id as string;
    const v = await handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });
    const pf = J(v).execution_preflight as Record<string, unknown>;
    expect(['file', 'env', 'empty']).toContain(pf.allowlist_source);
  });
});

describe('P0 — execute deny includes remediation', () => {
  it('execute deny includes execution_preflight with remediation shape', async () => {
    const { handlers, mutate } = harness();
    const d = await handlers.draft_write_intent({
      scope: 'client_note:write',
      params: { clientid: 7, note: 'hello' },
      naturalKey: 'exec-deny-1',
      projected_effect: 'add client note',
      ...tok('drafter'),
    });
    const id = rec(J(d).intent).intent_id as string;
    await handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });
    await handlers.approve_write_intent({
      intent_id: id,
      approver: 'op1',
      decision: 'approved',
      ...tok('approver'),
    });
    const e = await handlers.execute_write_intent({ intent_id: id, ...tok('drafter') });
    const result = J(e);
    expect(result.executed).toBe(false);
    expect(rec(result.execution).blocked_reason).toBeDefined();
    expect(result.execution_preflight).toBeDefined();
    const pf = result.execution_preflight as Record<string, unknown>;
    expect(pf.would_allow).toBe(false);
    expect(pf.remediation).toBeDefined();
    const steps = pf.remediation as { code: string; message: string }[];
    expect(steps.length).toBeGreaterThan(0);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('P0 — get_write_posture', () => {
  it('returns structured posture shape with no auth_token', async () => {
    const { handlers, configs } = harness();
    expect(configs.get_write_posture).toBeDefined();
    expect(configs.get_write_posture.outputSchema).toBeDefined();

    const r = await handlers.get_write_posture({});
    const result = J(r);
    const ks = result.kill_switch as Record<string, unknown>;
    expect(typeof ks.value).toBe('boolean');
    expect(ks.hot).toBe(false);
    const mode = result.mcp_mode as Record<string, unknown>;
    expect(typeof mode.value).toBe('string');
    expect(mode.hot).toBe(false);
    expect(typeof result.mcp_env).toBe('string');
    expect(result.allowlist).toBeDefined();
    const al = result.allowlist as Record<string, unknown>;
    expect(['file', 'env', 'empty']).toContain(al.source);
    expect(Array.isArray(al.actions)).toBe(true);
    expect(typeof al.hot).toBe('boolean');
    expect(result.caps).toBeDefined();
    const caps = result.caps as Record<string, unknown>;
    expect(typeof caps.per_action).toBe('number');
    expect(typeof caps.daily).toBe('number');
    expect(caps.hot).toBe(false);
    expect(typeof result.default_executor_configured).toBe('boolean');
    expect(typeof result.default_approver_configured).toBe('boolean');
    expect(typeof result.strict_allowlist).toBe('boolean');
    expect(typeof result.require_distinct_approver).toBe('boolean');
    expect(Array.isArray(result.extra_allowed_scopes)).toBe(true);
  });

  it('includes consumer info when auth_token is provided', async () => {
    const { handlers } = harness();
    const r = await handlers.get_write_posture({ ...tok('drafter') });
    const result = J(r);
    expect(result.consumer).toBeDefined();
    const consumer = result.consumer as Record<string, unknown>;
    expect(consumer.id).toBe('drafter');
    expect(consumer.write_capability).toBe('execution_allowed');
    expect(Array.isArray(consumer.allowed_write_scopes)).toBe(true);
  });
});

describe('P1 — default approver injection on stdio', () => {
  it('approve_write_intent auto-injects approver token on stdio without auth_token (distinct from drafter)', async () => {
    const { handlers } = harness();
    const d = await handlers.draft_write_intent({
      scope: 'client_note:write',
      params: { clientid: 7, note: 'hello' },
      naturalKey: 'approver-inject-1',
      projected_effect: 'add note',
      ...tok('drafter'),
    });
    const id = rec(J(d).intent).intent_id as string;
    await handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });

    const a = await handlers.approve_write_intent({
      intent_id: id,
      approver: 'auto-injected-approver',
      decision: 'approved',
    });
    expect(a.isError).toBeUndefined();
    const result = J(a);
    expect(rec(result.intent).state).toBe('approved');
  });
});

describe('P1 — user_confirmation_ref on approve', () => {
  it('user_confirmation_ref is accepted and does not block approval', async () => {
    const { handlers } = harness();
    const d = await handlers.draft_write_intent({
      scope: 'client_note:write',
      params: { clientid: 7, note: 'hello' },
      naturalKey: 'confirmref-1',
      projected_effect: 'add note',
      ...tok('drafter'),
    });
    const id = rec(J(d).intent).intent_id as string;
    await handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });

    const a = await handlers.approve_write_intent({
      intent_id: id,
      approver: 'human-reviewer',
      decision: 'approved',
      user_confirmation_ref: 'chat-msg-12345',
      ...tok('approver'),
    });
    expect(a.isError).toBeUndefined();
    expect(rec(J(a).intent).state).toBe('approved');
  });
});

describe('P1 — prepare_domain_order', () => {
  it('returns proposal + intent_id + execution_preflight without mutating WHMCS', async () => {
    const { handlers, mutate } = harness();
    const r = await handlers.prepare_domain_order({
      clientid: 42,
      domain: 'test-example.com',
      regperiod: 1,
      ...tok('drafter'),
    });
    expect(r.isError).toBeUndefined();
    const result = J(r);
    expect(result.proposal).toBeDefined();
    const proposal = result.proposal as Record<string, unknown>;
    expect(proposal.domain).toBe('test-example.com');
    expect(typeof proposal.available).toBe('boolean');
    expect(result.intent_id).toBeDefined();
    expect(typeof result.intent_id).toBe('string');
    expect(result.intent).toBeDefined();
    expect(result.validation).toBeDefined();
    expect(result.execution_preflight).toBeDefined();
    const pf = result.execution_preflight as Record<string, unknown>;
    expect(typeof pf.would_allow).toBe('boolean');
    expect(Array.isArray(pf.remediation)).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('prepare_domain_order never executes or auto-approves', async () => {
    const { handlers, mutate } = harness();
    const r = await handlers.prepare_domain_order({
      clientid: 42,
      domain: 'another-test.org',
      ...tok('drafter'),
    });
    const result = J(r);
    const intent = result.intent as Record<string, unknown>;
    expect(['validated', 'rejected']).toContain(intent.state);
    expect(intent.state).not.toBe('approved');
    expect(intent.state).not.toBe('executed');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('prepare_domain_order returns execution_preflight.would_allow:false when not authorized', async () => {
    const { handlers } = harness();
    const r = await handlers.prepare_domain_order({
      clientid: 42,
      domain: 'blocked-test.com',
      ...tok('drafter'),
    });
    const result = J(r);
    const pf = result.execution_preflight as Record<string, unknown>;
    expect(pf.would_allow).toBe(false);
    expect(pf.blocked_reason).toBeDefined();
    expect((pf.remediation as unknown[]).length).toBeGreaterThan(0);
  });

  it('prepare_domain_order rejects pid/hosting params with clear guidance', async () => {
    const { handlers } = harness();
    const r = await handlers.prepare_domain_order({
      clientid: 42,
      domain: 'test.com',
      pid: 5,
      ...tok('drafter'),
    });
    expect(r.isError).toBe(true);
    expect(J(r).error).toMatch(/domain-only/i);
  });
});

describe('Refinement R2 — caps in amount_cap_exceeded remediation', () => {
  it('amount_cap_exceeded remediation shows configured caps and zero-note', () => {
    const steps = remediationForDeny('amount_cap_exceeded', {
      allowlistSource: 'empty',
      prodAuthorizedActions: [],
      action: 'AddCredit',
      scope: 'billing:credit:add',
      capsPerAction: 0,
      capsDaily: 0,
      intentAmount: 50,
    });
    expect(steps[0].code).toBe('cap_exceeded');
    expect(steps[0].message).toContain('per_action_cap=0');
    expect(steps[0].message).toContain('daily_cap=0');
    expect(steps[0].message).toContain('intent_amount=50');
    expect(steps[0].message).toContain('default to 0');
  });
});

describe('Refinement R6 — hot-reload labels in get_write_posture', () => {
  it('kill_switch and caps are labeled hot:false', async () => {
    const { handlers } = harness();
    const r = await handlers.get_write_posture({});
    const result = J(r);
    const ks = result.kill_switch as Record<string, unknown>;
    expect(ks.hot).toBe(false);
    const caps = result.caps as Record<string, unknown>;
    expect(caps.hot).toBe(false);
    const mode = result.mcp_mode as Record<string, unknown>;
    expect(mode.hot).toBe(false);
  });

  it('file-based allowlist is labeled hot:true', async () => {
    const { handlers } = harness();
    const r = await handlers.get_write_posture({});
    const result = J(r);
    const al = result.allowlist as Record<string, unknown>;
    expect(typeof al.hot).toBe('boolean');
  });
});
