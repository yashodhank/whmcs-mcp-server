import { it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerListTool, encodeCursor, decodeCursor } from '../../src/tools/listTools.js';

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

// ── opaque cursor pagination ──────────────────────────────────────────────

it('cursor encode/decode round-trips and is opaque base64(JSON{offset})', () => {
  const tok = encodeCursor(40);
  expect(typeof tok).toBe('string');
  expect(decodeCursor(tok)).toBe(40);
  // It really is base64 of {"offset":40}.
  expect(JSON.parse(Buffer.from(tok, 'base64').toString('utf8'))).toEqual({ offset: 40 });
  // Round-trip across a range.
  for (const n of [0, 1, 7, 100, 999999]) expect(decodeCursor(encodeCursor(n))).toBe(n);
});

it('decodeCursor is defensive: garbage / malformed / negative → 0, never throws', () => {
  expect(decodeCursor(undefined)).toBe(0);
  expect(decodeCursor('')).toBe(0);
  expect(decodeCursor('!!!not base64!!!')).toBe(0);
  expect(decodeCursor(Buffer.from('not json', 'utf8').toString('base64'))).toBe(0);
  expect(decodeCursor(Buffer.from('[]', 'utf8').toString('base64'))).toBe(0);
  expect(decodeCursor(Buffer.from(JSON.stringify({ offset: -5 }), 'utf8').toString('base64'))).toBe(0);
  expect(decodeCursor(Buffer.from(JSON.stringify({ offset: 'x' }), 'utf8').toString('base64'))).toBe(0);
  expect(encodeCursor(-3)).toBe(encodeCursor(0)); // negative clamps to 0
});

it('emits nextCursor on a FULL page and follows it to the next page', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  // 5 total rows, page size 2 → full first page, more remain.
  const read = vi.fn(async (_a: string, params: any) => {
    const start = Number(params.limitstart);
    const all = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const slice = all.slice(start, start + Number(params.limitnum));
    return { totalresults: 5, numreturned: slice.length, startnumber: start, ps: { p: slice } };
  });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_ps', description: 'd', action: 'GetPs', clientParam: 'clientid',
    normalizerPath: 'ps', extraSchema: {}, mapItem: (p: any) => ({ id: p.id }),
  });
  const r1 = await handlers.list_ps({ clientid: 1, limit: 2, offset: 0 });
  const p1 = JSON.parse(r1.content[0].text);
  expect(p1.items.map((i: any) => i.id)).toEqual([1, 2]);
  expect(typeof p1.nextCursor).toBe('string');
  expect(decodeCursor(p1.nextCursor)).toBe(2);

  // Follow the cursor — it overrides offset and reads limitstart:2.
  const r2 = await handlers.list_ps({ clientid: 1, limit: 2, cursor: p1.nextCursor });
  expect(read).toHaveBeenLastCalledWith('GetPs', { clientid: 1, limitnum: 2, limitstart: 2 });
  const p2 = JSON.parse(r2.content[0].text);
  expect(p2.items.map((i: any) => i.id)).toEqual([3, 4]);
  expect(p2.offset).toBe(2);
  expect(typeof p2.nextCursor).toBe('string');

  // Final partial page (1 row) → no nextCursor.
  const r3 = await handlers.list_ps({ clientid: 1, limit: 2, cursor: p2.nextCursor });
  const p3 = JSON.parse(r3.content[0].text);
  expect(p3.items.map((i: any) => i.id)).toEqual([5]);
  expect(p3.nextCursor).toBeUndefined();
});

it('no nextCursor when WHMCS total is already reached on a full page', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  const read = vi.fn().mockResolvedValue({ totalresults: 2, numreturned: 2, startnumber: 0, ps: { p: [{ id: 1 }, { id: 2 }] } });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_ps2', description: 'd', action: 'GetPs', clientParam: 'clientid',
    normalizerPath: 'ps', extraSchema: {}, mapItem: (p: any) => ({ id: p.id }),
  });
  const r = await handlers.list_ps2({ clientid: 1, limit: 2, offset: 0 });
  const p = JSON.parse(r.content[0].text);
  expect(p.items).toHaveLength(2);
  expect(p.nextCursor).toBeUndefined();
});

it('a garbage cursor is treated as offset 0 (first page), never crashes', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  const read = vi.fn().mockResolvedValue({ totalresults: 1, numreturned: 1, startnumber: 0, ps: { p: [{ id: 1 }] } });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_ps3', description: 'd', action: 'GetPs', clientParam: 'clientid',
    normalizerPath: 'ps', extraSchema: {}, mapItem: (p: any) => ({ id: p.id }),
  });
  const r = await handlers.list_ps3({ clientid: 1, limit: 5, cursor: '###garbage###' });
  expect(read).toHaveBeenCalledWith('GetPs', { clientid: 1, limitnum: 5, limitstart: 0 });
  const p = JSON.parse(r.content[0].text);
  expect(p.offset).toBe(0);
});

it('no cursor arg ⇒ behaviour identical to before (offset honoured)', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  const read = vi.fn().mockResolvedValue({ totalresults: 10, numreturned: 2, startnumber: 4, ps: { p: [{ id: 5 }, { id: 6 }] } });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_ps4', description: 'd', action: 'GetPs', clientParam: 'clientid',
    normalizerPath: 'ps', extraSchema: {}, mapItem: (p: any) => ({ id: p.id }),
  });
  await handlers.list_ps4({ clientid: 1, limit: 2, offset: 4 });
  expect(read).toHaveBeenCalledWith('GetPs', { clientid: 1, limitnum: 2, limitstart: 4 });
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
