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
// Read-only + production posture: BOTH gates active (production hard-gate
// is checked first, so execute is blocked production_execution_forbidden).
vi.mock('../../src/config.js', () => ({
  config: { MCP_MODE: 'read_only', MCP_ENV: 'production', MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';

interface Res { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
function harness() {
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
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
const rec = (v: unknown) => v as Record<string, unknown>;

describe('write-flow tools (read-only + production posture)', () => {
  it('registers the 5 flow tools', () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(
      ['approve_write_intent', 'draft_write_intent', 'execute_write_intent', 'get_write_intent', 'validate_write_intent'].sort()
    );
  });

  it('get_write_intent declares an outputSchema exposing intent + audit (regression)', () => {
    const { configs } = harness();
    const gi = configs.get_write_intent.outputSchema ?? {};
    expect(gi.intent).toBeDefined();
    expect(gi.audit).toBeDefined();
    const df = configs.draft_write_intent.outputSchema ?? {};
    expect(df.executed).toBeDefined();
    expect(df.would_call).toBeDefined();
    expect(df.audit).toBeUndefined();
  });

  it('every write-flow tool registers a non-empty outputSchema', () => {
    const { configs } = harness();
    for (const n of ['draft_write_intent', 'validate_write_intent', 'approve_write_intent', 'execute_write_intent', 'get_write_intent']) {
      expect(Object.keys(configs[n]?.outputSchema ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('unknown consumer is denied at draft (no intent)', async () => {
    const { handlers } = harness();
    const r = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'x' }, naturalKey: 'k-unknown', projected_effect: 'add note', auth_token: 'bogus' });
    expect(r.isError).toBe(true);
    expect(J(r).error).toMatch(/consumer denied/i);
  });

  it('consumer without the write scope is denied (default-deny)', async () => {
    const { handlers } = harness();
    const r = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'x' }, naturalKey: 'k-noscope', projected_effect: 'add note', ...tok('noscope') });
    expect(r.isError).toBe(true);
    expect(J(r).error).toMatch(/write scope denied|scope_not_allowed/i);
  });

  it('FULL FLOW: execute is hard-blocked in production; WHMCS mutate NEVER called', async () => {
    const { handlers, mutate, read } = harness();
    const d = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 7, note: 'hello' }, naturalKey: 'flow-1', projected_effect: 'add client note', ...tok('writer') });
    expect(d.isError).toBeUndefined();
    const id = rec(J(d).intent).intent_id as string;
    expect(J(d).executed).toBe(false);
    expect(rec(J(d).would_call).action).toBe('AddClientNote');

    const v = await handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    expect(rec(J(v).validation).ok).toBe(true);
    const a = await handlers.approve_write_intent({ intent_id: id, approver: 'op1', decision: 'approved', ...tok('writer') });
    expect(rec(J(a).intent).state).toBe('approved');

    const e = await handlers.execute_write_intent({ intent_id: id, ...tok('writer') });
    const ep = J(e);
    expect(ep.executed).toBe(false);
    expect(rec(ep.execution).attempted).toBe(false);
    // Production hard-gate is checked FIRST (before read_only).
    expect(rec(ep.execution).blocked_reason).toBe('production_execution_forbidden');
    expect(rec(ep.intent).state).toBe('execution_blocked');
    expect(mutate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('execute without prior approval is blocked (intent_not_approved) — no mutate', async () => {
    const { handlers, mutate } = harness();
    const d = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 7, note: 'n' }, naturalKey: 'flow-noappr', projected_effect: 'note', ...tok('writer') });
    const id = rec(J(d).intent).intent_id as string;
    await handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    const e = await handlers.execute_write_intent({ intent_id: id, ...tok('writer') });
    expect(rec(J(e).execution).blocked_reason).toBe('intent_not_approved');
    expect(rec(J(e).intent).state).toBe('validated');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('draft_only consumer cannot approve', async () => {
    const { handlers } = harness();
    const d = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-draftonly', projected_effect: 'note', ...tok('drafter') });
    const id = rec(J(d).intent).intent_id as string;
    await handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });
    const a = await handlers.approve_write_intent({ intent_id: id, approver: 'x', decision: 'approved', ...tok('drafter') });
    expect(a.isError).toBe(true);
    expect(J(a).error).toMatch(/not permitted to approve/i);
  });

  it('consumer isolation: one consumer cannot act on another consumer intent', async () => {
    const { handlers } = harness();
    const d = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-iso', projected_effect: 'note', ...tok('writer') });
    const id = rec(J(d).intent).intent_id as string;
    const v = await handlers.validate_write_intent({ intent_id: id, ...tok('drafter') });
    expect(v.isError).toBe(true);
    expect(J(v).error).toMatch(/does not belong/i);
  });

  it('invalid params are rejected at validate (state=rejected), no mutate', async () => {
    const { handlers, mutate } = harness();
    const d = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1 }, naturalKey: 'k-badparams', projected_effect: 'note', ...tok('writer') });
    const id = rec(J(d).intent).intent_id as string;
    const v = await handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    expect(rec(J(v).validation).ok).toBe(false);
    expect(rec(J(v).intent).state).toBe('rejected');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('get_write_intent returns the intent + append-only audit trail', async () => {
    const { handlers } = harness();
    const d = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-audit', projected_effect: 'note', ...tok('writer') });
    const id = rec(J(d).intent).intent_id as string;
    await handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    const g = await handlers.get_write_intent({ intent_id: id, ...tok('writer') });
    const trail = J(g).audit as { event: string }[];
    expect(trail.map((x) => x.event)).toEqual(['intent.drafted', 'intent.validated']);
  });

  it('idempotency key is deterministic for same consumer+scope+naturalKey', async () => {
    const { handlers } = harness();
    const mk = () => handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 1, note: 'n' }, naturalKey: 'k-idem-stable', projected_effect: 'note', ...tok('writer') });
    expect(J(await mk()).idempotency_key).toBe(J(await mk()).idempotency_key);
  });

  it('no field returned-but-undeclared for any write-flow tool (success path)', async () => {
    const { handlers, configs } = harness();
    const declared = (name: string) => new Set(Object.keys(configs[name]?.outputSchema ?? {}));
    const d = await handlers.draft_write_intent({ scope: 'client_note:write', params: { clientid: 7, note: 'hello' }, naturalKey: 'schema-cover', projected_effect: 'add client note', ...tok('writer') });
    const id = rec(J(d).intent).intent_id as string;
    const v = await handlers.validate_write_intent({ intent_id: id, ...tok('writer') });
    const a = await handlers.approve_write_intent({ intent_id: id, approver: 'op1', decision: 'approved', ...tok('writer') });
    const e = await handlers.execute_write_intent({ intent_id: id, ...tok('writer') });
    const g = await handlers.get_write_intent({ intent_id: id, ...tok('writer') });
    for (const [name, res] of [['draft_write_intent', d], ['validate_write_intent', v], ['approve_write_intent', a], ['execute_write_intent', e], ['get_write_intent', g]] as [string, Res][]) {
      expect(res.isError).toBeUndefined();
      const undeclared = Object.keys(J(res)).filter((k) => !declared(name).has(k));
      expect(undeclared, `${name} undeclared: ${undeclared.join(',')}`).toEqual([]);
    }
  });

  it('error result still validates against the declared outputSchema', async () => {
    const { handlers, configs } = harness();
    const r = await handlers.draft_write_intent({ scope: 'client_note:write', params: {}, naturalKey: 'k-err', projected_effect: 'x', auth_token: 'bogus' });
    expect(r.isError).toBe(true);
    const allow = new Set(Object.keys(configs.draft_write_intent?.outputSchema ?? {}));
    expect(Object.keys(J(r)).filter((k) => !allow.has(k))).toEqual([]);
  });
});
