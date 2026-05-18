import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = (id: string) => `EXAMPLE-${id}-SYNTHETIC`;
const entry = (id: string, cap: string, scopes: string[]) => ({
  id, token_sha256: sha(RAW(id)), allowedScopes: ['read'],
  defaultContract: 'ops_operator', allowedContracts: ['ops_operator'],
  allowedActions: [], writeCapability: cap, envRestrictions: [],
  anonymous: false, allowedWriteScopes: scopes,
});
beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    entry('writer', 'approval_required', ['client_note:write', 'ticket:create']),
    entry('drafter', 'draft_only', ['client_note:write']),
    entry('noscope', 'approval_required', []),
  ]);
});
vi.mock('../../src/config.js', () => ({
  config: { MCP_MODE: 'read_only', MCP_ENV: 'production', MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';

interface Res { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
function harness() {
  const handlers: Record<string, (a: Record<string, unknown>) => Res> = {};
  const configs: Record<string, { outputSchema?: Record<string, unknown> }> = {};
  const server = { registerTool: (n: string, c: unknown, cb: unknown) => { configs[n] = c as never; handlers[n] = cb as never; } };
  const childLogger = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger = { child: () => childLogger };
  const rl = { tryConsume: () => true };
  const mutate = vi.fn();
  const read = vi.fn();
  registerWriteFlowTools(server as never, { mutate, read } as never, logger as never, rl as never);
  return { handlers, configs, mutate, read };
}
const tok = (id: string) => ({ auth_token: RAW(id) });
const J = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;

describe('Phase F write-flow tools (read-only posture)', () => {
  it('registers the 5 flow tools', () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(
      ['approve_write_intent', 'draft_write_intent', 'execute_write_intent', 'get_write_intent', 'validate_write_intent'].sort()
    );
  });

  it('get_write_intent declares an outputSchema exposing intent + audit (regression: SDK must not drop audit)', () => {
    const { configs } = harness();
    const gi = configs.get_write_intent.outputSchema ?? {};
    expect(gi.intent).toBeDefined();
    expect(gi.audit).toBeDefined();
    // flow tools keep the result schema (no audit; has executed/would_call)
    const df = configs.draft_write_intent.outputSchema ?? {};
    expect(df.executed).toBeDefined();
    expect(df.would_call).toBeDefined();
    expect(df.audit).toBeUndefined();
  });

  it('unknown consumer is denied at draft (no intent)', () => {
    const { handlers } = harness();
    const r = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'x' }, naturalKey: 'k-unknown', projected_effect: 'add note', auth_token: 'bogus' });
    expect(r.isError).toBe(true);
    expect(J(r).error).toMatch(/consumer denied/i);
  });

  it('consumer without the write scope is denied (default-deny)', () => {
    const { handlers } = harness();
    const r = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'x' }, naturalKey: 'k-noscope', projected_effect: 'add note', ...tok('noscope') });
    expect(r.isError).toBe(true);
    expect(J(r).error).toMatch(/write scope denied|scope_not_allowed/i);
  });

  it('FULL FLOW never calls WHMCS mutate; execute is blocked in read-only posture', () => {
    const { handlers, mutate, read } = harness();
    const d = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 7, note: 'hello' }, naturalKey: 'flow-1', projected_effect: 'add client note', ...tok('writer') });
    expect(d.isError).toBeUndefined();
    const intent = (J(d).intent as Record<string, unknown>);
    const id = intent.intent_id as string;
    expect(J(d).executed).toBe(false);
    expect((J(d).would_call as Record<string, unknown>).action).toBe('AddClientNote');

    const v = handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    expect((J(v).validation as Record<string, unknown>).ok).toBe(true);

    const a = handlers.approve_write_intent({ intent_id: id, approver: 'op1', decision: 'approved', ...tok('writer') });
    expect((J(a).intent as Record<string, unknown>).state).toBe('approved');

    const e = handlers.execute_write_intent({ intent_id: id, ...tok('writer') });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect((ep.execution as Record<string, unknown>).attempted).toBe(false);
    expect((ep.execution as Record<string, unknown>).blocked_reason).toBe('read_only_mode');
    expect((ep.intent as Record<string, unknown>).state).toBe('execution_blocked');

    // THE INVARIANT: no WHMCS mutating call anywhere in the flow.
    expect(mutate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('execute without prior approval is blocked (intent_not_approved) — still no mutate', () => {
    const { handlers, mutate } = harness();
    const d = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 7, note: 'n' }, naturalKey: 'flow-noappr', projected_effect: 'note', ...tok('writer') });
    const id = (J(d).intent as Record<string, unknown>).intent_id as string;
    handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    const e = handlers.execute_write_intent({ intent_id: id, ...tok('writer') });
    expect((J(e).execution as Record<string, unknown>).blocked_reason).toBe('intent_not_approved');
    expect((J(e).intent as Record<string, unknown>).state).toBe('validated');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('draft_only consumer cannot approve', () => {
    const { handlers } = harness();
    const d = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-draftonly', projected_effect: 'note', ...tok('drafter') });
    const id = (J(d).intent as Record<string, unknown>).intent_id as string;
    handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });
    const a = handlers.approve_write_intent({ intent_id: id, approver: 'x', decision: 'approved', ...tok('drafter') });
    expect(a.isError).toBe(true);
    expect(J(a).error).toMatch(/not permitted to approve/i);
  });

  it('consumer isolation: one consumer cannot act on another consumer intent', () => {
    const { handlers } = harness();
    const d = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-iso', projected_effect: 'note', ...tok('writer') });
    const id = (J(d).intent as Record<string, unknown>).intent_id as string;
    const v = handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });
    expect(v.isError).toBe(true);
    expect(J(v).error).toMatch(/does not belong/i);
  });

  it('invalid params are rejected at validate (state=rejected), no mutate', () => {
    const { handlers, mutate } = harness();
    const d = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1 }, naturalKey: 'k-badparams', projected_effect: 'note', ...tok('writer') });
    const id = (J(d).intent as Record<string, unknown>).intent_id as string;
    const v = handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    expect((J(v).validation as Record<string, unknown>).ok).toBe(false);
    expect((J(v).intent as Record<string, unknown>).state).toBe('rejected');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('get_write_intent returns the intent + append-only audit trail', () => {
    const { handlers } = harness();
    const d = handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-audit', projected_effect: 'note', ...tok('writer') });
    const id = (J(d).intent as Record<string, unknown>).intent_id as string;
    handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    const g = handlers.get_write_intent({ intent_id: id, ...tok('writer') });
    const trail = J(g).audit as { event: string }[];
    expect(trail.map((x) => x.event)).toEqual(['intent.drafted', 'intent.validated']);
  });

  it('idempotency key is deterministic for same consumer+scope+naturalKey', () => {
    const { handlers } = harness();
    const mk = () => handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-idem-stable', projected_effect: 'note', ...tok('writer') });
    expect(J(mk()).idempotency_key).toBe(J(mk()).idempotency_key);
  });
});
