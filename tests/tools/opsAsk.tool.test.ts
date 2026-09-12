import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_ENV: 'local',
    MCP_ALLOW_ANON_LLM: false,
    MCP_GOVERNANCE_ENABLED: false,
    MCP_TRANSPORT: 'stdio',
    MCP_STAFF_CONSUMER_IDS: 'operator-reconcile',
    MCP_READ_AUDIT_PATH: '',
    MCP_CUSTOMER_USER_API_PROVEN: false,
    MCP_MAX_PAGE_SIZE: 100,
  },
  isToolAllowed: () => true,
}));

vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
}));

vi.mock('../../src/auth/trustedStdioDefault.js', () => ({
  resolveStdioDefaultToken: () => 'staff-token',
}));

const resolveConsumer = vi.fn();
vi.mock('../../src/governance/consumers.js', () => ({
  resolveConsumer: (...args: unknown[]) => resolveConsumer(...args),
}));

vi.mock('../../src/governance/pipeline.js', () => ({
  getConsumerRegistry: () => [],
  governanceEnabled: () => false,
}));

vi.mock('../../src/tools/writeFlow.js', () => ({
  listWriteIntentsForConsumer: () => [],
}));

import { registerOpsAskTools } from '../../src/tools/opsAsk.js';

function harness() {
  const handlers: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {};
  const server = {
    registerTool: (
      name: string,
      _cfg: unknown,
      cb: (p: Record<string, unknown>) => Promise<unknown>
    ) => {
      handlers[name] = cb;
    },
  };
  const logger = {
    child: () => ({
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
    }),
  };
  const rl = { tryConsume: () => true };
  const read = vi.fn().mockResolvedValue({
    result: 'success',
    invoices: { invoice: [] },
    tickets: { ticket: [] },
  });
  registerOpsAskTools(server as never, { read } as never, logger as never, rl as never);
  return { handlers, read };
}

describe('ops_ask tool', () => {
  beforeEach(() => {
    resolveConsumer.mockReset();
  });

  it('staff morning_digest succeeds', async () => {
    resolveConsumer.mockReturnValue({
      ok: true,
      profile: { id: 'operator-reconcile', allowedActions: [] },
    });
    const { handlers } = harness();
    const res = (await handlers.ops_ask({ job: 'morning_digest' })) as {
      structuredContent: Record<string, unknown>;
    };
    expect(res.structuredContent.job).toBe('morning_digest');
    expect(res.structuredContent.audience).toBe('staff');
    expect(res.structuredContent.isError).toBeUndefined();
  });

  it('customer cannot run morning_digest', async () => {
    resolveConsumer.mockReturnValue({
      ok: true,
      profile: { id: 'customer-app', allowedActions: [] },
    });
    const { handlers } = harness();
    const res = (await handlers.ops_ask({ job: 'morning_digest' })) as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(res.isError).toBe(true);
    expect(res.structuredContent.status).toBe('job_denied');
  });

  it('customer billing_card is link_required', async () => {
    resolveConsumer.mockReturnValue({
      ok: true,
      profile: { id: 'customer-app', allowedActions: [] },
    });
    const { handlers } = harness();
    const res = (await handlers.ops_ask({ job: 'billing_card' })) as {
      structuredContent: Record<string, unknown>;
    };
    expect(res.structuredContent.status).toBe('link_required');
    expect(res.structuredContent.capability_unavailable).toBe(true);
  });
});
