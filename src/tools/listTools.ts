/**
 * Shared read-only list-tool factory for WHMCS MCP Server.
 *
 * Builds paginated, read-only "list_*" tools that share a common
 * input contract (clientid + limit/offset), WHMCS pagination mapping
 * (limit -> limitnum, offset -> limitstart), normalization, and a
 * consistent response envelope: { items, total, count, offset, limit }.
 *
 * Exports `registerListTool` (single-tool factory) and `registerListTools`
 * (wires the standard list_client_* read tools).
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { ensureToolAuth, isClientMode, ensureClientAllowed, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';

/**
 * Standard MCP annotations for read-only list tools.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Configuration for a single read-only list tool.
 */
export interface ListToolConfig<T> {
  /** MCP tool name, e.g. `list_invoices`. */
  name: string;
  /** Human-readable tool description. */
  description: string;
  /** WHMCS API action, e.g. `GetInvoices`. */
  action: string;
  /** Which WHMCS param carries the client id. */
  clientParam: 'clientid' | 'userid';
  /** Top-level container key in the WHMCS response, e.g. `invoices`. */
  normalizerPath: string;
  /** Override for the singular wrapper key (defaults to a naive de-pluralize). */
  singular?: string;
  /** Extra zod shape merged into the base input schema. */
  extraSchema: z.ZodRawShape;
  /** Constant params always sent to the WHMCS API. */
  fixedParams?: Record<string, unknown>;
  /** Maps a raw WHMCS row to the public item shape. */
  mapItem: (raw: any) => T;
  /** Optional post-mapping sort applied to all items. */
  postSort?: (items: T[]) => T[];
  /** Extra fields merged into the response envelope. */
  extraPayload?: Record<string, unknown>;
}

/**
 * Register a single read-only, paginated list tool on the MCP server.
 *
 * No-op if the tool is disabled via `isToolAllowed`.
 */
