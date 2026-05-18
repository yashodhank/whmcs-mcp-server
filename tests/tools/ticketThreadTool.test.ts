import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: {}, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => false,
  ensureClientAllowed: () => null,
  ensureClientOwnership: () => null,
}));
import { registerTicketThreadTool } from '../../src/tools/ticketThreadTool.js';

function harness() {
  const handlers: Record<string, any> = {};
  const configs: Record<string, any> = {};
  const server = {
    registerTool: (n: string, cfg: any, cb: any) => {
      handlers[n] = cb;
      configs[n] = cfg;
    },
  };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  return { server, handlers, configs, logger, rateLimiter };
}

describe('registerTicketThreadTool', () => {
  it('registers get_ticket_thread, calls GetTicket, formats thread, read-only annotations', async () => {
    const { server, handlers, configs, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      ticketid: 1001, tid: 'TST01', deptname: 'Help Desk', subject: 's', status: 'Answered', date: 'd', userid: 30,
      replies: { reply: [{ replyid: '0', message: 'open' }, { replyid: '1', message: 'r2', admin: 'A' }] },
      notes: [],
    });
    registerTicketThreadTool(server as any, { read } as any, logger, rateLimiter);

    expect(handlers.get_ticket_thread).toBeTypeOf('function');

    const res = await handlers.get_ticket_thread({ ticketid: 1001 });
    expect(read).toHaveBeenCalledWith('GetTicket', { ticketid: 1001 });

    const p = JSON.parse(res.content[0].text);
    expect(p.initial_message).toBe('open');
    expect(p.replies).toHaveLength(1);
    expect(p.replies[0].message).toBe('r2');

    expect(configs.get_ticket_thread.annotations.readOnlyHint).toBe(true);
    expect(configs.get_ticket_thread.annotations.destructiveHint).toBe(false);
  });
});
