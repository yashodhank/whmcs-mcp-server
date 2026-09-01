/**
 * NEXUS extended read tools — mocked WHMCS read tests (governance OFF).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
}));
vi.mock('../../src/governance/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/governance/pipeline.js')>();
  return { ...actual, governanceEnabled: () => false };
});

import { registerExtendedReadTools } from '../../src/tools/extendedReadTools.js';

function harness() {
  const handlers: Record<
    string,
    (p: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
  > = {};
  const server = {
    registerTool: (n: string, _cfg: unknown, cb: (typeof handlers)[string]) => {
      handlers[n] = cb;
    },
  };
  const childLogger = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => childLogger,
  };
  const logger = { child: () => childLogger };
  const rateLimiter = { tryConsume: () => true };
  return { server, handlers, logger, rateLimiter };
}

describe('extended read tools', () => {
  it('get_domain_nameservers calls DomainGetNameservers', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      ns1: 'ns1.example.net',
      ns2: 'ns2.example.net',
    });
    registerExtendedReadTools(
      server as never,
      { read } as never,
      logger as never,
      rateLimiter as never
    );
    const res = await handlers.get_domain_nameservers({ domainid: 12 });
    expect(read).toHaveBeenCalledWith('DomainGetNameservers', { domainid: 12 });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.data.ns1).toBe('ns1.example.net');
  });

  it('list_order_statuses calls GetOrderStatuses', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ result: 'success', statuses: { status: [] } });
    registerExtendedReadTools(
      server as never,
      { read } as never,
      logger as never,
      rateLimiter as never
    );
    await handlers.list_order_statuses({});
    expect(read).toHaveBeenCalledWith('GetOrderStatuses', {});
  });
});
