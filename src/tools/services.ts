/**
 * Service Lifecycle Tools for WHMCS MCP Server
 * 
 * Tools: list_services, suspend_service, unsuspend_service, terminate_service
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { ensureToolAuth, clientModeDenied, isClientMode, ensureClientAllowed, AUTH_SHAPE } from '../security.js';
import { normalizeToArray, parseNumber } from '../whmcs/normalizers.js';

const TOOL_VERSION = 'v1';

interface WhmcsServiceSummary {
  id: number;
  clientid: number;
  orderid?: number;
  pid?: number;
  name?: string;
  translated_name?: string;
  groupname?: string;
  translated_groupname?: string;
  domain?: string;
  serverid?: number;
  servername?: string;
  regdate?: string;
  firstpaymentamount?: string;
  recurringamount?: string;
  paymentmethod?: string;
  paymentmethodname?: string;
  billingcycle?: string;
  nextduedate?: string;
  status?: string;
}

const listServicesSchema = z.object({
  status: z.enum(['Active', 'Suspended', 'Pending', 'Terminated', 'Cancelled', 'Fraud'])
    .default('Active')
    .describe('Service status to filter locally; use Active for currently paying/active clients'),
  clientid: z.number().int().positive('Client ID must be positive').optional(),
  paying_only: z.boolean().default(true)
    .describe('Only include services with recurringamount greater than zero'),
  limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(50),
  offset: z.number().int().min(0).default(0),
  fetch_limit: z.number().int().min(1).max(500).default(500)
    .describe('Page size for each WHMCS request before local filtering'),
  scan_limit: z.number().int().min(1).max(20000).default(10000)
    .describe('Maximum services to scan across WHMCS pages before local filtering'),
});

function monthlyRecurringAmount(service: WhmcsServiceSummary): number {
  const amount = parseNumber(service.recurringamount ?? '0');
  switch ((service.billingcycle ?? '').toLowerCase()) {
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'semi-annually':
    case 'semiannually':
      return amount / 6;
    case 'annually':
      return amount / 12;
    case 'biennially':
      return amount / 24;
    case 'triennially':
      return amount / 36;
    default:
      return 0;
  }
}

/**
 * Suspend service input schema
 */
const suspendServiceSchema = z.object({
  serviceid: z.number().int().positive('Service ID must be positive'),
  reason: z.string().optional(),
});

/**
 * Unsuspend service input schema
 */
const unsuspendServiceSchema = z.object({
  serviceid: z.number().int().positive('Service ID must be positive'),
});

/**
 * Terminate service input schema
 */
const terminateServiceSchema = z.object({
  serviceid: z.number().int().positive('Service ID must be positive'),
  confirm: z.literal(true, {
    message: 'Explicit confirm=true is required to terminate a service'
  }),
  confirm_with_unpaid: z.boolean().optional().describe('Set true to proceed even if client has unpaid invoices'),
});

/**
 * Register service tools
 */
