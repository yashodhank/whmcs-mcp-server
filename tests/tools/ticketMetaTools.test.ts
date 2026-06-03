/**
 * Track B — get_ticket_counts / list_support_statuses governed read tools.
 *
 * Tests run with governance OFF (legacy passthrough) so the human-readable
 * `content[0].text` payload is asserted directly, mirroring infraTools.test.ts.
 * WHMCS has no live install here — whmcs.read is mocked directly (the tests do
 * NOT depend on the READ allowlist), from the documented WHMCS shapes.
 */
import { it, expect, vi, describe } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => false,
  ensureClientAllowed: () => null,
}));
vi.mock('../../src/governance/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/governance/pipeline.js')>();
  return { ...actual, governanceEnabled: () => false };
});

import { registerTicketMetaTools } from '../../src/tools/ticketMetaTools.js';

function harness() {
  const handlers: Record<string, any> = {};
  const server = {
    registerTool: (n: string, _cfg: unknown, cb: any) => {
      handlers[n] = cb;
    },
  };
  const childLogger: any = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => childLogger,
  };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  return { server, handlers, logger, rateLimiter };
}

describe('get_ticket_counts', () => {
  it('reads GetTicketCounts and returns canonical ticket counts', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      statuses: { status: [{ title: 'Open', count: '4' }, { title: 'Answered', count: 2 }] },
      departments: { department: [{ name: 'Support', count: '7' }] },
      awaitingreply: '5',
      total: 13,
    });
    registerTicketMetaTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_ticket_counts({});
    expect(read).toHaveBeenCalledWith('GetTicketCounts', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('ticket');
    expect(p.data.statuses[0]).toEqual({ label: 'Open', count: 4 });
    expect(p.data.departments[0]).toEqual({ label: 'Support', count: 7 });
    expect(p.data.awaitingReply).toBe(5);
    expect(p.data.total).toBe(13);
  });

  it('tolerates an empty/garbage response', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ result: 'success' });
    registerTicketMetaTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_ticket_counts({});
    const p = JSON.parse(res.content[0].text);
    expect(p.data.statuses).toEqual([]);
    expect(p.data.total).toBeNull();
  });

  it('surfaces a business error as a structured error result', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockRejectedValue(new WhmcsBusinessError('boom'));
    registerTicketMetaTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_ticket_counts({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('boom');
  });
});

describe('list_support_statuses', () => {
  it('reads GetSupportStatuses and returns canonical statuses', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      statuses: { status: [{ title: 'Open', count: '4' }, { title: 'Closed', count: 0 }] },
    });
    registerTicketMetaTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.list_support_statuses({});
    expect(read).toHaveBeenCalledWith('GetSupportStatuses', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('ticket');
    expect(p.data.statuses).toHaveLength(2);
    expect(p.data.statuses[0]).toEqual({ title: 'Open', count: 4 });
    expect(p.data.statuses[1]).toEqual({ title: 'Closed', count: 0 });
  });

  it('tolerates a single-status object (no array)', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ statuses: { status: { title: 'Open', count: 1 } } });
    registerTicketMetaTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.list_support_statuses({});
    const p = JSON.parse(res.content[0].text);
    expect(p.data.statuses).toHaveLength(1);
    expect(p.data.statuses[0].title).toBe('Open');
  });

  it('surfaces a business error as a structured error result', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockRejectedValue(new WhmcsBusinessError('down'));
    registerTicketMetaTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.list_support_statuses({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('down');
  });
});
