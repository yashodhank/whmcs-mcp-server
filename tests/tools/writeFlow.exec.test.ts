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
beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([{
    id: 'devexec', token_sha256: sha(RAW), allowedScopes: ['read'],
    defaultContract: 'ops_operator', allowedContracts: ['ops_operator'],
    allowedActions: [], writeCapability: 'execution_allowed',
    envRestrictions: [], anonymous: false,
    allowedWriteScopes: ['ticket:reply', 'billing:credit:add'],
  }]);
  process.env.MCP_WRITE_EXECUTION_AUTHORIZED = 'AddTicketReply,AddCredit';
});
vi.mock('../../src/config.js', () => ({
  config: { MCP_MODE: 'full', MCP_ENV: 'local', MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';

interface Res { content: { text: string }[]; isError?: boolean }
const J = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown) => v as Record<string, unknown>;
function harness() {
  const h: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
  const server = { registerTool: (n: string, _c: unknown, cb: unknown) => { h[n] = cb as never; } };
  const cl = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => cl };
  const mutate = vi.fn().mockResolvedValue({ result: 'success' });
  const read = vi.fn().mockResolvedValue({ result: 'success' });
  registerWriteFlowTools(server as never, { mutate, read } as never, { child: () => cl } as never, { tryConsume: () => true } as never);
  return { h, mutate, read };
}
const tok = { auth_token: RAW };

async function approved(h: Record<string, (a: Record<string, unknown>) => Promise<Res>>, scope: string, params: Record<string, unknown>, nk: string) {
  const d = await h.draft_write_intent({ scope, params, naturalKey: nk, projected_effect: scope, ...tok });
  const id = rec(J(d).intent).intent_id as string;
  await h.validate_write_intent({ intent_id: id, ...tok });
  await h.approve_write_intent({ intent_id: id, approver: 'op', decision: 'approved', ...tok });
  return id;
}

describe('Phase G — dev/staging gated execution', () => {
  it('low-risk ticket:reply with all gates green ⇒ ACTUALLY executes (mutate called once)', async () => {
    const { h, mutate } = harness();
    const id = await approved(h, 'ticket:reply', { ticketid: 1, message: 'devexec reply' }, 'exec-reply-1');
    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(true);
    expect(rec(ep.execution).attempted).toBe(true);
    expect(rec(ep.execution).blocked_reason).toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith('AddTicketReply', { ticketid: 1, message: 'devexec reply' });
    expect(['executed', 'verified']).toContain(rec(ep.intent).state);
  });

  it('billing:credit:add stays intent/validate-only even with all gates ⇒ NOT executed', async () => {
    const { h, mutate } = harness();
    const id = await approved(h, 'billing:credit:add', { clientid: 1, amount: '5.00' }, 'exec-credit-1');
    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).blocked_reason).toBe('action_not_low_risk_executable');
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
    const cl = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => cl };
    const hh: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
    registerWriteFlowTools(
      { registerTool: (n: string, _c: unknown, cb: unknown) => { hh[n] = cb as never; } } as never,
      { mutate: fail, read: vi.fn() } as never,
      { child: () => cl } as never,
      { tryConsume: () => true } as never
    );
    const id = await approved(hh, 'ticket:reply', { ticketid: 2, message: 'will fail' }, 'exec-fail-1');
    const e = await hh.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).attempted).toBe(true);
    expect(rec(ep.intent).state).toBe('failed');
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
