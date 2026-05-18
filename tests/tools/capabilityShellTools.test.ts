import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerCapabilityShellTools } from '../../src/tools/capabilityShellTools.js';

function harness() {
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>> = {};
  const configs: Record<string, Record<string, unknown>> = {};
  const server = { registerTool: (n: string, c: unknown, cb: unknown) => { configs[n] = c as Record<string, unknown>; handlers[n] = cb as never; } };
  const childLogger = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger = { child: () => childLogger };
  const rateLimiter = { tryConsume: () => true };
  const read = vi.fn();
  const whmcs = { read };
  registerCapabilityShellTools(server as never, whmcs as never, logger as never, rateLimiter as never);
  return { handlers, configs, read };
}

const SHELLS: [tool: string, action: string][] = [
  ['list_client_transactions', 'GetTransactions'],
  ['get_stats', 'GetStats'],
  ['list_users', 'GetUsers'],
  ['get_todo_items', 'GetToDoItems'],
  ['get_automation_log', 'GetAutomationLog'],
];

describe('registerCapabilityShellTools', () => {
  it('registers the 5 capability-shell tools + get_capability_matrix', () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(
      [...SHELLS.map(([t]) => t), 'get_capability_matrix'].sort()
    );
  });

  // GetUsers stays UNVERIFIED (degraded everywhere) — still a shell.
  it('list_users (unverified) returns structured capability_unavailable and NEVER calls WHMCS', async () => {
    const { handlers, read } = harness();
    const res = await handlers.list_users({ clientid: 1 });
    expect(read).not.toHaveBeenCalled();
    const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(p).toMatchObject({ capability_unavailable: true, action: 'GetUsers' });
    expect(['unverified', 'degraded']).toContain(p.status);
    expect(res.isError).toBe(true);
  });

  // Phase H: the 4 production-verified actions are PROMOTED — real
  // governed reads (call WHMCS, return data, NOT capability_unavailable).
  const PROMOTED: [tool: string, action: string, resp: Record<string, unknown>][] = [
    ['list_client_transactions', 'GetTransactions', { transactions: { transaction: [{ id: 1, userid: 7, amountin: '10.00' }] } }],
    ['get_stats', 'GetStats', { income_today: '100.00', num_clients: 5 }],
    ['get_todo_items', 'GetToDoItems', { todoitems: { todoitem: [{ id: 1, title: 'x', status: 'New' }] } }],
    ['get_automation_log', 'GetAutomationLog', { automationlog: { entry: [{ id: 1, name: 'cron', status: 'Success' }] } }],
  ];
  for (const [tool, action, resp] of PROMOTED) {
    it(`${tool} is PROMOTED: calls WHMCS ${action}, returns governed data (not capability_unavailable)`, async () => {
      const { handlers, read } = harness();
      read.mockResolvedValue(resp);
      const res = await handlers[tool]({ clientid: 7 });
      expect(read).toHaveBeenCalledWith(action, expect.any(Object));
      const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
      expect(p.capability_unavailable).toBeUndefined();
      expect(res.isError).toBeUndefined();
      // legacy path (no governance): items[] for list, data object for single
      expect(p.items !== undefined || Object.keys(p).length > 0).toBe(true);
    });
  }

  it('get_capability_matrix reports the structured capability registry + unverified WHMCS version, no WHMCS call', async () => {
    const { handlers, read } = harness();
    const res = await handlers.get_capability_matrix({});
    expect(read).not.toHaveBeenCalled();
    const p = JSON.parse(res.content[0].text) as {
      whmcs_version: { status: string };
      capabilities: { action: string; status: string }[];
      compat_9x: Record<string, unknown>;
    };
    expect(p.whmcs_version.status).toBe('unverified');
    const byAction = Object.fromEntries(p.capabilities.map((c) => [c.action, c.status]));
    expect(byAction.GetActivityLog).toBe('supported');
    // Phase H: GetTransactions promoted to supported; GetUsers stays unverified.
    expect(byAction.GetTransactions).toBe('supported');
    expect(byAction.GetUsers).toBe('unverified');
    expect(p.compat_9x).toMatchObject({ immutable_non_draft_invoices: true, credit_debit_notes: true });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toBeDefined();
  });

  it('shells register an outputSchema for the structured capability_unavailable object', () => {
    const { configs } = harness();
    const cfg = configs.list_users;
    expect(cfg.outputSchema).toBeDefined();
    const shape = cfg.outputSchema as Record<string, { _def?: unknown }>;
    for (const k of ['capability_unavailable', 'action', 'status', 'note']) {
      expect(shape[k]).toBeDefined();
      expect(shape[k]._def).toBeDefined();
    }
    // Same stable shape reused across all shells.
    expect(configs.get_stats.outputSchema).toBe(cfg.outputSchema);
  });

  it('get_capability_matrix registers an outputSchema validating governed + ungoverned shapes', () => {
    const { configs } = harness();
    const cfg = configs.get_capability_matrix;
    expect(cfg.outputSchema).toBeDefined();
    const shape = cfg.outputSchema as Record<string, { _def?: unknown }>;
    for (const k of ['whmcs_version', 'capabilities', 'compat_9x', 'consumer', 'contract', 'data']) {
      expect(shape[k]).toBeDefined();
      expect(shape[k]._def).toBeDefined();
    }
  });

  it('does not fake data and is identical with governance OFF vs ON (no data to govern)', async () => {
    const { handlers } = harness();
    const a = await handlers.list_users({});
    const b = await handlers.list_users({ auth_token: 'whatever', contract: 'admin_full_trusted' });
    expect(a.content[0].text).toBe(b.content[0].text);
    const p = JSON.parse(a.content[0].text) as Record<string, unknown>;
    expect(p).not.toHaveProperty('users');
    expect(p).not.toHaveProperty('data');
  });
});
