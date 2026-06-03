/**
 * Track A — infrastructure / reference read tools (read-only, governed).
 *
 *  - get_server_health  ← WHMCS `GetServers` (per-server operational record).
 *  - get_tld_pricing    ← WHMCS `GetTLDPricing` (+ `GetRegistrars` label), the
 *                          static per-TLD register/renew/transfer price book.
 *
 * Both are GLOBAL/admin reads (not client-scoped) carrying no per-customer PII,
 * so they take no clientid and are not gated by client-mode scope. They follow
 * the standard governed-read pattern: READ_ONLY_ANNOTATIONS, AUTH_SHAPE,
 * RateLimiter, governance projection via the pipeline, capability-aware (status
 * is informational — the tools still function while `unverified`).
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, AUTH_SHAPE } from '../security.js';
import {
  READ_ONLY_ANNOTATIONS,
  LIST_TOOL_OUTPUT_SCHEMA,
} from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governedListResult,
  governanceEnabled,
  type GovernedToolResult,
} from '../governance/pipeline.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import {
  mapToCanonicalServer,
  mapToCanonicalServers,
  mapToCanonicalTldPricing,
} from '../canonical/index.js';

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

export function registerInfraTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  /* ───────────────────────────  get_server_health  ─────────────────────── */
  if (isToolAllowed('get_server_health')) {
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

        log.logToolCall('get_server_health', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const result = await whmcs.read<{ servers?: { server?: unknown } }>(
          'GetServers',
          {}
        );
        // Same nesting the canonical mapper unwraps (servers.server, with a
        // flat `server` fallback); each raw row is mapped per-row downstream.
        const nested = result.servers?.server ?? (result as { server?: unknown }).server;
        const rows = normalizeToArray<unknown>(nested);

        const items = mapToCanonicalServers(result).map((c) => c.data);
        const envelope = {
          total: items.length,
          count: items.length,
          offset: 0,
          limit: items.length,
          note: 'Operational server inventory (GetServers). IP/diagnostic fields are visible to operator contracts only; never to LLM/client contracts.',
        };

        log.logToolResult('get_server_health', true, Date.now() - t0);

        const legacy = { items, ...envelope };
        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy,
          govern: () =>
            governedListResult({
              rows,
              mapItem: mapToCanonicalServer,
              envelope,
              authToken,
              requestedContract,
            }),
        });
      } catch (e) {
        log.logToolResult(
          'get_server_health',
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
      'get_server_health',
      {
        description: `List WHMCS provisioning servers with operational health (read-only): name, hostname, active/disabled, max/active accounts, load. Version: ${TOOL_VERSION}`,
        inputSchema: { ...schema.shape, ...AUTH_SHAPE },
        outputSchema: LIST_TOOL_OUTPUT_SCHEMA,
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }

  /* ────────────────────────────  get_tld_pricing  ──────────────────────── */
  if (isToolAllowed('get_tld_pricing')) {
    const schema = z.object({
      currency: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('WHMCS currency id; defaults to the install default currency'),
      include_registrar: z
        .boolean()
        .default(true)
        .describe('Also resolve the active registrar module label via GetRegistrars'),
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

        log.logToolCall('get_tld_pricing', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const pricingParams: Record<string, unknown> = {};
        if (params.currency !== undefined) {
          pricingParams.currencyid = params.currency;
        }
        const pricing = await whmcs.read<Record<string, unknown>>(
          'GetTLDPricing',
          pricingParams
        );

        let registrarRaw: unknown;
        if (params.include_registrar) {
          if (!rl.tryConsume()) throw new RateLimitError();
          try {
            registrarRaw = await whmcs.read<Record<string, unknown>>(
              'GetRegistrars',
              {}
            );
          } catch {
            // Registrar label is best-effort enrichment; pricing is the payload.
            registrarRaw = undefined;
          }
        }

        const canonical = mapToCanonicalTldPricing(pricing, registrarRaw);

        log.logToolResult('get_tld_pricing', true, Date.now() - t0);

        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy: { entity: canonical.entity, data: canonical.data },
          govern: () =>
            governedToolResult({
              canonical,
              authToken,
              requestedContract,
            }),
        });
      } catch (e) {
        log.logToolResult(
          'get_tld_pricing',
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
      'get_tld_pricing',
      {
        description: `Get WHMCS per-TLD register/renew/transfer pricing (read-only, static reference data) for one currency, with the active registrar label. Version: ${TOOL_VERSION}`,
        inputSchema: { ...schema.shape, ...AUTH_SHAPE },
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }
}
