/**
 * Order Management Tools for WHMCS MCP Server
 *
 * Tools: list_products, accept_order
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { ensureToolAuth, clientModeDenied, isClientMode, AUTH_SHAPE } from '../security.js';
import { normalizeToArray, whmcsToBool } from '../whmcs/normalizers.js';

const TOOL_VERSION = 'v1';

/**
 * MCP tool annotation hints (spec 2025-11-25). UNTRUSTED UX hints only;
 * governance/capability registry remains the authority. openWorldHint true —
 * orders touch the external WHMCS/provisioning system.
 */
/** Read-only (list_products). */
const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Additive order acceptance (accept_order): non-destructive. Idempotent — the
 * tool dedupes via an idempotency key and re-accepting an order is a no-op.
 */
const ACCEPT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Product structure from GetProducts
 *
 * Note: `pricing` is a passthrough of whatever the raw WHMCS GetProducts API
 * returns under the `pricing` key — the shape is opaque to this tool and may
 * vary across WHMCS versions. We intentionally do not impose a stricter type:
 * consumers project on the keys they need (currency code → cycle → price).
 */
interface WhmcsProduct {
  pid: number;
  gid: number;
  name: string;
  description: string;
  type: string;
  hidden: number | string;
  groupname?: string;
  slug?: string;
  product_url?: string;
  pricing?: Record<string, unknown>;
}

/**
 * List products input schema
 */
const listProductsSchema = z.object({
  group_id: z.number().int().optional(),
  name_contains: z.string().optional(),
  include_hidden: z.boolean().default(false),
  limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(50),
  include_pricing: z
    .boolean()
    .default(true)
    .describe('include the pricing block per currency/cycle; set false to reduce token cost'),
  currency: z
    .string()
    .optional()
    .describe('filter pricing to a single currency to reduce token cost'),
});

/**
 * Accept order input schema
 */
const acceptOrderSchema = z.object({
  orderid: z.number().int().positive('Order ID must be positive'),
  autosetup: z.boolean().default(true),
  sendemail: z.boolean().default(true),
  serverid: z.number().int().optional(),
});

/**
 * Register order tools
 */
export function registerOrderTools(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  // ============================================
  // Tool: list_products
  // ============================================
  if (isToolAllowed('list_products')) {
    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof listProductsSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        toolLogger.logToolCall('list_products', params, false);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        const result = await whmcsClient.read<{
          products?: { product?: WhmcsProduct[] };
          totalresults?: number;
        }>('GetProducts', {
          gid: params.group_id,
        });

        let products = normalizeToArray<WhmcsProduct>(result.products?.product);

        // Filter by name
        if (params.name_contains) {
          const search = params.name_contains.toLowerCase();
          products = products.filter((p) => p.name.toLowerCase().includes(search));
        }

        // Filter hidden unless requested
        if (!params.include_hidden) {
          products = products.filter((p) => !whmcsToBool(p.hidden));
        }

        // Apply limit
        products = products.slice(0, params.limit);

        const mapped = products.map((p) => {
          // Base projection — backward-compatible field shapes.
          const row: Record<string, unknown> = {
            id: p.pid,
            name: p.name,
            group_name: p.groupname || null,
            description:
              typeof p.description === 'string' ? p.description.substring(0, 200) : null,
            type: p.type,
            isHidden: whmcsToBool(p.hidden),
            // gid is always present in WHMCS GetProducts responses.
            gid: p.gid,
          };
          // slug / product_url are additive — emit only when present in raw response.
          if (p.slug !== undefined) row.slug = p.slug;
          if (p.product_url !== undefined) row.product_url = p.product_url;
          // pricing is a passthrough of whatever GetProducts returns; shape is
          // opaque to the tool. Optional `currency` filter projects to a single
          // currency key inside the pricing block to reduce token cost.
          if (params.include_pricing && p.pricing !== undefined) {
            if (params.currency) {
              const filtered: Record<string, unknown> = {};
              if (p.pricing[params.currency] !== undefined) {
                filtered[params.currency] = p.pricing[params.currency];
              }
              row.pricing = filtered;
            } else {
              row.pricing = p.pricing;
            }
          }
          return row;
        });

        toolLogger.logToolResult('list_products', true, Date.now() - startTime);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                products: mapped,
                count: mapped.length,
              }),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'list_products',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.registerTool(
      'list_products',
      {
        description: `List available WHMCS products with optional filtering. Version: ${TOOL_VERSION}`,
        inputSchema: { ...listProductsSchema.shape, ...AUTH_SHAPE },
        annotations: READ_ANNOTATIONS,
      },
      handler
    );
  }

  // ============================================
  // Tool: accept_order
  // ============================================
  if (isToolAllowed('accept_order')) {
    // Boundary cast: same rationale as list_products above.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof acceptOrderSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('accept_order');
        }

        toolLogger.logToolCall('accept_order', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        // Apply idempotency
        const idempotencyKey = rateLimiter.generateIdempotencyKey('accept_order', params.orderid);
        const cached = rateLimiter.getCachedResult(idempotencyKey);
        if (cached) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(cached) }],
          };
        }

        const result = await whmcsClient.mutate<{
          result: string;
          orderid?: number;
        }>('AcceptOrder', {
          orderid: params.orderid,
          autosetup: params.autosetup,
          sendemail: params.sendemail,
          serverid: params.serverid,
        });

        const response = {
          orderid: params.orderid,
          status: 'Accepted',
          autosetup: params.autosetup,
          result: result.result,
        };

        rateLimiter.cacheResult(idempotencyKey, response);

        toolLogger.logToolResult('accept_order', true, Date.now() - startTime);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'accept_order',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.registerTool(
      'accept_order',
      {
        description: `Accept a pending WHMCS order. WARNING: If autosetup is true, WHMCS will attempt to contact the provisioning server and may fail if it is offline. Version: ${TOOL_VERSION}`,
        inputSchema: { ...acceptOrderSchema.shape, ...AUTH_SHAPE },
        annotations: ACCEPT_ANNOTATIONS,
      },
      handler
    );
  }
}
