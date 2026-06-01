import { it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerListTool } from '../../src/tools/listTools.js';

function harness() {
  const handlers: Record<string, any> = {};
  const server = { registerTool: (n: string, _cfg: unknown, cb: any) => { handlers[n] = cb; } };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  return { server, handlers, logger, rateLimiter };
}

it('maps limit/offset→limitnum/limitstart and returns envelope', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  const read = vi.fn().mockResolvedValue({ totalresults: 3, numreturned: 2, startnumber: 0, things: { thing: { '0': { id: 1 }, '1': { id: 2 } } } });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_things', description: 'd', action: 'GetThings',
    clientParam: 'clientid', normalizerPath: 'things',
    extraSchema: {}, mapItem: (t: any) => ({ id: t.id }),
  });
  const res = await handlers.list_things({ clientid: 5, limit: 2, offset: 0 });
  expect(read).toHaveBeenCalledWith('GetThings', { clientid: 5, limitnum: 2, limitstart: 0 });
  const p = JSON.parse(res.content[0].text);
  expect(p).toMatchObject({ total: 3, count: 2, offset: 0, items: [{ id: 1 }, { id: 2 }] });
});

it('passes fixedParams into the WHMCS call', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  const read = vi.fn().mockResolvedValue({ totalresults: 0, numreturned: 0, startnumber: 0, xs: { x: [] } });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_xs', description: 'd', action: 'GetXs', clientParam: 'userid',
    normalizerPath: 'xs', extraSchema: {}, fixedParams: { orderby: 'date', order: 'desc' }, mapItem: (x: any) => x,
  });
  await handlers.list_xs({ clientid: 7 });
  expect(read).toHaveBeenCalledWith('GetXs', { userid: 7, limitnum: 10, limitstart: 0, orderby: 'date', order: 'desc' });
});

it('applies postSort and extraPayload', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  const read = vi.fn().mockResolvedValue({ totalresults: 2, numreturned: 2, startnumber: 0, ys: { y: [{ d: '2020' }, { d: '2025' }] } });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_ys', description: 'd', action: 'GetYs', clientParam: 'clientid', normalizerPath: 'ys',
    extraSchema: {}, mapItem: (y: any) => ({ d: y.d }),
    postSort: (xs: any[]) => [...xs].sort((a, b) => String(b.d).localeCompare(String(a.d))),
    extraPayload: { discovery: 'best-effort' },
  });
  const res = await handlers.list_ys({ clientid: 1 });
  const p = JSON.parse(res.content[0].text);
  expect(p.items.map((i: any) => i.d)).toEqual(['2025', '2020']);
  expect(p.discovery).toBe('best-effort');
});

it('enforces client-mode scope', async () => {
  vi.resetModules();
  vi.doMock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
  vi.doMock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => true, ensureClientAllowed: () => ({ content: [{ type: 'text', text: '{"isError":true}' }], isError: true }) }));
  const { registerListTool: rlt } = await import('../../src/tools/listTools.js');
  const { server, handlers, logger, rateLimiter } = harness();
  rlt(server as any, { read: vi.fn() } as any, logger, rateLimiter, { name: 'list_z', description: 'd', action: 'GetZ', clientParam: 'clientid', normalizerPath: 'z', extraSchema: {}, mapItem: (t: any) => t });
  const res = await handlers.list_z({ clientid: 999 });
  expect(res.isError).toBe(true);
});
