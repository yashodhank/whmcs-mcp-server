/**
 * Service Lifecycle Tools for WHMCS MCP Server
 * 
 * Tools: suspend_service, unsuspend_service, terminate_service
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, clientModeDenied, isClientMode, AUTH_SHAPE } from '../security.js';

const TOOL_VERSION = 'v1';

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
