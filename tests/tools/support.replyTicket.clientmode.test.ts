/**
 * Regression test for the reply_ticket client-mode bug.
 *
 * `clientReplyClientId` was declared in the create_ticket callback instead of
 * reply_ticket's, so client-mode reply_ticket threw
 * `ReferenceError: clientReplyClientId is not defined` right after the
 * ownership check. This test invokes the *real* registered handler in client
 * mode and asserts it resolves, does not throw, and forwards the resolved
 * client id to the WHMCS AddTicketReply call.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'id',
    WHMCS_SECRET: 'secret',
    MCP_MODE: 'full',
    MCP_RATE_LIMIT: 10,
    MCP_DEBUG: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [],
    MCP_LARGE_REFUND_THRESHOLD: 1000,
  },
  isToolAllowed: () => true,
  legacyWriteToolsEnabled: () => true,
}));

vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => true,
  requireClientModeClientId: () => null,
  ensureClientOwnership: () => null,
}));

import { registerSupportTools } from '../../src/tools/support.js';

describe('reply_ticket (client mode regression)', () => {
  it('resolves without ReferenceError and forwards the resolved client id', async () => {
    const handlers: Record<string, (params: any) => Promise<any>> = {};
    const server = {
      tool: (name: string, _desc: string, _schema: unknown, cb: any) => {
        handlers[name] = cb;
      },
      // get_ticket_departments now registers via the SDK `registerTool`
      // signature (it declares an outputSchema); stub it so registration of
      // the unrelated reply_ticket tool under test still succeeds.
      registerTool: (name: string, _cfg: unknown, cb: any) => {
        handlers[name] = cb;
      },
    };

    const mutate = vi
      .fn()
      .mockResolvedValue({ result: 'success' });
    const whmcsClient = {
      isReadOnly: () => false,
      read: vi.fn().mockResolvedValue({ ticketid: 100, userid: 42 }),
      mutate,
    };

    const childLogger = {
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      child: () => childLogger,
    };
    const logger = { child: () => childLogger };
    const rateLimiter = { tryConsume: () => true };

    registerSupportTools(
      server as any,
      whmcsClient as any,
      logger as any,
      rateLimiter as any
    );

    expect(handlers.reply_ticket).toBeTypeOf('function');

    const result = await handlers.reply_ticket({
      ticketid: 100,
      message: 'Customer reply',
      type: 'Client',
    });

    // Did not throw ReferenceError; returned a success payload
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(result.isError).toBeUndefined();

    // clientReplyClientId resolved in-scope and was wired into the API call
    expect(mutate).toHaveBeenCalledWith(
      'AddTicketReply',
      expect.objectContaining({ ticketid: 100, clientid: 42 })
    );
  });
});
