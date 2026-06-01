/**
 * Admin/reporting list tools (global scans) built on list-tool patterns:
 * read-only annotations, standard `{ items, total, count, offset, limit }`
 * envelope, optional governance projection, and bounded WHMCS paging.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import {
  ensureToolAuth,
  isClientMode,
  ensureClientAllowed,
  AUTH_SHAPE,
} from '../security.js';
import { normalizeToArray, parseNumber } from '../whmcs/normalizers.js';
import {
  READ_ONLY_ANNOTATIONS,
  LIST_TOOL_OUTPUT_SCHEMA,
} from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedListResult,
  governanceEnabled,
} from '../governance/pipeline.js';
import { mapToCanonicalInvoice, mapToCanonicalService } from '../canonical/index.js';

const TOOL_VERSION = 'v1';
const MAX_REPORTING_SCAN = 20_000;

interface WhmcsInvoiceSummary {
  id?: number;
  invoiceid?: number;
  invoicenum?: string;
  userid?: number;
  clientid?: number;
  firstname?: string;
  lastname?: string;
  companyname?: string;
  date: string;
  duedate: string;
  datepaid?: string;
  status?: string;
  subtotal?: string;
  tax?: string;
  tax2?: string;
  credit?: string;
  total?: string;
  balance?: string;
  paymentmethod?: string;
}

interface WhmcsServiceSummary {
  id?: number;
  userid?: number;
  clientid?: number;
  pid?: number;
  name?: string;
  domain?: string;
  status?: string;
  billingcycle?: string;
  nextduedate?: string;
  recurringamount?: string;
  paymentmethod?: string;
}

function parseSortableDate(value?: string): number {
  if (!value || value === '0000-00-00') return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDateInRange(value: string | undefined, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const timestamp = parseSortableDate(value);
  if (!timestamp) return false;
  if (from && timestamp < parseSortableDate(from)) return false;
  if (to && timestamp > parseSortableDate(to)) return false;
  return true;
}

function mapInvoiceSummary(invoice: WhmcsInvoiceSummary) {
  return {
    invoiceid: invoice.invoiceid ?? invoice.id,
    invoicenum: invoice.invoicenum || null,
    clientid: invoice.userid ?? invoice.clientid ?? null,
    client_name: [invoice.firstname, invoice.lastname].filter(Boolean).join(' ') || null,
    companyname: invoice.companyname || null,
    date: invoice.date,
    duedate: invoice.duedate,
    datepaid: invoice.datepaid || null,
    status: invoice.status,
    subtotal: invoice.subtotal ?? null,
    tax: invoice.tax ?? null,
    tax2: invoice.tax2 ?? null,
    credit_applied: invoice.credit ?? null,
    total: invoice.total,
    balance: invoice.balance ?? null,
    payment_method: invoice.paymentmethod || null,
  };
}

function mapServiceSummary(service: WhmcsServiceSummary) {
  return {
    serviceid: service.id,
    clientid: service.userid ?? service.clientid ?? null,
    pid: service.pid,
    product: service.name,
    domain: service.domain,
    status: service.status,
    billing_cycle: service.billingcycle,
    next_due_date: service.nextduedate,
    recurring_amount: service.recurringamount,
    payment_method: service.paymentmethod,
  };
}

export function registerReportingListTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  if (isToolAllowed('list_invoices')) {
    const listInvoicesSchema = z.object({
      status: z
        .enum(['Unpaid', 'Paid', 'Cancelled', 'Refunded', 'Collections', 'Overdue'])
        .optional(),
      clientid: z.number().int().positive().optional(),
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .optional(),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .optional(),
      duedate_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .optional(),
      duedate_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .optional(),
      datepaid_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .optional(),
      datepaid_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .optional(),
      limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(50),
      offset: z.number().int().min(0).default(0),
      fetch_limit: z.number().int().min(1).max(500).optional(),
      scan_limit: z.number().int().min(1).max(MAX_REPORTING_SCAN).optional(),
      sort_by: z
        .enum(['date', 'duedate', 'datepaid', 'invoiceid', 'total', 'balance'])
        .default('date'),
      sort_order: z.enum(['asc', 'desc']).default('desc'),
      contract: z
        .string()
        .optional()
        .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
    });

    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof listInvoicesSchema> & { auth_token?: string };
      const log = logger.child();
      const t0 = Date.now();
      try {
        const authToken =
          typeof params.auth_token === 'string' ? params.auth_token : undefined;
        const requestedContract =
          typeof params.contract === 'string' ? params.contract : undefined;

        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        if (isClientMode()) {
          if (!params.clientid) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    isError: true,
                    error: 'clientid is required in client access mode.',
                  }),
                },
              ],
              isError: true,
            };
          }
          const scopeErr = ensureClientAllowed(params.clientid);
          if (scopeErr) return scopeErr;
        }

        log.logToolCall('list_invoices', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const hasLocalDateFilters = Boolean(
          params.date_from ||
            params.date_to ||
            params.duedate_from ||
            params.duedate_to ||
            params.datepaid_from ||
            params.datepaid_to
        );
        const pageSize =
          params.fetch_limit ??
          (hasLocalDateFilters
            ? 500
            : Math.max(params.limit + params.offset, config.MCP_MAX_PAGE_SIZE));
        const scanLimit = params.scan_limit ?? (hasLocalDateFilters ? 10_000 : pageSize);

        const rawInvoices: WhmcsInvoiceSummary[] = [];
        let totalResults: number | undefined;
        let scanned = 0;

        while (scanned < scanLimit) {
          if (!rl.tryConsume()) throw new RateLimitError();

          const result = await whmcs.read<{
            invoices?: { invoice?: WhmcsInvoiceSummary[] };
            totalresults?: number;
          }>('GetInvoices', {
            status: params.status,
            userid: params.clientid,
            limitstart: scanned,
            limitnum: Math.min(pageSize, scanLimit - scanned),
          });

          totalResults = result.totalresults;
          const pageInvoices = normalizeToArray<WhmcsInvoiceSummary>(
            result.invoices?.invoice
          );
          rawInvoices.push(...pageInvoices);
          scanned += pageInvoices.length;
          if (pageInvoices.length === 0 || scanned >= (result.totalresults ?? scanned)) {
            break;
          }
        }

        const filtered = rawInvoices
          .filter((i) => isDateInRange(i.date, params.date_from, params.date_to))
          .filter((i) => isDateInRange(i.duedate, params.duedate_from, params.duedate_to))
          .filter((i) => isDateInRange(i.datepaid, params.datepaid_from, params.datepaid_to))
          .sort((a, b) => {
            const direction = params.sort_order === 'asc' ? 1 : -1;
            const sortKey = params.sort_by;
            const val = (inv: WhmcsInvoiceSummary) => {
              switch (sortKey) {
                case 'date':
                  return parseSortableDate(inv.date);
                case 'duedate':
                  return parseSortableDate(inv.duedate);
                case 'datepaid':
                  return parseSortableDate(inv.datepaid);
                case 'invoiceid':
                  return inv.invoiceid ?? inv.id ?? 0;
                case 'total':
                  return parseNumber(inv.total);
                case 'balance':
                  return parseNumber(inv.balance ?? inv.total);
              }
            };
            const primary = val(a) - val(b);
            if (primary !== 0) return primary * direction;
            return ((a.invoiceid ?? a.id ?? 0) - (b.invoiceid ?? b.id ?? 0)) * direction;
          });

        const page = filtered.slice(params.offset, params.offset + params.limit);
        const items = page.map(mapInvoiceSummary);
        const completeScan =
          totalResults === undefined ? null : rawInvoices.length >= totalResults;

        const envelope = {
          total: filtered.length,
          count: items.length,
          offset: params.offset,
          limit: params.limit,
          matched: filtered.length,
          scanned: rawInvoices.length,
          scan_limit: scanLimit,
          complete_scan: completeScan,
          status: params.status ?? null,
          clientid: params.clientid ?? null,
          sorted_locally: true,
          sort_by: params.sort_by,
          sort_order: params.sort_order,
          note: 'For revenue reports use status=Paid with datepaid_from/datepaid_to, then aggregate by clientid. If complete_scan is false, increase scan_limit.',
        };

        log.logToolResult('list_invoices', true, Date.now() - t0);

        const legacy = { items, ...envelope };
        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy,
          govern: () =>
            governedListResult({
              rows: page,
              mapItem: mapToCanonicalInvoice,
              envelope,
              authToken,
              requestedContract,
            }),
        });
      } catch (e) {
        log.logToolResult(
          'list_invoices',
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
      'list_invoices',
      {
        description: `List WHMCS invoices for billing/revenue reports (read-only). Use status and datepaid_* for revenue rankings; increase scan_limit when complete_scan is false. Version: ${TOOL_VERSION}`,
        inputSchema: { ...listInvoicesSchema.shape, ...AUTH_SHAPE },
        outputSchema: LIST_TOOL_OUTPUT_SCHEMA,
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }

  if (isToolAllowed('list_services')) {
    const listServicesSchema = z.object({
      status: z.string().optional().describe("e.g. 'Active' for paying clients"),
      clientid: z.number().int().positive().optional(),
      paying_only: z
        .boolean()
        .default(true)
        .describe('When true, only services with recurring_amount > 0'),
      limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(50),
      offset: z.number().int().min(0).default(0),
      fetch_limit: z.number().int().min(1).max(500).default(250),
      scan_limit: z.number().int().min(1).max(MAX_REPORTING_SCAN).default(10_000),
      contract: z
        .string()
        .optional()
        .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
    });

    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof listServicesSchema> & { auth_token?: string };
      const log = logger.child();
      const t0 = Date.now();
      try {
        const authToken =
          typeof params.auth_token === 'string' ? params.auth_token : undefined;
        const requestedContract =
          typeof params.contract === 'string' ? params.contract : undefined;

        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        if (isClientMode()) {
          if (!params.clientid) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    isError: true,
                    error: 'clientid is required in client access mode.',
                  }),
                },
              ],
              isError: true,
            };
          }
          const scopeErr = ensureClientAllowed(params.clientid);
          if (scopeErr) return scopeErr;
        }

        log.logToolCall('list_services', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const rawServices: WhmcsServiceSummary[] = [];
        let totalResults: number | undefined;
        let scanned = 0;

        while (scanned < params.scan_limit) {
          if (!rl.tryConsume()) throw new RateLimitError();

          const result = await whmcs.read<{
            products?: { product?: WhmcsServiceSummary[] };
            totalresults?: number;
          }>('GetClientsProducts', {
            clientid: params.clientid,
            status: params.status,
            limitstart: scanned,
            limitnum: Math.min(params.fetch_limit, params.scan_limit - scanned),
          });

          totalResults = result.totalresults;
          const page = normalizeToArray<WhmcsServiceSummary>(result.products?.product);
          rawServices.push(...page);
          scanned += page.length;
          if (page.length === 0 || scanned >= (result.totalresults ?? scanned)) {
            break;
          }
        }

        const filtered = rawServices.filter(
          (s) => !params.paying_only || parseNumber(s.recurringamount ?? '0') > 0
        );
        const uniqueClientIds = new Set(
          filtered.map((s) => s.userid ?? s.clientid).filter((id) => id !== undefined)
        );
        const page = filtered.slice(params.offset, params.offset + params.limit);
        const items = page.map(mapServiceSummary);
        const completeScan =
          totalResults === undefined ? null : rawServices.length >= totalResults;

        const envelope = {
          total: filtered.length,
          count: items.length,
          offset: params.offset,
          limit: params.limit,
          paying_only: params.paying_only,
          unique_client_count: uniqueClientIds.size,
          scanned: rawServices.length,
          scan_limit: params.scan_limit,
          complete_scan: completeScan,
          status: params.status ?? null,
          clientid: params.clientid ?? null,
          note: 'For currently paying clients use status=Active and paying_only=true; unique_client_count is distinct clients with active paid services.',
        };

        log.logToolResult('list_services', true, Date.now() - t0);

        const legacy = { items, ...envelope };
        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy,
          govern: () =>
            governedListResult({
              rows: page,
              mapItem: mapToCanonicalService,
              envelope,
              authToken,
              requestedContract,
            }),
        });
      } catch (e) {
        log.logToolResult(
          'list_services',
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
      'list_services',
      {
        description: `List WHMCS services for paying-client / MRR reports (read-only). Use status=Active and paying_only=true; see unique_client_count. Version: ${TOOL_VERSION}`,
        inputSchema: { ...listServicesSchema.shape, ...AUTH_SHAPE },
        outputSchema: LIST_TOOL_OUTPUT_SCHEMA,
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }
}
