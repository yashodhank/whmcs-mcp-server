/**
 * Track A — get_currencies / list_payment_methods / get_whmcs_details governed
 * read tools.
 *
 * Tests run with governance OFF (legacy passthrough) so the human-readable
 * `content[0].text` payload is asserted directly, mirroring infraTools.test.ts.
 * WHMCS has no live install here — raw responses are mocked from the documented
 * developers.whmcs.com shapes. whmcs.read is always mocked.
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

import { registerSystemRefTools } from '../../src/tools/systemRefTools.js';

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

describe('get_currencies', () => {
  it('reads GetCurrencies and returns canonical currency data', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      currencies: {
        currency: [
          { id: '1', code: 'USD', prefix: '$', suffix: '', format: '1', rate: '1.00000', default: '1' },
          { id: '2', code: 'EUR', prefix: '€', suffix: '', format: '2', rate: '0.92000', default: '0' },
        ],
      },
    });
    registerSystemRefTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_currencies({});
    expect(read).toHaveBeenCalledWith('GetCurrencies', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('activity');
    expect(p.data.currencies).toHaveLength(2);
    expect(p.data.currencies[0]).toMatchObject({ id: 1, code: 'USD', rate: 1, isDefault: true });
    expect(p.data.currencies[1].code).toBe('EUR');
  });

  it('surfaces a business error as a structured error result', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockRejectedValue(new WhmcsBusinessError('boom'));
    registerSystemRefTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_currencies({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('boom');
  });
});

describe('list_payment_methods', () => {
  it('reads GetPaymentMethods and returns canonical method labels', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      paymentmethods: {
        paymentmethod: [
          { module: 'stripe', displayname: 'Credit Card (Stripe)' },
          { module: 'paypal', displayname: 'PayPal' },
        ],
      },
    });
    registerSystemRefTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.list_payment_methods({});
    expect(read).toHaveBeenCalledWith('GetPaymentMethods', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('activity');
    expect(p.data.methods).toEqual([
      { module: 'stripe', displayName: 'Credit Card (Stripe)' },
      { module: 'paypal', displayName: 'PayPal' },
    ]);
  });

  it('tolerates a single-object payment method', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      paymentmethods: { paymentmethod: { module: 'mailin', displayname: 'Mail In Payment' } },
    });
    registerSystemRefTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.list_payment_methods({});
    const p = JSON.parse(res.content[0].text);
    expect(p.data.methods).toHaveLength(1);
    expect(p.data.methods[0].module).toBe('mailin');
  });
});

describe('get_whmcs_details', () => {
  it('reads WhmcsDetails and returns version/release', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      whmcs: { version: '8.10.1', canonicalversion: '8.10.1-release.1' },
    });
    registerSystemRefTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_whmcs_details({});
    expect(read).toHaveBeenCalledWith('WhmcsDetails', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('activity');
    expect(p.data).toEqual({ version: '8.10.1', release: '8.10.1-release.1' });
  });

  it('surfaces a rate-limit error as a structured error result', async () => {
    const { server, handlers, logger } = harness();
    const read = vi.fn().mockResolvedValue({ whmcs: { version: '9.0.0' } });
    const rateLimiter: any = { tryConsume: () => false };
    registerSystemRefTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_whmcs_details({});
    expect(res.isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
