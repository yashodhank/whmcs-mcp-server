/**
 * MCP Resources for WHMCS
 * 
 * Provides read-only resources for passive LLM context
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter } from '../rateLimiter.js';
import { ensureResourceAuth, isClientMode, ensureClientAllowed, ensureClientOwnership } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';

/**
 * Register all WHMCS resources
 */
export function registerResources(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  
  // ============================================
  // Resource: Client Summary
  // ============================================
  server.resource(
    'client-summary',
    new ResourceTemplate('whmcs://clients/{clientid}/summary{?token,auth_token}', { list: undefined }),
    async (uri, params) => {
      const clientid = Number(Array.isArray(params.clientid) ? params.clientid[0] : params.clientid);
      const resourceLogger = logger.child();
      
      try {
        const authResult = ensureResourceAuth(uri);
        if (!authResult.ok) return authResult.response;

        if (isClientMode()) {
          const scopeError = ensureClientAllowed(clientid);
          if (scopeError) {
            return {
              contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }),
              }],
            };
          }
        }

        resourceLogger.info('Fetching client summary', { clientid });
        
        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }),
            }],
          };
        }
        
        const client = await whmcsClient.read<{
          id: number;
          firstname: string;
          lastname: string;
          email: string;
          status: string;
          credit: string;
          currency_code: string;
          numproducts?: number;
          numdomains?: number;
        }>('GetClientsDetails', { clientid });
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              clientid: client.id,
              name: `${client.firstname} ${client.lastname}`,
              email: client.email,
              status: client.status,
              credit_balance: client.credit,
              currency: client.currency_code,
              product_count: client.numproducts || 0,
              domain_count: client.numdomains || 0,
            }, null, 2),
          }],
        };
        
      } catch (error) {
        resourceLogger.error('Failed to fetch client summary', {
          clientid,
          error: error instanceof Error ? error.message : String(error),
        });
        
        if (error instanceof WhmcsBusinessError) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: error.message }),
            }],
          };
        }
        
        throw error;
      }
    }
  );
  
  // ============================================
  // Resource: Invoice History
  // ============================================
  server.resource(
    'invoice-history',
    new ResourceTemplate('whmcs://invoices/{invoiceid}/history{?token,auth_token}', { list: undefined }),
    async (uri, params) => {
      const invoiceid = params.invoiceid;
      const resourceLogger = logger.child();
      
      try {
        const authResult = ensureResourceAuth(uri);
        if (!authResult.ok) return authResult.response;

        resourceLogger.info('Fetching invoice history', { invoiceid });
        
        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }),
            }],
          };
        }
        
        interface InvoiceItem {
          id: number;
          description: string;
          amount: string;
        }
        
        interface Transaction {
          id: number;
          date: string;
          gateway: string;
          amountin: string;
          amountout: string;
        }
        
        const invoice = await whmcsClient.read<{
          invoiceid: number;
          userid: number;
          date: string;
          duedate: string;
          datepaid?: string;
          status: string;
          total: string;
          balance: string;
          items?: { item?: InvoiceItem[] };
          transactions?: { transaction?: Transaction[] };
        }>('GetInvoice', { invoiceid });

        if (isClientMode()) {
          const ownershipError = ensureClientOwnership(invoice.userid, { clientid: invoice.userid });
          if (ownershipError) {
            return {
              contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }),
              }],
            };
          }
        }
        
        const items = normalizeToArray<InvoiceItem>(invoice.items?.item);
        const transactions = normalizeToArray<Transaction>(invoice.transactions?.transaction);
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              invoiceid: invoice.invoiceid,
              clientid: invoice.userid,
              date: invoice.date,
              duedate: invoice.duedate,
              datepaid: invoice.datepaid,
              status: invoice.status,
              total: invoice.total,
              balance: invoice.balance,
              items: items.map((i) => ({
                id: i.id,
                description: i.description,
                amount: i.amount,
              })),
              transactions: transactions.map((t) => ({
                id: t.id,
                date: t.date,
                gateway: t.gateway,
                amount_in: t.amountin,
                amount_out: t.amountout,
              })),
            }, null, 2),
          }],
        };
        
      } catch (error) {
        resourceLogger.error('Failed to fetch invoice history', {
          invoiceid,
          error: error instanceof Error ? error.message : String(error),
        });
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
          }],
        };
      }
    }
  );
  
  // ============================================
  // Resource: Ticket Thread
  // ============================================
  server.resource(
    'ticket-thread',
    new ResourceTemplate('whmcs://tickets/{ticketid}/thread{?token,auth_token}', { list: undefined }),
    async (uri, params) => {
      const ticketid = params.ticketid;
      const resourceLogger = logger.child();
      
      try {
        const authResult = ensureResourceAuth(uri);
        if (!authResult.ok) return authResult.response;

        resourceLogger.info('Fetching ticket thread', { ticketid });
        
        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }),
            }],
          };
        }
        
        interface Reply {
          replyid: number;
          date: string;
          name: string;
          message: string;
          admin?: string;
        }
        
        interface Note {
          noteid: number;
          date: string;
          admin: string;
          message: string;
        }
        
        const ticket = await whmcsClient.read<{
          ticketid: number;
          tid: string;
          deptname: string;
          subject: string;
          status: string;
          date: string;
          message: string;
          userid?: number;
          clientid?: number;
          replies?: { reply?: Reply[] };
          notes?: { note?: Note[] };
        }>('GetTicket', { ticketid });

        if (isClientMode()) {
          const ownerId = ticket.userid ?? ticket.clientid;
          if (!ownerId) {
            return {
              contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Unable to validate ticket ownership for client access mode.' }),
              }],
            };
          }
          const ownershipError = ensureClientOwnership(ownerId, { clientid: ownerId });
          if (ownershipError) {
            return {
              contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }),
              }],
            };
          }
        }
        
        const replies = normalizeToArray<Reply>(ticket.replies?.reply);
        const notes = normalizeToArray<Note>(ticket.notes?.note);
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              ticketid: ticket.ticketid,
              ticket_number: ticket.tid,
              department: ticket.deptname,
              subject: ticket.subject,
              status: ticket.status,
              date: ticket.date,
              initial_message: ticket.message,
              replies: replies.map((r) => ({
                id: r.replyid,
                date: r.date,
                from: r.admin || r.name,
                is_admin: !!r.admin,
                message: r.message,
              })),
              internal_notes: notes.map((n) => ({
                id: n.noteid,
                date: n.date,
                admin: n.admin,
                message: n.message,
              })),
            }, null, 2),
          }],
        };
        
      } catch (error) {
        resourceLogger.error('Failed to fetch ticket thread', {
          ticketid,
          error: error instanceof Error ? error.message : String(error),
        });
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
          }],
        };
      }
    }
  );
  
  // ============================================
  // Resource: Client Activity Log
  // ============================================
  server.resource(
    'client-log',
    new ResourceTemplate('whmcs://clients/{clientid}/log{?token,auth_token}', { list: undefined }),
    async (uri, params) => {
      const clientid = Number(Array.isArray(params.clientid) ? params.clientid[0] : params.clientid);
      const resourceLogger = logger.child();
      
      try {
        const authResult = ensureResourceAuth(uri);
        if (!authResult.ok) return authResult.response;

        if (isClientMode()) {
          const scopeError = ensureClientAllowed(clientid);
          if (scopeError) {
            return {
              contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }),
              }],
            };
          }
        }

        resourceLogger.info('Fetching client activity log', { clientid });
        
        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }),
            }],
          };
        }
        
        // Fetch recent orders
        const orders = await whmcsClient.read<{
          orders?: { order?: Array<{
            id: number;
            date: string;
            status: string;
            amount: string;
          }> };
          totalresults?: number;
        }>('GetOrders', { userid: clientid, limitnum: 10 });
        
        // Fetch recent invoices
        const invoices = await whmcsClient.read<{
          invoices?: { invoice?: Array<{
            id: number;
            date: string;
            duedate: string;
            status: string;
            total: string;
          }> };
          totalresults?: number;
        }>('GetInvoices', { userid: clientid, limitnum: 10 });
        
        // Fetch recent tickets
        const tickets = await whmcsClient.read<{
          tickets?: { ticket?: Array<{
            id: number;
            date: string;
            subject: string;
            status: string;
          }> };
          totalresults?: number;
        }>('GetTickets', { clientid, limitnum: 10, status: '' });
        
        // Define interfaces for type safety
        interface OrderSummary {
          id: number;
          date: string;
          status: string;
          amount: string;
        }
        
        interface InvoiceSummary {
          id: number;
          date: string;
          duedate: string;
          status: string;
          total: string;
        }
        
        interface TicketSummary {
          id: number;
          date: string;
          subject: string;
          status: string;
        }
        
        const recentOrders = normalizeToArray<OrderSummary>(orders.orders?.order);
        const recentInvoices = normalizeToArray<InvoiceSummary>(invoices.invoices?.invoice);
        const recentTickets = normalizeToArray<TicketSummary>(tickets.tickets?.ticket);
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              clientid,
              recent_orders: recentOrders.map((o) => ({
                id: o.id,
                date: o.date,
                status: o.status,
                amount: o.amount,
              })),
              recent_invoices: recentInvoices.map((i) => ({
                id: i.id,
                date: i.date,
                duedate: i.duedate,
                status: i.status,
                total: i.total,
              })),
              recent_tickets: recentTickets.map((t) => ({
                id: t.id,
                date: t.date,
                subject: t.subject,
                status: t.status,
              })),
            }, null, 2),
          }],
        };
        
      } catch (error) {
        resourceLogger.error('Failed to fetch client activity log', {
          clientid,
          error: error instanceof Error ? error.message : String(error),
        });
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
          }],
        };
      }
    }
  );
  
  // ============================================
  // Resource: System Activity
  // ============================================
  server.resource(
    'system-activity',
    new ResourceTemplate('whmcs://system/activity{?token,auth_token}', { list: undefined }),
    async (uri) => {
      const resourceLogger = logger.child();
      
      try {
        const authResult = ensureResourceAuth(uri);
        if (!authResult.ok) return authResult.response;

        if (isClientMode()) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'System activity is not available in client access mode.' }),
            }],
          };
        }

        resourceLogger.info('Fetching system activity');
        
        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }),
            }],
          };
        }
        
        // Fetch recent activity log
        const activityLog = await whmcsClient.read<{
          activity?: { entry?: Array<{
            id: number;
            date: string;
            description: string;
            user?: string;
            ipaddr?: string;
          }> };
          totalresults?: number;
        }>('GetActivityLog', { limitnum: 25 });
        
        // Fetch admin logs for recent admin actions
        const adminLogs = await whmcsClient.read<{
          logs?: { log?: Array<{
            id: number;
            date: string;
            action: string;
            adminusername: string;
          }> };
          totalresults?: number;
        }>('GetAdminLog', { limitnum: 25 });
        
        // Define interfaces for type safety
        interface ActivityEntry {
          id: number;
          date: string;
          description: string;
          user?: string;
          ipaddr?: string;
        }
        
        interface AdminLogEntry {
          id: number;
          date: string;
          action: string;
          adminusername: string;
        }
        
        const activities = normalizeToArray<ActivityEntry>(activityLog.activity?.entry);
        const adminActions = normalizeToArray<AdminLogEntry>(adminLogs.logs?.log);
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              system_activity: activities.map((a) => ({
                id: a.id,
                date: a.date,
                description: a.description,
                user: a.user || 'system',
                ip: a.ipaddr,
              })),
              admin_actions: adminActions.map((l) => ({
                id: l.id,
                date: l.date,
                action: l.action,
                admin: l.adminusername,
              })),
              fetched_at: new Date().toISOString(),
            }, null, 2),
          }],
        };
        
      } catch (error) {
        resourceLogger.error('Failed to fetch system activity', {
          error: error instanceof Error ? error.message : String(error),
        });
        
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
          }],
        };
      }
    }
  );
}
