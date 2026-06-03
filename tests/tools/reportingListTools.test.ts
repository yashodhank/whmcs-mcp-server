/**
 * Opaque cursor pagination for the reporting list tools (list_invoices /
 * list_services). These tools scan WHMCS internally, then locally filter/sort
 * and slice a window. The cursor pages forward over that locally-filtered set:
 *  - a FULL page emits a nextCursor; the last/partial page omits it
 *  - following nextCursor reads the next window (cursor overrides offset)
 *  - a garbage cursor → offset 0 (never crashes)
 *  - no cursor ⇒ behaviour identical to before
 *
 * Synthetic fixtures only; `whmcs.read` is mocked. Governance OFF.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { MCP_MAX_PAGE_SIZE: 100, MCP_GOVERNANCE_ENABLED: false },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => false,
  ensureClientAllowed: () => null,
}));

import { registerReportingListTools } from '../../src/tools/reportingListTools.js';
import { decodeCursor, encodeCursor } from '../../src/tools/listTools.js';

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

/** Paged GetInvoices/GetClientsProducts reader over a flat synthetic list. */
function pagedReader(all: any[], path: 'invoices' | 'products') {
  const singular = path === 'invoices' ? 'invoice' : 'product';
  return vi.fn(async (_action: string, params: any) => {
    const start = Number(params.limitstart ?? 0);
    const num = Number(params.limitnum ?? 10);
    const slice = all.slice(start, start + num);
    return {
      result: 'success',
      totalresults: all.length,
      numreturned: slice.length,
      startnumber: start,
      [path]: { [singular]: slice },
    };
  });
}

function makeInvoices(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    invoicenum: `INV-${String(i + 1)}`,
    userid: 30,
    date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    duedate: '2024-02-01',
    status: 'Paid',
    total: '10.00',
  }));
}

function makeServices(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    userid: 30,
    name: `svc${String(i + 1)}`,
    status: 'Active',
    recurringamount: '5.00',
  }));
}

// The real MCP SDK applies Zod input-schema defaults before invoking the
// handler. These direct-call tests bypass that, so we supply the defaults the
// reporting handlers rely on (sort_by/sort_order/fetch_limit/scan_limit).
function invArgs(o: Record<string, unknown>): Record<string, unknown> {
  return { offset: 0, sort_by: 'invoiceid', sort_order: 'asc', ...o };
}
function svcArgs(o: Record<string, unknown>): Record<string, unknown> {
  return { offset: 0, paying_only: true, fetch_limit: 250, scan_limit: 10_000, ...o };
}

describe('list_invoices — opaque cursor pagination', () => {
  it('full page emits nextCursor; following it pages forward; last page omits it', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeInvoices(5), 'invoices');
    registerReportingListTools(server as any, { read } as any, logger, rateLimiter);

    const r1 = await handlers.list_invoices(invArgs({ limit: 2, offset: 0 }));
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.items.map((i: any) => i.invoiceid)).toEqual([1, 2]);
    expect(p1.offset).toBe(0);
    expect(typeof p1.nextCursor).toBe('string');
    expect(decodeCursor(p1.nextCursor)).toBe(2);

    const r2 = await handlers.list_invoices(invArgs({ limit: 2, cursor: p1.nextCursor }));
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.items.map((i: any) => i.invoiceid)).toEqual([3, 4]);
    expect(p2.offset).toBe(2);
    expect(typeof p2.nextCursor).toBe('string');

    const r3 = await handlers.list_invoices(invArgs({ limit: 2, cursor: p2.nextCursor }));
    const p3 = JSON.parse(r3.content[0].text);
    expect(p3.items.map((i: any) => i.invoiceid)).toEqual([5]);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('garbage cursor → offset 0, never crashes', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeInvoices(3), 'invoices');
    registerReportingListTools(server as any, { read } as any, logger, rateLimiter);
    const r = await handlers.list_invoices(invArgs({ limit: 2, cursor: '@@bad@@' }));
    const p = JSON.parse(r.content[0].text);
    expect(p.offset).toBe(0);
    expect(p.items.map((i: any) => i.invoiceid)).toEqual([1, 2]);
  });

  it('no cursor ⇒ offset honoured exactly as before', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeInvoices(10), 'invoices');
    registerReportingListTools(server as any, { read } as any, logger, rateLimiter);
    const r = await handlers.list_invoices(invArgs({ limit: 2, offset: 4 }));
    const p = JSON.parse(r.content[0].text);
    expect(p.offset).toBe(4);
    expect(p.items.map((i: any) => i.invoiceid)).toEqual([5, 6]);
    expect(decodeCursor(p.nextCursor)).toBe(6);
  });
});

describe('list_services — opaque cursor pagination', () => {
  it('full page emits nextCursor; following it advances; last page omits it', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeServices(5), 'products');
    registerReportingListTools(server as any, { read } as any, logger, rateLimiter);

    const r1 = await handlers.list_services(svcArgs({ limit: 2, offset: 0 }));
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.items).toHaveLength(2);
    expect(decodeCursor(p1.nextCursor)).toBe(2);

    const r2 = await handlers.list_services(svcArgs({ limit: 2, cursor: p1.nextCursor }));
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.offset).toBe(2);
    expect(p2.items.map((s: any) => s.serviceid)).toEqual([3, 4]);

    const r3 = await handlers.list_services(svcArgs({ limit: 2, cursor: p2.nextCursor }));
    const p3 = JSON.parse(r3.content[0].text);
    expect(p3.items.map((s: any) => s.serviceid)).toEqual([5]);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('garbage cursor → offset 0', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeServices(3), 'products');
    registerReportingListTools(server as any, { read } as any, logger, rateLimiter);
    const r = await handlers.list_services(svcArgs({ limit: 2, cursor: encodeCursor(0).slice(0, 3) + '!!' }));
    const p = JSON.parse(r.content[0].text);
    expect(p.offset).toBe(0);
  });
});
