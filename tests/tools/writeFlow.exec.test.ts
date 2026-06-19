/**
 * Phase G: dev/staging gated execution. With env=local + mode=full +
 * consumer execution_allowed + action runtime-authorized + approved
 * intent, a LOW-RISK ticket/note action actually executes (whmcs.mutate
 * called); billing/etc. stay intent/validate-only even with all gates;
 * replay is blocked.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = 'EXAMPLE-devexec-SYNTHETIC';
const APPROVER_RAW = 'EXAMPLE-devapprover-SYNTHETIC';
beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'devexec',
      token_sha256: sha(RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: ['ticket:reply', 'billing:credit:add'],
    },
    {
      // Distinct approver for separation-of-duties (plan 011). Drafts/approves
      // but does not execute; MUST be authorized for the scopes it approves.
      id: 'devapprover',
      token_sha256: sha(APPROVER_RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'approval_required',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: ['ticket:reply', 'billing:credit:add'],
    },
  ]);
  process.env.MCP_WRITE_EXECUTION_AUTHORIZED = 'AddTicketReply,AddCredit';
});
vi.mock('../../src/config.js', () => ({
  config: {
    MCP_MODE: 'full',
    MCP_ENV: 'local',
    MCP_MAX_PAGE_SIZE: 100,
    // Separation-of-duties flag — high-risk distinctness is enforced by the gate
    // regardless; set true here to also exercise low/medium when relevant.
    MCP_WRITE_REQUIRE_DISTINCT_APPROVER: true,
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';
import { __resetRegistryCacheForTests } from '../../src/governance/pipeline.js';

interface Res {
  content: { text: string }[];
  isError?: boolean;
}
const J = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown) => v as Record<string, unknown>;
function harness() {
  const h: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
  const server = {
    registerTool: (n: string, _c: unknown, cb: unknown) => {
      h[n] = cb as never;
    },
  };
  const cl = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => cl,
  };
  const mutate = vi.fn().mockResolvedValue({ result: 'success' });
  const read = vi.fn().mockResolvedValue({ result: 'success' });
  registerWriteFlowTools(
    server as never,
    { mutate, read } as never,
    { child: () => cl } as never,
    { tryConsume: () => true } as never
  );
  return { h, mutate, read };
}
const tok = { auth_token: RAW };
const approverTok = { auth_token: APPROVER_RAW };

async function approved(
  h: Record<string, (a: Record<string, unknown>) => Promise<Res>>,
  scope: string,
  params: Record<string, unknown>,
  nk: string,
  // The token used to APPROVE. Defaults to a DISTINCT approver (devapprover) so
  // separation of duties is satisfied; pass `tok` to force self-approval.
  approveTok: { auth_token: string } = approverTok
) {
  const d = await h.draft_write_intent({
    scope,
    params,
    naturalKey: nk,
    projected_effect: scope,
    ...tok,
  });
  const id = rec(J(d).intent).intent_id as string;
  await h.validate_write_intent({ intent_id: id, ...tok });
  await h.approve_write_intent({
    intent_id: id,
    approver: 'op',
    decision: 'approved',
    ...approveTok,
  });
  return id;
}

describe('Phase G — dev/staging gated execution', () => {
  it('low-risk ticket:reply with all gates green ⇒ ACTUALLY executes (mutate called once)', async () => {
    const { h, mutate } = harness();
    const id = await approved(
      h,
      'ticket:reply',
      { ticketid: 1, message: 'devexec reply' },
      'exec-reply-1'
    );
    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(true);
    expect(rec(ep.execution).attempted).toBe(true);
    expect(rec(ep.execution).blocked_reason).toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith('AddTicketReply', {
      ticketid: 1,
      message: 'devexec reply',
    });
    expect(['executed', 'verified']).toContain(rec(ep.intent).state);
  });

  it('billing:credit:add (high-risk) is denied without configured caps ⇒ NOT executed; no `amountin` ever set', async () => {
    // Phase G+: high-risk money actions need a human approval record (present
    // — approve() was called) AND explicitly-configured caps. The test config
    // mock sets no caps ⇒ caps coerce to 0 ⇒ amount_cap_exceeded, zero mutate.
    // The param mapper would have produced WHMCS-shape `AddCredit` params
    // (clientid/amount/description) — verifying it is never called at all.
    const { h, mutate } = harness();
    const id = await approved(
      h,
      'billing:credit:add',
      { clientid: 1, amount: '5.00', description: 'goodwill' },
      'exec-credit-1'
    );
    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).blocked_reason).toBe('amount_cap_exceeded');
    expect(mutate).not.toHaveBeenCalled();
    // Negative assertion: phantom-revenue guard — `amountin` must NEVER appear
    // on any path the mapper produces (defence-in-depth even though mutate is
    // not called here).
    for (const call of mutate.mock.calls) {
      expect(call[1]).not.toHaveProperty('amountin');
    }
  });

  it('billing:credit:add self-approved by the drafter ⇒ blocked self_approval_forbidden, mutate never called', async () => {
    // Separation of duties (plan 011): devexec drafts/validates AND approves its
    // OWN high-risk intent. The gate's step-8 distinctness rule must reject this
    // BEFORE the caps check, so blocked_reason is self_approval_forbidden.
    const { h, mutate } = harness();
    const id = await approved(
      h,
      'billing:credit:add',
      { clientid: 1, amount: '5.00', description: 'self-approve attempt' },
      'exec-credit-self-1',
      tok // self-approve with the SAME (drafter) token
    );
    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).blocked_reason).toBe('self_approval_forbidden');
    expect(rec(ep.intent).state).toBe('execution_blocked');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('idempotency replay: re-executing the same intent is blocked, mutate not called twice', async () => {
    const { h, mutate } = harness();
    const id = await approved(h, 'ticket:reply', { ticketid: 9, message: 'once' }, 'exec-replay-1');
    const e1 = await h.execute_write_intent({ intent_id: id, ...tok });
    expect(J(e1).executed).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(1);
    const e2 = await h.execute_write_intent({ intent_id: id, ...tok });
    // second attempt: intent is no longer 'approved' (it's executed/verified)
    // so it is denied without a second mutation.
    expect(J(e2).executed).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('a mutate failure ⇒ intent.failed, executed:false, structured', async () => {
    // dedicated registration with a throwing mutate
    const fail = vi.fn().mockRejectedValue(new Error('whmcs boom'));
    const cl = {
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      child: () => cl,
    };
    const hh: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
    registerWriteFlowTools(
      {
        registerTool: (n: string, _c: unknown, cb: unknown) => {
          hh[n] = cb as never;
        },
      } as never,
      { mutate: fail, read: vi.fn() } as never,
      { child: () => cl } as never,
      { tryConsume: () => true } as never
    );
    const id = await approved(
      hh,
      'ticket:reply',
      { ticketid: 2, message: 'will fail' },
      'exec-fail-1'
    );
    const e = await hh.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).attempted).toBe(true);
    expect(rec(ep.intent).state).toBe('failed');
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('SCOPE-3: scope revoked after approval ⇒ execution_blocked scope_not_allowed, mutate never called', async () => {
    // Draft+validate+approve with the scope GRANTED (all other gates green), so
    // the intent reaches the approved state exactly like the happy path.
    const { h, mutate } = harness();
    const id = await approved(
      h,
      'ticket:reply',
      { ticketid: 7, message: 'reply before revocation' },
      'exec-revoke-1'
    );
    // Revoke ticket:reply from devexec's CURRENT registry (same consumer_id so
    // the ownership check still passes), then force a registry re-resolve. This
    // simulates a scope grant pulled within the intent's TTL after approval.
    process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
      {
        id: 'devexec',
        token_sha256: sha(RAW),
        allowedScopes: ['read'],
        defaultContract: 'ops_operator',
        allowedContracts: ['ops_operator'],
        allowedActions: [],
        writeCapability: 'execution_allowed',
        envRestrictions: [],
        anonymous: false,
        allowedWriteScopes: ['billing:credit:add'], // ticket:reply REVOKED
      },
      {
        id: 'devapprover',
        token_sha256: sha(APPROVER_RAW),
        allowedScopes: ['read'],
        defaultContract: 'ops_operator',
        allowedContracts: ['ops_operator'],
        allowedActions: [],
        writeCapability: 'approval_required',
        envRestrictions: [],
        anonymous: false,
        allowedWriteScopes: ['ticket:reply', 'billing:credit:add'],
      },
    ]);
    __resetRegistryCacheForTests();

    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).attempted).toBe(false);
    expect(rec(ep.execution).blocked_reason).toBe('scope_not_allowed');
    expect(rec(ep.intent).state).toBe('execution_blocked');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('SCOPE-3 regression: scope STILL granted at execute time ⇒ executes, mutate called once', async () => {
    // Explicit proof the new execute-time re-check does NOT block a still-granted
    // scope (devexec retains ticket:reply for the whole flow). setupEach restores
    // process.env after the revoke test, but the pipeline registry cache is NOT
    // auto-reset — clear it so this test reads the restored (granted) registry.
    __resetRegistryCacheForTests();
    const { h, mutate } = harness();
    const id = await approved(
      h,
      'ticket:reply',
      { ticketid: 8, message: 'still granted' },
      'exec-still-granted-1'
    );
    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(true);
    expect(rec(ep.execution).blocked_reason).toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
