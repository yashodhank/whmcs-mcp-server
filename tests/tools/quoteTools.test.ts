/**
 * get_quotes governed read tool.
 *
 * Tests run with governance OFF (legacy passthrough) so the human-readable
 * `content[0].text` payload (items + envelope) is asserted directly, mirroring
 * infraTools.test.ts. WHMCS has no live install here — raw responses are mocked
 * from the documented GetQuotes shape. whmcs.read is always a mock.
 */
import { it, expect, vi, describe, beforeEach } from 'vitest';

const clientModeState = { value: false };
const clientAllowedError = { value: null as unknown };

vi.mock('../../src/config.js', () => ({
  config: { MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => clientModeState.value,
  ensureClientAllowed: () => clientAllowedError.value,
  clientModeDenied: (tool: string) => ({
    content: [
      { type: 'text', text: JSON.stringify({ isError: true, error: `client mode denied: ${tool}` }) },
    ],
    isError: true,
  }),
}));
vi.mock('../../src/governance/pipeline.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/governance/pipeline.js')>();
  return { ...actual, governanceEnabled: () => false };
});

import { registerQuoteTools } from '../../src/tools/quoteTools.js';

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

const SAMPLE = {
  result: 'success',
  quotes: {
    quote: [
      {
        id: '1',
        subject: 'Hosting proposal',
        stage: 'Delivered',
        status: 'Open',
        datecreated: '2026-05-01',
        validuntil: '2026-06-01',
        currencycode: 'USD',
        subtotal: '100.00',
        tax: '18.00',
        total: '118.00',
        customernotes: 'review please',
        lineitems: { lineitem: { '0': { description: 'Plan A', amount: '100.00' } } },
      },
      { id: '2', subject: 'SSL bundle', total: '40.00' },
    ],
  },
};

describe('get_quotes', () => {
  beforeEach(() => {
    clientModeState.value = false;
    clientAllowedError.value = null;
  });

  it('reads GetQuotes and returns a governed list envelope', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue(SAMPLE);
    registerQuoteTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_quotes({ limit: 25 });
    expect(read).toHaveBeenCalledWith('GetQuotes', { limitnum: 25 });
    const p = JSON.parse(res.content[0].text);
    expect(p.total).toBe(2);
    expect(p.count).toBe(2);
    expect(p.limit).toBe(25);
    expect(p.items[0]).toMatchObject({
      quoteId: 1,
      subject: 'Hosting proposal',
      currency: 'USD',
      total: 118,
    });
    expect(p.items[0].lineItems[0]).toEqual({ description: 'Plan A', amount: 100 });
    expect(p.items[1].subject).toBe('SSL bundle');
  });

  it('passes clientid through as a userid filter', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ quotes: { quote: { id: 5, subject: 'solo' } } });
    registerQuoteTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_quotes({ clientid: 42, limit: 10 });
    expect(read).toHaveBeenCalledWith('GetQuotes', { limitnum: 10, userid: 42 });
    const p = JSON.parse(res.content[0].text);
    expect(p.total).toBe(1);
    expect(p.items[0].subject).toBe('solo');
  });

  it('tolerates a single quote object (no array) and empty {}', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ quotes: {} });
    registerQuoteTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_quotes({ limit: 25 });
    const p = JSON.parse(res.content[0].text);
    expect(p.total).toBe(0);
    expect(p.items).toEqual([]);
  });

  it('denies in client mode when no clientid is supplied', async () => {
    clientModeState.value = true;
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn();
    registerQuoteTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_quotes({ limit: 25 });
    expect(read).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain('get_quotes');
    clientModeState.value = false;
  });

  it('enforces client scope when clientid is supplied in client mode', async () => {
    clientModeState.value = true;
    clientAllowedError.value = {
      content: [{ type: 'text', text: JSON.stringify({ isError: true, error: 'out of scope' }) }],
      isError: true,
    };
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn();
    registerQuoteTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_quotes({ clientid: 99, limit: 25 });
    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).error).toBe('out of scope');
    clientModeState.value = false;
    clientAllowedError.value = null;
  });

  it('surfaces a business error as a structured error result', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockRejectedValue(new WhmcsBusinessError('boom'));
    registerQuoteTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_quotes({ limit: 25 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('boom');
  });
});
