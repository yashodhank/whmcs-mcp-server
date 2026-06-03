/**
 * Quote read tool (read-only, governed):
 *
 *   - get_quotes ← WHMCS `GetQuotes` (sales quotes; optional clientid filter).
 *
 * A quote is invoice-adjacent — the canonical mapper (src/canonical/quote.ts)
 * emits the `'invoice'` CanonicalEntity. The underlying WHMCS action is
 * `unverified` in the capability registry, but the tool still functions;
 * promotion is the capability registry's job.
 *
 * `clientid` is an OPTIONAL filter. When supplied AND running in client access
 * mode, the caller must be scoped to that client (ensureClientAllowed). With no
 * clientid in client mode the read is denied (a client may only read its own
 * quotes). Follows the standard governed-read list pattern: AUTH_SHAPE,
 * RateLimiter, READ_ONLY_ANNOTATIONS, governance projection via
 * governedListResult / applyGovernanceOrLegacy.
 */
import { z } from 'zod';
import {
  McpServer,
  type ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import {
  ensureToolAuth,
  isClientMode,
  ensureClientAllowed,
  clientModeDenied,
  AUTH_SHAPE,
} from '../security.js';
import {
  READ_ONLY_ANNOTATIONS,
  LIST_TOOL_OUTPUT_SCHEMA,
} from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedListResult,
  governanceEnabled,
  type GovernedToolResult,
} from '../governance/pipeline.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
// Import directly from the module (not the barrel): the canonical barrel
// (index.ts) is owned by the main thread and adds these re-exports there.
import {
  mapToCanonicalQuote,
  mapToCanonicalQuotes,
} from '../canonical/quote.js';

const TOOL_VERSION = 'v1';

/** Standard structured-error result for a recoverable read failure. */
function errorResult(message: string): GovernedToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ isError: true, error: message }),
      },
    ],
    isError: true,
  };
}

export function registerQuoteTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  if (!isToolAllowed('get_quotes')) {
    return;
  }

  const schema = z.object({
    clientid: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional WHMCS client id to filter quotes by. Required in client access mode (a client may only read its own quotes).'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(config.MCP_MAX_PAGE_SIZE)
      .default(25)
      .describe('Maximum number of quotes to return'),
    contract: z
      .string()
      .optional()
      .describe(
        'Requested data contract (honoured only if the resolved consumer permits it)'
      ),
  });

  const handler: ToolCallback<z.ZodRawShape> = (async (
    rawParams: Record<string, unknown>
  ) => {
    const params = rawParams as z.infer<typeof schema> & {
      auth_token?: string;
    };
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authToken =
        typeof params.auth_token === 'string' ? params.auth_token : undefined;
      const requestedContract =
        typeof params.contract === 'string' ? params.contract : undefined;

      const authErr = ensureToolAuth(params as Record<string, unknown>);
      if (authErr) return authErr;

      // Client-scope enforcement. In client access mode a clientid is
      // mandatory and must match the caller's scope; absent it, deny.
      if (isClientMode()) {
        if (params.clientid === undefined) {
          return clientModeDenied('get_quotes') as unknown as GovernedToolResult;
        }
        const scopeErr = ensureClientAllowed(params.clientid);
        if (scopeErr) return scopeErr as unknown as GovernedToolResult;
      }

      log.logToolCall('get_quotes', params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const readParams: Record<string, unknown> = {
        limitnum: params.limit,
      };
      if (params.clientid !== undefined) {
        readParams.userid = params.clientid;
      }

      const result = await whmcs.read<{ quotes?: { quote?: unknown } }>(
        'GetQuotes',
        readParams
      );

      // Same nesting the canonical mapper unwraps (quotes.quote, with a flat
      // `quote` fallback); each raw row is mapped per-row downstream.
      const nested =
        result.quotes?.quote ?? (result as { quote?: unknown }).quote;
      const rows = normalizeToArray<unknown>(nested);

      const items = mapToCanonicalQuotes(result).map((c) => c.data);
      const envelope = {
        total: items.length,
        count: items.length,
        offset: 0,
        limit: params.limit,
        note: 'Sales quotes (GetQuotes). A quote is invoice-adjacent: canonical entity is "invoice".',
      };

      log.logToolResult('get_quotes', true, Date.now() - t0);

      const legacy = { items, ...envelope };
      return applyGovernanceOrLegacy({
        enabled: governanceEnabled(),
        legacy,
        govern: () =>
          governedListResult({
            rows,
            mapItem: mapToCanonicalQuote,
            envelope,
            authToken,
            requestedContract,
          }),
      });
    } catch (e) {
      log.logToolResult(
        'get_quotes',
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
    'get_quotes',
    {
      description: `List WHMCS sales quotes (read-only), optionally filtered by client id: subject, stage/status, dates, currency, subtotal/tax/total and line items. A quote is invoice-adjacent. Version: ${TOOL_VERSION}`,
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      outputSchema: LIST_TOOL_OUTPUT_SCHEMA,
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}
