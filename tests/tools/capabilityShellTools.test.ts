import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerCapabilityShellTools } from '../../src/tools/capabilityShellTools.js';

function harness() {
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>> = {};
  const server = { registerTool: (n: string, _c: unknown, cb: unknown) => { handlers[n] = cb as never; } };
  const childLogger = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger = { child: () => childLogger };
  const rateLimiter = { tryConsume: () => true };
  const read = vi.fn();
  const whmcs = { read };
  registerCapabilityShellTools(server as never, whmcs as never, logger as never, rateLimiter as never);
  return { handlers, read };
}

const SHELLS: [tool: string, action: string][] = [
  ['list_client_transactions', 'GetTransactions'],
  ['get_stats', 'GetStats'],
  ['list_users', 'GetUsers'],
  ['get_todo_items', 'GetToDoItems'],
  ['get_automation_log', 'GetAutomationLog'],
];

describe('registerCapabilityShellTools', () => {
  it('registers exactly the 5 Phase-C capability-shell tools', () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(SHELLS.map(([t]) => t).sort());
  });

  for (const [tool, action] of SHELLS) {
    it(`${tool} returns structured capability_unavailable (unverified) and NEVER calls WHMCS`, async () => {
      const { handlers, read } = harness();
      const res = await handlers[tool]({ clientid: 1 });
      expect(read).not.toHaveBeenCalled();
      const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
      expect(p).toMatchObject({
        capability_unavailable: true,
        action,
        status: 'unverified',
      });
      expect(res.structuredContent).toMatchObject({ capability_unavailable: true, action, status: 'unverified' });
      expect(res.isError).toBe(true);
    });
  }

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