export function registerServiceTools(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {

  // ============================================
  // Tool: list_services
  // ============================================
  if (isToolAllowed('list_services')) {
    server.tool(
      'list_services',
      `List WHMCS customer services/products from the hosting billing system, with local filtering by status and recurring amount. Use status='Active' and paying_only=true to answer questions like how many currently paying clients exist, which clients have active paid services, active subscriptions, hosting accounts, renewals, and estimated monthly recurring revenue. Version: ${TOOL_VERSION}`,
      { ...listServicesSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();

        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            if (!params.clientid) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'clientid is required in client access mode.' }) }],
                isError: true,
              };
            }
            const scopeError = ensureClientAllowed(params.clientid);
            if (scopeError) return scopeError;
          }

          toolLogger.logToolCall('list_services', params, false);

          const rawServices: WhmcsServiceSummary[] = [];
          let scanned = 0;
          let totalResults: number | undefined;

          while (scanned < params.scan_limit) {
            if (!rateLimiter.tryConsume()) {
              throw new RateLimitError();
            }

            const result = await whmcsClient.read<{
              products?: { product?: WhmcsServiceSummary[] };
              totalresults?: number;
            }>('GetClientsProducts', {
              clientid: params.clientid,
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

          const services = rawServices
            .filter((service) => service.status === params.status)
            .filter((service) => !params.paying_only || parseNumber(service.recurringamount ?? '0') > 0);

          const clientIds = new Set(services.map((service) => service.clientid));
          const recurringTotal = services.reduce((sum, service) => sum + parseNumber(service.recurringamount ?? '0'), 0);
          const estimatedMrr = services.reduce((sum, service) => sum + monthlyRecurringAmount(service), 0);
          const page = services.slice(params.offset, params.offset + params.limit);

          const mapped = page.map((service) => ({
            serviceid: service.id,
            clientid: service.clientid,
            orderid: service.orderid ?? null,
            productid: service.pid ?? null,
            product_name: service.translated_name || service.name || null,
            product_group: service.translated_groupname || service.groupname || null,
            domain: service.domain || null,
            status: service.status || null,
            billingcycle: service.billingcycle || null,
            recurringamount: service.recurringamount ?? null,
            estimated_monthly_recurring: Number(monthlyRecurringAmount(service).toFixed(2)),
            firstpaymentamount: service.firstpaymentamount ?? null,
            payment_method: service.paymentmethodname || service.paymentmethod || null,
            regdate: service.regdate || null,
            nextduedate: service.nextduedate || null,
            serverid: service.serverid ?? null,
            servername: service.servername || null,
          }));

          toolLogger.logToolResult('list_services', true, Date.now() - startTime);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: params.status,
                paying_only: params.paying_only,
                clientid: params.clientid ?? null,
                services: mapped,
                count: mapped.length,
                matched_services: services.length,
                unique_client_count: clientIds.size,
                recurring_total_raw: Number(recurringTotal.toFixed(2)),
                estimated_monthly_recurring: Number(estimatedMrr.toFixed(2)),
                offset: params.offset,
                limit: params.limit,
                scanned: rawServices.length,
                scan_limit: params.scan_limit,
                total: totalResults ?? rawServices.length,
                complete_scan: totalResults === undefined ? null : rawServices.length >= totalResults,
                note: 'For currently paying clients, use status=Active and paying_only=true; unique_client_count is the count of distinct WHMCS clients with at least one active paid service. If complete_scan is false, increase scan_limit before making conclusions.',
              }),
            }],
          };

        } catch (error) {
          toolLogger.logToolResult('list_services', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));

          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }

          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: suspend_service
  // ============================================
  if (isToolAllowed('suspend_service')) {
    server.tool(
      'suspend_service',
      `Suspend an active WHMCS service. Prefer this over termination when in doubt. Version: ${TOOL_VERSION}`,
      { ...suspendServiceSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            return clientModeDenied('suspend_service');
          }

          toolLogger.logToolCall('suspend_service', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          await whmcsClient.mutate('ModuleSuspend', {
            serviceid: params.serviceid,
            suspendreason: params.reason || 'Suspended via MCP',
          });
          
          toolLogger.logToolResult('suspend_service', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                serviceid: params.serviceid,
                status: 'Suspended',
                reason: params.reason || 'Suspended via MCP',
                success: true,
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('suspend_service', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: unsuspend_service
  // ============================================
  if (isToolAllowed('unsuspend_service')) {
    server.tool(
      'unsuspend_service',
      `Unsuspend a previously suspended WHMCS service. Version: ${TOOL_VERSION}`,
      { ...unsuspendServiceSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            return clientModeDenied('unsuspend_service');
          }

          toolLogger.logToolCall('unsuspend_service', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          await whmcsClient.mutate('ModuleUnsuspend', {
            serviceid: params.serviceid,
          });
          
          toolLogger.logToolResult('unsuspend_service', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                serviceid: params.serviceid,
                status: 'Active',
                success: true,
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('unsuspend_service', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: terminate_service
  // ============================================
  if (isToolAllowed('terminate_service')) {
    server.tool(
      'terminate_service',
      `Terminate a WHMCS service permanently. DANGEROUS: This action cannot be undone. Requires explicit confirm=true. Consider using suspend_service instead. Version: ${TOOL_VERSION}`,
      { ...terminateServiceSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            return clientModeDenied('terminate_service');
          }

          toolLogger.logToolCall('terminate_service', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          // Apply idempotency for dangerous operation
          const idempotencyKey = rateLimiter.generateIdempotencyKey('terminate_service', params.serviceid);
          const cached = rateLimiter.getCachedResult<object>(idempotencyKey);
          if (cached) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(cached) }],
            };
          }
          
          // Safety check: Fetch service details to get client ID
          const serviceDetails = await whmcsClient.read<{
            serviceid: number;
            clientid: number;
            status: string;
            product: string;
          }>('GetClientsProducts', { serviceid: params.serviceid, limitnum: 1 });
          
          // Check for unpaid invoices
          const clientInvoices = await whmcsClient.read<{
            invoices?: { invoice?: Array<{ id: number; status: string; total: string }> };
            totalresults?: number;
          }>('GetInvoices', {
            userid: serviceDetails.clientid,
            status: 'Unpaid',
            limitnum: 5,
          });
          
          const unpaidInvoices = clientInvoices.invoices?.invoice ?? [];
          
          if (Array.isArray(unpaidInvoices) && unpaidInvoices.length > 0 && !params.confirm_with_unpaid) {
            const totalUnpaid = unpaidInvoices.reduce((sum, inv) => sum + Number.parseFloat(inv.total || '0'), 0);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  requires_confirmation: true,
                  warning: `Client has ${unpaidInvoices.length} unpaid invoice(s) totaling $${totalUnpaid.toFixed(2)}. Consider collecting payment before termination.`,
                  unpaid_invoice_count: unpaidInvoices.length,
                  unpaid_total: totalUnpaid,
                  action: 'terminate_service',
                  suggestion: 'Call this tool again with confirm_with_unpaid=true to proceed despite unpaid invoices.',
                }),
              }],
            };
          }
          
          await whmcsClient.mutate('ModuleTerminate', {
            serviceid: params.serviceid,
          });
          
          const result = {
            serviceid: params.serviceid,
            status: 'Terminated',
            success: true,
            warning: 'Service has been permanently terminated.',
          };
          
          rateLimiter.cacheResult(idempotencyKey, result);
          
          toolLogger.logToolResult('terminate_service', true, Date.now() - startTime);
          
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('terminate_service', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
}
