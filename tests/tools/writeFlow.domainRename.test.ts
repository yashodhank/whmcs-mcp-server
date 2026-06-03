/**
 * service:domain_rename end-to-end via the registered write-flow handlers.
 *
 * Mocks WhmcsClient.read (GetClientsProducts — precondition + read-back) and
 * WhmcsClient.mutate (UpdateClientProduct). Proves the full single-call path:
 * draft → validate → approve → execute, the read-only precondition snapshot,
 * the strict {serviceid, domain} payload sent to WHMCS, and the real domain
 * read-back verification. The runtime allowlist authorizes ONLY the SCOPE
 * string `service:domain_rename` (not the bare action) — proving scope-level
 * gating works through the live handler, not just the pure gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';

const RAW_TOKEN = 'DOMAIN-RENAME-E2E-SYNTHETIC';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

beforeEach(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'dr-test',
      token_sha256: sha(RAW_TOKEN),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      allowedWriteScopes: ['service:domain_rename'],
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
    // NARROW grant: the scope string, NOT the bare UpdateClientProduct action.
    MCP_WRITE_EXECUTION_AUTHORIZED: ['service:domain_rename'],
    MCP_PROD_HIGH_RISK_PER_ACTION_CAP: 0,
    MCP_PROD_HIGH_RISK_DAILY_CAP: 0,
    MCP_WRITE_AUDIT_PATH: '',
    MCP_WRITE_IDEMPOTENCY_PATH: '',
  },
  isToolAllowed: () => true,
}));

vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));

type Handlers = Record<
  string,
  (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
>;

function setup(read: ReturnType<typeof vi.fn>, mutate: ReturnType<typeof vi.fn>): Handlers {
  const handlers: Handlers = {};
  const server = {
    registerTool: (n: string, _c: unknown, cb: unknown) => {
      handlers[n] = cb as never;
    },
  };
  const logger = {
    child: () => logger,
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
  registerWriteFlowTools(server as never, { mutate, read } as never, logger as never, {
    tryConsume: () => true,
  } as never);
  return handlers;
}

async function drive(handlers: Handlers, params: Record<string, unknown>) {
  const tok = { auth_token: RAW_TOKEN };
  const d = await handlers.draft_write_intent({
    scope: 'service:domain_rename',
    params,
    naturalKey: `rename-${String(params.serviceid)}`,
    projected_effect: 'rename service hostname',
    ...tok,
  });
  const id = (JSON.parse(d.content[0].text).intent as Record<string, unknown>).intent_id as string;
  await handlers.validate_write_intent({ intent_id: id, ...tok });
  await handlers.approve_write_intent({ intent_id: id, approver: 'op', decision: 'approved', ...tok });
  const e = await handlers.execute_write_intent({ intent_id: id, ...tok });
  return JSON.parse(e.content[0].text) as Record<string, unknown>;
}

describe('service:domain_rename end-to-end via registered handlers', () => {
  it('renames an Active service: precondition read, normalized payload, verified read-back', async () => {
    const read = vi.fn();
    // Precondition snapshot (Active, old domain), then read-back (new domain).
    read.mockResolvedValueOnce({
      products: { product: [{ id: 42, domain: 'old.example.com', domainstatus: 'Active' }] },
    });
    read.mockResolvedValueOnce({
      products: { product: [{ id: 42, domain: 'new.example.com', domainstatus: 'Active' }] },
    });
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    const handlers = setup(read, mutate);

    const body = await drive(handlers, { serviceid: 42, domain: '  NEW.Example.COM.  ' });

    expect(body.executed).toBe(true);
    expect((body.execution as Record<string, unknown>).verified).toBe(true);
    // WHMCS received exactly { serviceid, domain } with the NORMALIZED domain.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith('UpdateClientProduct', {
      serviceid: 42,
      domain: 'new.example.com',
    });
  });

  it('blocks with precondition_mismatch on a Terminated service — NO mutation', async () => {
    // Distinct serviceid ⇒ distinct naturalKey ⇒ distinct idempotency key
    // (the in-module ledger persists across tests in this file).
    const read = vi.fn().mockResolvedValueOnce({
      products: { product: [{ id: 43, domain: 'old.example.com', domainstatus: 'Terminated' }] },
    });
    const mutate = vi.fn();
    const handlers = setup(read, mutate);

    const body = await drive(handlers, { serviceid: 43, domain: 'new.example.com' });

    expect(body.executed).toBeFalsy();
    expect((body.execution as Record<string, unknown>).blocked_reason).toBe('precondition_mismatch');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('reports verified:false when the read-back domain does not match', async () => {
    const read = vi.fn();
    read.mockResolvedValueOnce({
      products: { product: [{ id: 44, domain: 'old.example.com', domainstatus: 'Active' }] },
    });
    // Read-back still shows the old domain ⇒ not verified.
    read.mockResolvedValueOnce({
      products: { product: [{ id: 44, domain: 'old.example.com', domainstatus: 'Active' }] },
    });
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    const handlers = setup(read, mutate);

    const body = await drive(handlers, { serviceid: 44, domain: 'new.example.com' });

    expect(body.executed).toBe(true);
    expect((body.execution as Record<string, unknown>).verified).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
