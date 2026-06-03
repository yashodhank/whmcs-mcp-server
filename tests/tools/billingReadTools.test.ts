/**
 * Track B — get_pay_methods / get_credits governed read tools.
 *
 * Tests run with governance OFF (legacy passthrough) so the human-readable
 * `content[0].text` payload is asserted directly, mirroring infraTools.test.ts.
 * WHMCS has no live install here — raw responses are mocked from the documented
 * developers.whmcs.com shapes. `whmcs.read` is always mocked.
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
  const actual =
    await importOriginal<typeof import('../../src/governance/pipeline.js')>();
  return { ...actual, governanceEnabled: () => false };
});

import { registerBillingReadTools } from '../../src/tools/billingReadTools.js';

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

describe('get_pay_methods', () => {
  it('reads GetPayMethods(clientid) and returns canonical data', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      paymethods: {
        paymethod: [
          {
            id: '7',
            type: 'CreditCard',
            description: 'Visa ending 4242',
            gateway_name: 'stripe',
            card: { cardnum: '************4242', expdate: '1230' },
          },
        ],
      },
    });
    registerBillingReadTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_pay_methods({ clientid: 42 });
    expect(read).toHaveBeenCalledWith('GetPayMethods', { clientid: 42 });
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('transaction');
    expect(p.data.clientId).toBe(42);
    expect(p.data.payMethods[0].lastFour).toBe('4242');
    expect(p.data.payMethods[0].gateway).toBe('stripe');
  });

  it('anchors clientId to the requested client even if WHMCS omits it', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ paymethods: {} });
    registerBillingReadTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_pay_methods({ clientid: 99 });
    const p = JSON.parse(res.content[0].text);
    expect(p.data.clientId).toBe(99);
    expect(p.data.payMethods).toEqual([]);
  });

  it('surfaces a business error as a structured error result', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockRejectedValue(new WhmcsBusinessError('boom'));
    registerBillingReadTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_pay_methods({ clientid: 1 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('boom');
  });
});

describe('get_credits', () => {
  it('reads GetCredits(clientid) and returns canonical data', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      credits: {
        credit: [
          { id: '100', date: '2026-01-01', description: 'Refund', amount: '25.00', relid: '500' },
        ],
      },
    });
    registerBillingReadTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_credits({ clientid: 42 });
    expect(read).toHaveBeenCalledWith('GetCredits', { clientid: 42 });
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('transaction');
    expect(p.data.clientId).toBe(42);
    expect(p.data.credits[0].creditId).toBe(100);
    expect(p.data.credits[0].amount).toBe(25);
    expect(p.data.credits[0].relatedId).toBe(500);
  });

  it('tolerates empty credits {} and surfaces a business error', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();

    const readEmpty = vi.fn().mockResolvedValue({ credits: {} });
    registerBillingReadTools(server as any, { read: readEmpty } as any, logger, rateLimiter);
    const res = await handlers.get_credits({ clientid: 7 });
    expect(JSON.parse(res.content[0].text).data.credits).toEqual([]);

    const h2 = harness();
    const readErr = vi.fn().mockRejectedValue(new WhmcsBusinessError('nope'));
    registerBillingReadTools(h2.server as any, { read: readErr } as any, h2.logger, h2.rateLimiter);
    const res2 = await h2.handlers.get_credits({ clientid: 7 });
    expect(res2.isError).toBe(true);
    expect(JSON.parse(res2.content[0].text).error).toBe('nope');
  });
});
