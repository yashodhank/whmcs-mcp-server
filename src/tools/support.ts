/**
 * Support & Ticketing Tools for WHMCS MCP Server
 * 
 * Tools: create_ticket, reply_ticket
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, isClientMode, requireClientModeClientId, ensureClientOwnership, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';

const TOOL_VERSION = 'v1';

/**
 * Create ticket input schema
 */
const createTicketSchema = z.object({
  deptid: z.number().int().positive('Department ID must be positive'),
  subject: z.string().min(1, 'Subject is required'),
  message: z.string().min(1, 'Message is required'),
  clientid: z.number().int().optional(),
  priority: z.enum(['Low', 'Medium', 'High']).default('Medium'),
  markdown: z.boolean().default(true),
  related_service_id: z.number().int().optional(),
});

/**
 * Reply ticket input schema
 */
const replyTicketSchema = z.object({
  ticketid: z.number().int().positive('Ticket ID must be positive'),
  message: z.string().min(1, 'Message is required'),
  type: z.enum(['Client', 'AdminNote', 'AdminPublic']),
  status_after_reply: z.enum(['Open', 'Answered', 'Closed']).optional(),
});

/**
 * Register support tools
 */
export function registerSupportTools(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  
  // ============================================
  // Tool: create_ticket
  // ============================================
  if (isToolAllowed('create_ticket')) {
    server.tool(
      'create_ticket',
      `Create a new support ticket in WHMCS. Version: ${TOOL_VERSION}`,
      { ...createTicketSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          let clientReplyClientId: number | undefined;
          if (isClientMode()) {
            const scopeError = requireClientModeClientId(params as Record<string, unknown>);
            if (scopeError) return scopeError;

            if (params.related_service_id) {
              const services = await whmcsClient.read<{
                products?: { product?: Array<{ id: number; clientid?: number }> };
              }>('GetClientsProducts', { serviceid: params.related_service_id, limitnum: 1 });

              const products = normalizeToArray<{ id: number; clientid?: number }>(services.products?.product);
              const service = products[0];

              if (!service || !service.clientid) {
                return {
                  content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                      isError: true,
                      error: 'Unable to validate related_service_id ownership for client access mode.',
                    }),
                  }],
                  isError: true,
                };
              }

              const ownershipError = ensureClientOwnership(service.clientid, { clientid: service.clientid });
              if (ownershipError) return ownershipError;
            }
          }

          toolLogger.logToolCall('create_ticket', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          const result = await whmcsClient.mutate<{
            id: number;
            tid: string;
            c?: string;
          }>('OpenTicket', {
            deptid: params.deptid,
            subject: params.subject,
            message: params.message,
            clientid: params.clientid,
            priority: params.priority,
            markdown: params.markdown,
            serviceid: params.related_service_id,
          }, {
            id: Math.floor(Math.random() * 10000),
            tid: `TID${Date.now()}`,
          });
          
          toolLogger.logToolResult('create_ticket', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ticketid: result.id,
                ticket_number: result.tid,
                deptid: params.deptid,
                subject: params.subject,
                status: 'Open',
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('create_ticket', false, Date.now() - startTime,
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
  // Tool: reply_ticket
  // ============================================
  if (isToolAllowed('reply_ticket')) {
    server.tool(
      'reply_ticket',
      `Reply to an existing support ticket. Use type='Client' for client-visible reply, 'AdminNote' for internal notes, 'AdminPublic' for admin reply visible to client. Version: ${TOOL_VERSION}`,
      { ...replyTicketSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          toolLogger.logToolCall('reply_ticket', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          if (isClientMode()) {
            if (params.type !== 'Client') {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    isError: true,
                    error: 'Only Client replies are allowed in client access mode.',
                  }),
                }],
                isError: true,
              };
            }

            // Validate ticket ownership
            const ticket = await whmcsClient.read<{
              ticketid: number;
              userid?: number;
              clientid?: number;
            }>('GetTicket', { ticketid: params.ticketid });

            const ownerId = ticket.userid ?? ticket.clientid;
            if (!ownerId) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    isError: true,
                    error: 'Unable to validate ticket ownership for client access mode.',
                  }),
                }],
                isError: true,
              };
            }

            const ownershipError = ensureClientOwnership(ownerId, params as Record<string, unknown>);
            if (ownershipError) return ownershipError;
            clientReplyClientId = ownerId;
          }

          // Use different API actions based on reply type
          let action = 'AddTicketReply';
          const apiParams: Record<string, unknown> = {
            ticketid: params.ticketid,
            message: params.message,
          };

          if (clientReplyClientId) {
            apiParams.clientid = clientReplyClientId;
          }
          
          if (params.type === 'AdminNote') {
            action = 'AddTicketNote';
          } else if (params.type === 'AdminPublic') {
            apiParams.admin = true;
          }
          
          // Update ticket status if specified
          if (params.status_after_reply) {
            apiParams.status = params.status_after_reply;
          }
          
          await whmcsClient.mutate(action, apiParams);
          
          toolLogger.logToolResult('reply_ticket', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ticketid: params.ticketid,
                reply_type: params.type,
                status: params.status_after_reply || 'Unchanged',
                success: true,
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('reply_ticket', false, Date.now() - startTime,
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
  // Tool: get_ticket_departments
  // ============================================
  if (isToolAllowed('get_ticket_departments')) {
    server.tool(
      'get_ticket_departments',
      `List all support ticket departments. Returns department IDs, names, and descriptions. Version: ${TOOL_VERSION}`,
      { ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          toolLogger.logToolCall('get_ticket_departments', {}, false);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          const result = await whmcsClient.read<{
            result: string;
            totalresults?: number;
            departments?: {
              department?: Array<{
                id: number;
                name: string;
                description?: string;
                awaitingreply?: number;
                opentickets?: number;
              }>;
            };
          }>('GetSupportDepartments');
          
          const departments = result.departments?.department ?? [];
          
          toolLogger.logToolResult('get_ticket_departments', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                total: result.totalresults || departments.length,
                departments: departments.map((d) => ({
                  id: d.id,
                  name: d.name,
                  description: d.description,
                  awaiting_reply: d.awaitingreply,
                  open_tickets: d.opentickets,
                })),
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('get_ticket_departments', false, Date.now() - startTime,
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
