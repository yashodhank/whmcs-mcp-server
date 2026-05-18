/**
 * Phase G SAFETY INVARIANT: production can NEVER execute, even when EVERY
 * other gate is green (mode=full, consumer execution_allowed, action
 * runtime-authorized, intent approved, low-risk action). The production
 * hard-gate is checked first and absolutely. WHMCS mutate is NEVER called.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = 'EXAMPLE-prodexec-SYNTHETIC';
beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([{
    id: 'prodexec', token_sha256: sha(RAW), allowedScopes: ['read'],
    defaultContract: 'ops_operator', allowedContracts: ['ops_operator'],
    allowedActions: [], writeCapability: 'execution_allowed',
    envRestrictions: [], anonymous: false, allowedWriteScopes: ['ticket:reply'],
  }]);
  // Even with the action runtime-authorized AND mode=full, production must block.
  process.env.MCP_WRITE_EXECUTION_AUTHORIZED = 'AddTicketReply';
});
vi.mock('../../src/config.js', () => ({
  config: { MCP_MODE: 'full', MCP_ENV: 'production', MCP_MAX_PAGE_SIZE: 100 },
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
  const mutate = vi.fn();
  const read = vi.fn();
  registerWriteFlowTools(server as never, { mutate, read } as never, { child: () => cl } as never, { tryConsume: () => true } as never);
  return { h, mutate, read };
}
const tok = { auth_token: RAW };

describe('Phase G — production execution is absolutely forbidden', () => {
  it('every gate green + mode=full + execution_allowed + approved ⇒ STILL blocked, zero mutate', async () => {
    const { h, mutate, read } = harness();
    const d = await h.draft_write_intent({ scope: 'ticket:reply', params: { ticketid: 1, message: 'hi' }, naturalKey: 'prod-1', projected_effect: 'reply', ...tok });
    const id = rec(J(d).intent).intent_id as string;
    await h.validate_write_intent({ intent_id: id, ...tok });
    const a = await h.approve_write_intent({ intent_id: id, approver: 'op', decision: 'approved', ...tok });
    expect(rec(J(a).intent).state).toBe('approved');

    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).attempted).toBe(false);
    expect(rec(ep.execution).blocked_reason).toBe('production_execution_forbidden');
    // THE PHASE G INVARIANT: no WHMCS mutation in production, ever.
    expect(mutate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
