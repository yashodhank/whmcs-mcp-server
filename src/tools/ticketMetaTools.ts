/**
 * Track B — ticket operational-metadata read tools (read-only, governed).
 *
 *  - get_ticket_counts     ← WHMCS `GetTicketCounts`   (counts per status /
 *                            department; aggregate counters + display labels).
 *  - list_support_statuses ← WHMCS `GetSupportStatuses` (status titles + the
 *                            current ticket count per status).
 *
 * Both are GLOBAL/admin reads (not client-scoped) carrying NO per-customer PII
 * — only aggregate counts (public.safe) and status/department display labels
 * (business.label). They follow the standard governed-read pattern:
 * READ_ONLY_ANNOTATIONS, AUTH_SHAPE, RateLimiter, governance projection via the
 * pipeline, capability-aware (capability is `unverified`; the tools still
 * function, status is informational), single-entity governedToolResult.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, AUTH_SHAPE } from '../security.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governanceEnabled,
  type GovernedToolResult,
} from '../governance/pipeline.js';
import {
  mapToCanonicalTicketCounts,
  mapToCanonicalSupportStatuses,
} from '../canonical/ticketMeta.js';

const TOOL_VERSION = 'v1';

/** Standard structured-error result for a recoverable read failure. */
function errorResult(message: string): GovernedToolResult {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ isError: true, error: message }) },
    ],
    isError: true,
  };
}

export function registerTicketMetaTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  /* ──────────────────────────  get_ticket_counts  ─────────────────────────── */
  if (isToolAllowed('get_ticket_counts')) {
    const schema = z.object({
      contract: z
        .string()
        .optional()
        .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
    });

    const handler: ToolCallback<z.ZodRawShape> = (async (
      rawParams: Record<string, unknown>
    ) => {
      const params = rawParams as z.infer<typeof schema> & { auth_token?: string };
      const log = logger.child();
      const t0 = Date.now();
      try {
        const authToken =
          typeof params.auth_token === 'string' ? params.auth_token : undefined;
        const requestedContract =
          typeof params.contract === 'string' ? params.contract : undefined;

        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        log.logToolCall('get_ticket_counts', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const result = await whmcs.read<Record<string, unknown>>(
          'GetTicketCounts',
          {}
        );
        const canonical = mapToCanonicalTicketCounts(result);

        log.logToolResult('get_ticket_counts', true, Date.now() - t0);

        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy: { entity: canonical.entity, data: canonical.data },
          govern: () =>
            governedToolResult({ canonical, authToken, requestedContract }),
        });
      } catch (e) {
        log.logToolResult(
          'get_ticket_counts',
          false,
          Date.now() - t0,
          e instanceof Error ? e.message : String(e)
        );
        if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
          return errorResult((e as Error).message);
        }
        throw e;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.registerTool(
      'get_ticket_counts',
      {
        description: `Get WHMCS support ticket counts per status and per department (read-only operational metadata; aggregate counts + display labels, no PII). Version: ${TOOL_VERSION}`,
        inputSchema: { ...schema.shape, ...AUTH_SHAPE },
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }

  /* ────────────────────────  list_support_statuses  ───────────────────────── */
  if (isToolAllowed('list_support_statuses')) {
    const schema = z.object({
      contract: z
        .string()
        .optional()
        .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
    });

    const handler: ToolCallback<z.ZodRawShape> = (async (
      rawParams: Record<string, unknown>
    ) => {
      const params = rawParams as z.infer<typeof schema> & { auth_token?: string };
      const log = logger.child();
      const t0 = Date.now();
      try {
        const authToken =
          typeof params.auth_token === 'string' ? params.auth_token : undefined;
        const requestedContract =
          typeof params.contract === 'string' ? params.contract : undefined;

        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        log.logToolCall('list_support_statuses', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const result = await whmcs.read<Record<string, unknown>>(
          'GetSupportStatuses',
          {}
        );
        const canonical = mapToCanonicalSupportStatuses(result);

        log.logToolResult('list_support_statuses', true, Date.now() - t0);

        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy: { entity: canonical.entity, data: canonical.data },
          govern: () =>
            governedToolResult({ canonical, authToken, requestedContract }),
        });
      } catch (e) {
        log.logToolResult(
          'list_support_statuses',
          false,
          Date.now() - t0,
          e instanceof Error ? e.message : String(e)
        );
        if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
          return errorResult((e as Error).message);
        }
        throw e;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.registerTool(
      'list_support_statuses',
      {
        description: `List WHMCS support ticket statuses with the current ticket count per status (read-only operational metadata; titles + counts, no PII). Version: ${TOOL_VERSION}`,
        inputSchema: { ...schema.shape, ...AUTH_SHAPE },
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }
}
