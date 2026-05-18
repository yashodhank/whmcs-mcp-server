/**
 * Read-only MCP tool: get_ticket_thread.
 *
 * Fetches a full WHMCS support ticket thread by numeric ticket id and
 * formats it via the shared, pure `formatTicketThread` (same payload as
 * the `ticket-thread` resource). Mirrors the structure of `registerListTool`.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, isClientMode, ensureClientOwnership, AUTH_SHAPE } from '../security.js';
import { formatTicketThread } from '../whmcs/ticketThread.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governanceEnabled,
} from '../governance/pipeline.js';
import { mapToCanonicalTicket } from '../canonical/index.js';

/**
 * Register the read-only `get_ticket_thread` tool on the MCP server.
 *
 * No-op if the tool is disabled via `isToolAllowed`.
 */
export function registerTicketThreadTool(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  if (!isToolAllowed('get_ticket_thread')) return;

  const schema = z.object({
    ticketid: z.number().int().positive(),
    contract: z
      .string()
      .optional()
      .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
  });

  // The shared `ensure*` helpers return a local `McpToolResponse` type that
  // lacks the SDK's `[x: string]: unknown` index signature, so the inferred
  // callback return type is not structurally assignable to `ToolCallback`.
  // This is a type-only boundary cast; runtime behavior is unchanged and the
  // returned envelope is a valid MCP tool result.
  const handler: ToolCallback<z.ZodRawShape> = (async (params: any) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      // Capture the bearer token before ensureToolAuth strips it.
      const pview = params as Record<string, unknown>;
      const authToken =
        typeof pview.auth_token === 'string' ? pview.auth_token : undefined;
      const requestedContract =
        typeof pview.contract === 'string' ? pview.contract : undefined;

      const authErr = ensureToolAuth(params as Record<string, unknown>);
      if (authErr) return authErr;

      log.logToolCall('get_ticket_thread', params, false);

      if (!rateLimiter.tryConsume()) throw new RateLimitError();

      const ticket = await whmcsClient.read<Record<string, any>>('GetTicket', {
        ticketid: params.ticketid,
      });

      if (isClientMode()) {
        const ownerId = ticket.userid ?? ticket.clientid;
        if (!ownerId) {
          log.logToolResult('get_ticket_thread', false, Date.now() - t0, 'ownership unresolved');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: 'Unable to validate ticket ownership for client access mode.' }),
              },
            ],
            isError: true,
          };
        }
        const ownershipErr = ensureClientOwnership(ownerId, params as Record<string, unknown>);
        if (ownershipErr) return ownershipErr;
      }

      const payload = formatTicketThread(ticket);

      log.logToolResult('get_ticket_thread', true, Date.now() - t0);

      return applyGovernanceOrLegacy({
        enabled: governanceEnabled(),
        legacy: payload,
        govern: () =>
          governedToolResult({
            canonical: mapToCanonicalTicket(ticket),
            authToken,
            requestedContract,
          }),
      });
    } catch (e) {
      log.logToolResult(
        'get_ticket_thread',
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ isError: true, error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    'get_ticket_thread',
    {
      description:
        'Read a full WHMCS support ticket thread by numeric ticket id (read-only). initial_message = opening post; replies = subsequent.',
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}
