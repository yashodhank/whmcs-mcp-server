/**
 * Tiered one-call `write` tool (D1). Proves:
 *  - LOW scope (client_note:write) executes in ONE call, audit-gated, with an
 *    EMPTY allowlist (no approval, no allowlist).
 *  - MEDIUM scope (service:domain_rename) executes in one call (precondition +
 *    read-back) with an empty allowlist.
 *  - HIGH scope (billing:credit:add) is validated then RETURNED for the
 *    explicit approve→execute ceremony — NOT auto-executed (zero mutate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';

const RAW = 'WRITE-ONECALL-SYNTHETIC';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

beforeEach(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'oc-test',
      token_sha256: sha(RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      allowedWriteScopes: ['client_note:write', 'service:domain_rename', 'billing:credit:add'],
      envRestrictions: [],
      anonymous: false,
    },
    {
      id: 'oc-approver',
      token_sha256: sha('WRITE-ONECALL-APPROVER'),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'approval_required', // can draft/approve, NOT one-call execute
      allowedWriteScopes: ['client_note:write'],
      envRestrictions: [],
      anonymous: false,
    },
  ]);
});

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_MODE: 'full',
    MCP_ENV: 'local',
    MCP_MAX_PAGE_SIZE: 100,
    MCP_WRITE_KILL_SWITCH: false,
    MCP_PROD_WRITE_AUTHORIZED: [],
    MCP_WRITE_EXECUTION_AUTHORIZED: [], // empty ⇒ low/med still run (audit-gated)
    MCP_WRITE_STRICT_ALLOWLIST: false,
    MCP_WRITE_STRICT_SCOPES: [],
    MCP_PROD_HIGH_RISK_PER_ACTION_CAP: 0,
    MCP_PROD_HIGH_RISK_DAILY_CAP: 0,
    MCP_WRITE_AUDIT_PATH: '',
    MCP_WRITE_IDEMPOTENCY_PATH: '',
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));

type Handlers = Record<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>;

function setup(read: ReturnType<typeof vi.fn>, mutate: ReturnType<typeof vi.fn>): Handlers {
  const handlers: Handlers = {};
  const server = { registerTool: (n: string, _c: unknown, cb: unknown) => { handlers[n] = cb as never; } };
  const logger = { child: () => logger, logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn() };
  registerWriteFlowTools(server as never, { mutate, read } as never, logger as never, { tryConsume: () => true } as never);
  return handlers;
}
const tok = { auth_token: RAW };
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown) => v as Record<string, unknown>;

describe('write (one-call, tiered)', () => {
  it('LOW scope executes in one call with an empty allowlist (audit-gated)', async () => {
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    const h = setup(vi.fn(), mutate);
    const body = J(
      await h.write({
        scope: 'client_note:write',
        params: { clientid: 1, note: 'hello' },
        naturalKey: 'note-1',
        projected_effect: 'add note',
        ...tok,
      })
    );
    expect(body.executed).toBe(true);
    expect(mutate).toHaveBeenCalledWith('AddClientNote', { userid: 1, notes: 'hello' });
  });

  it('MEDIUM scope (domain_rename) executes in one call: precondition + read-back', async () => {
    const read = vi.fn();
    read.mockResolvedValueOnce({ products: { product: [{ id: 9, domain: 'old.example.com', domainstatus: 'Active' }] } });
    read.mockResolvedValueOnce({ products: { product: [{ id: 9, domain: 'new.example.com', domainstatus: 'Active' }] } });
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    const h = setup(read, mutate);
    const body = J(
      await h.write({
        scope: 'service:domain_rename',
        params: { serviceid: 9, domain: 'new.example.com' },
        naturalKey: 'rename-9',
        projected_effect: 'rename',
        ...tok,
      })
    );
    expect(body.executed).toBe(true);
    expect(rec(body.execution).verified).toBe(true);
    expect(mutate).toHaveBeenCalledWith('UpdateClientProduct', { serviceid: 9, domain: 'new.example.com' });
  });

  it('HIGH scope is validated then RETURNED for the approve ceremony — NOT executed', async () => {
    const mutate = vi.fn();
    const h = setup(vi.fn(), mutate);
    const body = J(
      await h.write({
        scope: 'billing:credit:add',
        params: { clientid: 1, amount: 50, description: 'x' },
        naturalKey: 'credit-1',
        projected_effect: 'credit',
        ...tok,
      })
    );
    expect(body.stage).toBe('validate');
    expect(body.executed).toBeFalsy();
    expect(String(rec(body.execution).note)).toMatch(/approve_write_intent/);
    expect(mutate).not.toHaveBeenCalled();
    expect(rec(body.intent).state).toBe('validated');
  });

  it('non-execution_allowed consumer: LOW scope is validated, NOT auto-executed (no spurious approval)', async () => {
    const mutate = vi.fn();
    const h = setup(vi.fn(), mutate);
    const body = J(
      await h.write({
        scope: 'client_note:write',
        params: { clientid: 1, note: 'hi' },
        naturalKey: 'note-approver',
        projected_effect: 'add note',
        auth_token: 'WRITE-ONECALL-APPROVER',
      })
    );
    expect(body.stage).toBe('validate');
    expect(body.executed).toBeFalsy();
    expect(String(rec(body.execution).note)).toMatch(/approval_required|approve_write_intent/);
    expect(mutate).not.toHaveBeenCalled();
    expect(rec(body.intent).state).toBe('validated');
  });
});
