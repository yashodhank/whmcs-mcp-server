/**
 * Track A — get_server_health / get_tld_pricing governed read tools.
 *
 * Tests run with governance OFF (legacy passthrough) so the human-readable
 * `content[0].text` payload is asserted directly, mirroring listTools.test.ts.
 * WHMCS has no live install here — raw responses are mocked from the documented
 * developers.whmcs.com shapes.
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

import { registerInfraTools } from '../../src/tools/infraTools.js';

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

describe('get_server_health', () => {
  it('reads GetServers and returns a governed list envelope', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      servers: {
        server: [
          { id: '1', name: 'web01', hostname: 'w1.example.net', ipaddress: '203.0.113.1', active: '1', disabled: '0', maxallowedaccounts: '500', activeservices: '120' },
          { id: '2', name: 'web02', hostname: 'w2.example.net', ipaddress: '203.0.113.2', active: '1', disabled: '0', maxallowedaccounts: '500', activeservices: '88' },
        ],
      },
    });
    registerInfraTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_server_health({});
    expect(read).toHaveBeenCalledWith('GetServers', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.total).toBe(2);
    expect(p.count).toBe(2);
    expect(p.items[0]).toMatchObject({ serverId: 1, name: 'web01', activeServices: 120 });
    expect(p.items[1].name).toBe('web02');
  });

  it('tolerates a single-object server (no array)', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ servers: { server: { id: 5, name: 'solo' } } });
    registerInfraTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_server_health({});
    const p = JSON.parse(res.content[0].text);
    expect(p.total).toBe(1);
    expect(p.items[0].name).toBe('solo');
  });

  it('surfaces a business error as a structured error result', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockRejectedValue(new WhmcsBusinessError('boom'));
    registerInfraTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_server_health({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('boom');
  });
});

describe('get_tld_pricing', () => {
  it('reads GetTLDPricing + GetRegistrars and returns canonical data', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn(async (action: string) => {
      if (action === 'GetTLDPricing') {
        return {
          result: 'success',
          currency: { id: '1', code: 'USD' },
          pricing: {
            '.com': { register: { '1': '9.95' }, renew: { '1': '11.95' }, transfer: { '1': '9.95' } },
          },
        };
      }
      if (action === 'GetRegistrars') {
        return { registrars: { registrar: [{ module: 'enom', displayname: 'eNom' }] } };
      }
      throw new Error(`unexpected action ${action}`);
    });
    registerInfraTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_tld_pricing({ currency: 1, include_registrar: true });
    expect(read).toHaveBeenCalledWith('GetTLDPricing', { currencyid: 1 });
    expect(read).toHaveBeenCalledWith('GetRegistrars', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.entity).toBe('tldPricing');
    expect(p.data.currencyCode).toBe('USD');
    expect(p.data.registrar).toBe('enom');
    expect(p.data.prices[0].tld).toBe('.com');
    expect(p.data.prices[0].register).toEqual([{ period: 1, price: 9.95 }]);
  });

  it('skips GetRegistrars when include_registrar is false', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ currency: { code: 'EUR' }, pricing: {} });
    registerInfraTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_tld_pricing({ include_registrar: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('GetTLDPricing', {});
    const p = JSON.parse(res.content[0].text);
    expect(p.data.registrar).toBeNull();
    expect(p.data.prices).toEqual([]);
  });

  it('still returns pricing if GetRegistrars fails (best-effort enrichment)', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn(async (action: string) => {
      if (action === 'GetTLDPricing') {
        return { currency: { code: 'USD' }, pricing: { '.net': { register: { '1': '8.00' } } } };
      }
      throw new Error('registrar lookup down');
    });
    registerInfraTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_tld_pricing({ include_registrar: true });
    const p = JSON.parse(res.content[0].text);
    expect(p.data.prices[0].tld).toBe('.net');
    expect(p.data.registrar).toBeNull();
  });
});
