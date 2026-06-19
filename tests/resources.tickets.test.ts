/**
 * Regression for #11: ticket-thread resource returned empty replies and no
 * initial_message for tickets that have content. Root cause: WHMCS GetTicket
 * puts the opening post in replies.reply[0] (no top-level `message`), and the
 * resource read ticket.message. These tests pin the corrected behaviour:
 * initial_message = first reply's message; replies = the rest.
 */
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_AUTH_TOKEN: '',
    MCP_ACCESS_MODE: 'admin' as 'admin' | 'client',
    MCP_ALLOWED_CLIENT_IDS: [] as number[],
    MCP_MODE: 'read_only',
  },
}));
vi.mock('../src/config.js', () => cfg);

import { registerResources } from '../src/resources/index.js';

function makeServer() {
  const handlers: Record<string, (uri: URL, params?: any) => Promise<any>> = {};
  const server = {
    resource: (n: string, _t: unknown, cb: any) => {
      handlers[n] = cb;
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

describe('ticket-thread resource (#11)', () => {
  it('opening post → initial_message; subsequent replies → replies[]', async () => {
    const { server, handlers } = makeServer();
    const whmcsClient: any = {
      read: vi.fn().mockResolvedValue({
        ticketid: 1001,
        tid: 'TST01',
        deptname: 'Help Desk',
        subject: 'example.org status?',
        status: 'Answered',
        date: '2026-05-18 07:21:49',
        replies: {
          reply: [
            {
              replyid: '0',
              name: 'Test User',
              date: '2026-05-18 07:21:49',
              message: 'Opening message body',
              admin: '',
            },
            {
              replyid: '1',
              name: 'Support',
              date: '2026-05-18 07:31:27',
              message: 'Staff reply body',
              admin: 'Agent',
            },
          ],
        },
        notes: [],
      }),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['ticket-thread'](new URL('whmcs://tickets/1001/thread'), {
      ticketid: '1001',
    });
    const payload = JSON.parse(res.contents[0].text);

    expect(payload.error).toBeUndefined();
    expect(payload.ticket_number).toBe('TST01');
    expect(payload.initial_message).toBe('Opening message body');
    expect(payload.replies).toHaveLength(1);
    expect(payload.replies[0].message).toBe('Staff reply body');
    expect(payload.replies[0].is_admin).toBe(true);
  });

  it('edge: ticket with only the opening post → initial_message set, replies empty', async () => {
    const { server, handlers } = makeServer();
    const whmcsClient: any = {
      read: vi.fn().mockResolvedValue({
        ticketid: 1002,
        tid: 'TST02',
        deptname: 'Help Desk',
        subject: 'just opened',
        status: 'Open',
        date: '2026-05-18 08:00:00',
        replies: {
          reply: [
            { replyid: '0', name: 'Client', date: '2026-05-18 08:00:00', message: 'Only message' },
          ],
        },
        notes: [],
      }),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['ticket-thread'](new URL('whmcs://tickets/1002/thread'), {
      ticketid: '1002',
    });
    const payload = JSON.parse(res.contents[0].text);

    expect(payload.initial_message).toBe('Only message');
    expect(payload.replies).toEqual([]);
  });
});
