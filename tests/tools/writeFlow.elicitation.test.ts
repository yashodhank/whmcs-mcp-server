/**
 * MCP Elicitation inline-confirm for MEDIUM one-call writes (spec 2025-11-25).
 * - client supports elicitation + DECLINE  ⇒ blocked, no mutate
 * - client supports elicitation + ACCEPT   ⇒ executes
 * - client WITHOUT elicitation             ⇒ unchanged (medium auto-executes)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';

const RAW = 'WRITE-ELICIT-SYNTHETIC';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

beforeEach(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'el-test',
      token_sha256: sha(RAW),
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
    MCP_WRITE_EXECUTION_AUTHORIZED: [],
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
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown) => v as Record<string, unknown>;

/** Build a server stub; `elicit` (if given) supplies the elicitation client capability. */
function setup(
  read: ReturnType<typeof vi.fn>,
  mutate: ReturnType<typeof vi.fn>,
  elicit?: { elicitInput: (p: unknown) => Promise<{ action?: string; content?: Record<string, unknown> }> }
): Handlers {
  const handlers: Handlers = {};
  const base = { registerTool: (n: string, _c: unknown, cb: unknown) => { handlers[n] = cb as never; } };
  const server = elicit
    ? {
        ...base,
        server: {
          getClientCapabilities: () => ({ elicitation: {} }),
          elicitInput: elicit.elicitInput,
        },
      }
    : base;
  const logger = { child: () => logger, logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn() };
  registerWriteFlowTools(server as never, { mutate, read } as never, logger as never, { tryConsume: () => true } as never);
  return handlers;
}
const tok = { auth_token: RAW };
const renameArgs = (sid: number) => ({
  scope: 'service:domain_rename',
  params: { serviceid: sid, domain: 'new.example.com' },
  naturalKey: `rename-${String(sid)}`,
  projected_effect: 'rename hostname',
  ...tok,
});

describe('write — elicitation inline confirm (medium)', () => {
  it('DECLINE blocks the write — no precondition read, no mutate', async () => {
    const read = vi.fn();
    const mutate = vi.fn();
    const elicitInput = vi.fn().mockResolvedValue({ action: 'decline' });
    const h = setup(read, mutate, { elicitInput });
    const body = J(await h.write(renameArgs(10)));
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(body.executed).toBeFalsy();
    expect(String(rec(body.execution).note)).toMatch(/elicitation/i);
    expect(mutate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('ACCEPT(confirm:true) proceeds to execute', async () => {
    const read = vi.fn();
    read.mockResolvedValueOnce({ products: { product: [{ id: 11, domain: 'old.example.com', domainstatus: 'Active' }] } });
    read.mockResolvedValueOnce({ products: { product: [{ id: 11, domain: 'new.example.com', domainstatus: 'Active' }] } });
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });
    const h = setup(read, mutate, { elicitInput });
    const body = J(await h.write(renameArgs(11)));
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(body.executed).toBe(true);
    expect(mutate).toHaveBeenCalledWith('UpdateClientProduct', { serviceid: 11, domain: 'new.example.com' });
  });

  it('client WITHOUT elicitation: medium write auto-executes (no regression)', async () => {
    const read = vi.fn();
    read.mockResolvedValueOnce({ products: { product: [{ id: 12, domain: 'old.example.com', domainstatus: 'Active' }] } });
    read.mockResolvedValueOnce({ products: { product: [{ id: 12, domain: 'new.example.com', domainstatus: 'Active' }] } });
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    const h = setup(read, mutate); // no elicit capability
    const body = J(await h.write(renameArgs(12)));
    expect(body.executed).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