export function registerListTool<T>(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter,
  c: ListToolConfig<T>
): void {
  if (!isToolAllowed(c.name)) return;

  const schema = z.object({
    clientid: z.number().int().positive(),
    limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(10),
    offset: z.number().int().min(0).default(0),
    ...c.extraSchema,
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
        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        if (isClientMode()) {
          const scopeErr = ensureClientAllowed(params.clientid);
          if (scopeErr) return scopeErr;
        }

        log.logToolCall(c.name, params, false);

        if (!rl.tryConsume()) throw new RateLimitError();

        const { limit = 10, offset = 0, clientid } = params;
        const apiParams: Record<string, unknown> = {
          [c.clientParam]: clientid,
          limitnum: limit,
          limitstart: offset,
          ...(c.fixedParams ?? {}),
        };
        for (const k of Object.keys(c.extraSchema)) {
          if (params[k] !== undefined) apiParams[k] = params[k];
        }

        const resp = await whmcs.read<Record<string, any>>(c.action, apiParams);

        const container = resp[c.normalizerPath];
        const singular =
          c.singular ??
          c.normalizerPath.replace(/ies$/, 'y').replace(/s$/, '');
        const rows = normalizeToArray<any>(
          container && typeof container === 'object'
            ? container[singular] ?? container
            : container
        );

        let items = rows.map(c.mapItem);
        if (c.postSort) items = c.postSort(items);

        log.logToolResult(c.name, true, Date.now() - t0);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                items,
                total: resp.totalresults ?? items.length,
                count: resp.numreturned ?? items.length,
                offset: resp.startnumber ?? offset,
                limit,
                ...(c.extraPayload ?? {}),
              }),
            },
          ],
        };
      } catch (e) {
        log.logToolResult(
          c.name,
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
    c.name,
    {
      description: c.description,
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}

/**
 * Register the read-only client-scoped list tools on the MCP server.
 *
 * Wires up 5 paginated list tools backed by the shared `registerListTool`
 * factory: services, domains, invoices, tickets, and orders.
 */
export function registerListTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  registerListTool(server, whmcs, logger, rl, {
    name: 'list_client_services',
    description:
      "List a client's products/services (read-only). Pagination via limit/offset.",
    action: 'GetClientsProducts',
    clientParam: 'clientid',
    normalizerPath: 'products',
    extraSchema: { status: z.string().optional() },
    mapItem: (p: any) => ({
      serviceid: p.id,
      pid: p.pid,
      product: p.name,
      domain: p.domain,
      status: p.status,
      billing_cycle: p.billingcycle,
      next_due_date: p.nextduedate,
      recurring_amount: p.recurringamount,
      payment_method: p.paymentmethod,
    }),
  });

  registerListTool(server, whmcs, logger, rl, {
    name: 'list_client_domains',
    description:
      "List a client's domains (read-only). Pagination via limit/offset.",
    action: 'GetClientsDomains',
    clientParam: 'clientid',
    normalizerPath: 'domains',
    extraSchema: { status: z.string().optional() },
    mapItem: (d: any) => ({
      domainid: d.id,
      domain: d.domainname,
      registrar: d.registrar,
      status: d.status,
      regdate: d.regdate,
      expiry_date: d.expirydate,
      next_due_date: d.nextduedate,
      donotrenew: d.donotrenew,
    }),
  });

  registerListTool(server, whmcs, logger, rl, {
    name: 'list_client_invoices',
    description:
      "List a client's invoices (read-only), newest first; optional status filter (Unpaid/Overdue/Paid/Cancelled/Refunded).",
    action: 'GetInvoices',
    clientParam: 'userid',
    normalizerPath: 'invoices',
    extraSchema: { status: z.string().optional() },
    fixedParams: { orderby: 'date', order: 'desc' },
    mapItem: (i: any) => ({
      invoiceid: i.id,
      invoicenum: i.invoicenum,
      date: i.date,
      duedate: i.duedate,
      datepaid: i.datepaid,
      status: i.status,
      total: i.total,
      balance: i.balance,
    }),
  });

  registerListTool(server, whmcs, logger, rl, {
    name: 'list_client_tickets',
    description:
      'List a client\'s support tickets (read-only). NOTE: WHMCS GetTickets clientid filter may MISS operator/admin-created tickets; for reliable retrieval use get_ticket_thread with a known ticketid/tid.',
    action: 'GetTickets',
    clientParam: 'clientid',
    normalizerPath: 'tickets',
    extraSchema: {
      status: z.string().optional(),
      deptid: z.number().int().optional(),
      subject: z.string().optional(),
    },
    mapItem: (t: any) => ({
      ticketid: t.id,
      tid: t.tid,
      subject: t.subject,
      status: t.status,
      deptname: t.deptname,
      date: t.date,
      lastreply: t.lastreply,
    }),
    postSort: (xs: any[]) =>
      [...xs].sort((a, b) =>
        String(b.lastreply || b.date).localeCompare(String(a.lastreply || a.date))
      ),
    extraPayload: {
      discovery: 'best-effort',
      note: 'GetTickets clientid discovery may miss operator/admin-created tickets; use get_ticket_thread by known ticketid/tid for reliable retrieval.',
    },
  });

  registerListTool(server, whmcs, logger, rl, {
    name: 'list_client_orders',
    description:
      "List a client's orders (read-only), newest first. Order not server-sorted by WHMCS; sorted client-side.",
    action: 'GetOrders',
    clientParam: 'userid',
    normalizerPath: 'orders',
    extraSchema: { status: z.string().optional() },
    mapItem: (o: any) => ({
      orderid: o.id,
      ordernum: o.ordernum,
      date: o.date,
      amount: o.amount,
      status: o.status,
      invoiceid: o.invoiceid,
      name: o.name,
    }),
    postSort: (xs: any[]) =>
      [...xs].sort((a, b) => String(b.date).localeCompare(String(a.date))),
  });
}
