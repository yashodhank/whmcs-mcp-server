/**
 * Regression: MCP resource auth on a stdio-only server.
 *
 * This server speaks MCP over stdio. The SDK matches resource URIs with a
 * `$`-anchored regex / exact string that includes the query string, so a
 * `?token=` suffix never reaches the handler — it 404s at the SDK before any
 * auth code runs. Per decision (Option 1) resources are NOT authenticated via
 * a URI-query token: they are protected by process/transport trust plus
 * MCP_ACCESS_MODE / client-scope. These tests pin that contract:
 *
 *  - path-param resources read successfully when MCP_AUTH_TOKEN is set, with
 *    no ?token= on the URI;
 *  - static resources (ops-playbook) likewise;
 *  - the README no longer documents the broken `?token=` resource flow.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_AUTH_TOKEN: 'sekret',
    MCP_ACCESS_MODE: 'admin' as 'admin' | 'client',
    MCP_ALLOWED_CLIENT_IDS: [] as number[],
    MCP_MODE: 'read_only',
  },
}));
vi.mock('../src/config.js', () => cfg);

import { registerResources } from '../src/resources/index.js';
import { registerPlaybookResource } from '../src/playbook/whmcsOpsPlaybook.js';

function makeServer() {
  const handlers: Record<string, (uri: URL, params?: any) => Promise<any>> = {};
  const server = {
    resource: (name: string, _tplOrUri: unknown, cb: any) => {
      handlers[name] = cb;
    },
  };
  return { server, handlers };
}

const childLogger: any = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => childLogger,
};
const logger: any = { child: () => childLogger, info: vi.fn(), debug: vi.fn() };
const rateLimiter: any = { tryConsume: () => true };

describe('MCP resource auth (stdio: no URI-query token)', () => {
  it('path-param resource reads with MCP_AUTH_TOKEN set and no ?token=', async () => {
    const { server, handlers } = makeServer();
    const whmcsClient: any = {
      read: vi.fn().mockResolvedValue({
        id: 1,
        firstname: 'Ada',
        lastname: 'Lovelace',
        email: 'ada@example.test',
        status: 'Active',
        credit: '0.00',
        currency_code: 'USD',
      }),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const handler = handlers['client-summary'];
    expect(handler).toBeTypeOf('function');

    const res = await handler(new URL('whmcs://clients/1/summary'), { clientid: '1' });
    const payload = JSON.parse(res.contents[0].text);

    expect(payload.error).toBeUndefined();
    expect(payload).toMatchObject({ clientid: 1, email: 'ada@example.test' });
  });

  it('static resource (ops-playbook) reads with MCP_AUTH_TOKEN set and no ?token=', async () => {
    const { server, handlers } = makeServer();
    registerPlaybookResource(server as any, logger);

    const handler = handlers['ops-playbook'];
    expect(handler).toBeTypeOf('function');

    const res = await handler(new URL('whmcs://docs/ops-playbook'));

    expect(res.contents[0].mimeType).toBe('text/markdown');
    expect(res.contents[0].text).toContain('WHMCS Operations Playbook');
    expect(res.contents[0].text).not.toContain('Unauthorized');
  });

  it('README no longer documents ?token= resource auth and scopes MCP_AUTH_TOKEN to tool calls', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

    // No resource URI carrying a query token anywhere in the docs.
    expect(readme).not.toMatch(/whmcs:\/\/[^\s)`]*\?[^\s`]*token=/i);
    expect(readme.toLowerCase()).not.toContain('every resource uri must include');

    // Positively documents the stdio reality.
    expect(readme).toMatch(/MCP_AUTH_TOKEN[^.]*tool call/i);
  });
});

/**
 * Preserved-behavior guards (criterion #4): removing URI-token auth must NOT
 * weaken MCP_ACCESS_MODE / client-scope enforcement on resources.
 */
describe('MCP resource boundaries preserved (client mode)', () => {
  afterEach(() => {
    cfg.config.MCP_ACCESS_MODE = 'admin';
    cfg.config.MCP_ALLOWED_CLIENT_IDS = [];
  });

  it('system-activity stays denied in client access mode', async () => {
    cfg.config.MCP_ACCESS_MODE = 'client';
    cfg.config.MCP_ALLOWED_CLIENT_IDS = [7];
    const { server, handlers } = makeServer();
    const whmcsClient: any = { read: vi.fn() };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['system-activity'](new URL('whmcs://system/activity'));
    const payload = JSON.parse(res.contents[0].text);

    expect(payload.error).toMatch(/not available in client access mode/i);
    expect(whmcsClient.read).not.toHaveBeenCalled();
  });

  it('client-summary still denies a client id outside MCP_ALLOWED_CLIENT_IDS', async () => {
    cfg.config.MCP_ACCESS_MODE = 'client';
    cfg.config.MCP_ALLOWED_CLIENT_IDS = [7];
    const { server, handlers } = makeServer();
    const whmcsClient: any = {
      read: vi.fn().mockResolvedValue({
        id: 9,
        firstname: 'X',
        lastname: 'Y',
        email: 'x@y.test',
        status: 'Active',
        credit: '0.00',
        currency_code: 'USD',
      }),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['client-summary'](new URL('whmcs://clients/9/summary'), {
      clientid: '9',
    });
    const payload = JSON.parse(res.contents[0].text);

    expect(payload.error).toMatch(/scope mismatch/i);
    expect(whmcsClient.read).not.toHaveBeenCalled();
  });
});
