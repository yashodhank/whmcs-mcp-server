/**
 * KEYSTONE INVARIANT (tiered-friction): HIGH-RISK production is SEALED BY
 * DEFAULT. Even when EVERY other gate is green (mode=full, consumer
 * execution_allowed, intent approved), with no MCP_PROD_WRITE_AUTHORIZED
 * configured a high-risk request is denied `action_not_prod_authorized` and
 * WHMCS mutate is NEVER called. (Low/medium scopes are audit-gated and DO
 * execute here — covered in tests/write/executionGate.test.ts.)
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = 'EXAMPLE-prodexec-SYNTHETIC';
beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'prodexec',
      token_sha256: sha(RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: ['billing:credit:add'],
    },
  ]);
  // Even with the action runtime-authorized AND mode=full, production must block
  // a HIGH-RISK action when the prod allowlist is empty.
  process.env.MCP_WRITE_EXECUTION_AUTHORIZED = 'AddCredit';
});
vi.mock('../../src/config.js', () => ({
  config: { MCP_MODE: 'full', MCP_ENV: 'production', MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';

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
  const mutate = vi.fn();
  const read = vi.fn();
  registerWriteFlowTools(
    server as never,
    { mutate, read } as never,
    { child: () => cl } as never,
    { tryConsume: () => true } as never
  );
  return { h, mutate, read };
}
const tok = { auth_token: RAW };

describe('Phase G+ — HIGH-RISK production sealed by default (empty prod allowlist)', () => {
  it('high-risk: every gate green + mode=full + execution_allowed + approved ⇒ STILL blocked, zero mutate', async () => {
    const { h, mutate, read } = harness();
    const d = await h.draft_write_intent({
      scope: 'billing:credit:add',
      params: { clientid: 1, amount: 50, description: 'x' },
      naturalKey: 'prod-1',
      projected_effect: 'credit',
      ...tok,
    });
    const id = rec(J(d).intent).intent_id as string;
    await h.validate_write_intent({ intent_id: id, ...tok });
    const a = await h.approve_write_intent({
      intent_id: id,
      approver: 'op',
      decision: 'approved',
      ...tok,
    });
    expect(rec(J(a).intent).state).toBe('approved');

    const e = await h.execute_write_intent({ intent_id: id, ...tok });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).attempted).toBe(false);
    expect(rec(ep.execution).blocked_reason).toBe('action_not_prod_authorized');
    // KEYSTONE: with no prod allowlist configured, no WHMCS mutation occurs.
    expect(mutate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
