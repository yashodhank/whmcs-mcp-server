/**
 * MCP Resources for WHMCS
 * 
 * Provides read-only resources for passive LLM context.
 * SEC-003: Path params (clientid, invoiceid, ticketid) are coerced and validated as positive integers.
 * SEC-002: Response URIs never include auth query params (stripAuthFromUri).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter } from '../rateLimiter.js';
import { isClientMode, ensureClientAllowed, ensureClientOwnership, stripAuthFromUri } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import { formatTicketThread } from '../whmcs/ticketThread.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governanceEnabled,
} from '../governance/pipeline.js';
import {
  mapToCanonicalClient,
  mapToCanonicalInvoice,
  mapToCanonicalTicket,
} from '../canonical/index.js';
import type { Canonical } from '../governance/types.js';

/**
 * Adapt the governed/legacy tool-result boundary onto the read-only resource
 * envelope ({ contents: [{ uri, mimeType, text }] }).
 *
 * Resources carry NO auth_token (stdio resources are not token-authed per
 * src/security.ts). When governance is OFF (default) this returns the legacy
 * payload byte-equivalently (JSON.parse-identical) — existing resource tests
 * pass unchanged. When governance is explicitly ON, the consumer resolves via
 * the anonymous/deny path (authToken undefined): in production with no anon
 * profile this is a structured `consumer_denied` — the correct safe default
 * for an unauthenticated resource. The resource text is taken verbatim from
 * the tool-result's content[0].text.
 */
function governedResourceText<T>(args: {
  uri: string;
  legacy: unknown;
  canonical: () => Canonical<T>;
}): { contents: { uri: string; mimeType: string; text: string }[] } {
  const result = applyGovernanceOrLegacy({
    enabled: governanceEnabled(),
    legacy: args.legacy,
    govern: () =>
      governedToolResult({
        canonical: args.canonical(),
        authToken: undefined,
        requestedContract: undefined,
      }),
  });
  return {
    contents: [
      {
        uri: args.uri,
        mimeType: 'application/json',
        text: result.content[0].text,
      },
    ],
  };
}

/**
 * Parse a positive integer from URI or tool param (SEC-003).
 * MCP resource template params are often strings; access checks require numbers.
 */
function parsePositiveId(value: unknown, paramName: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0) return { ok: true, value };
    return { ok: false, error: `${paramName} must be a positive integer.` };
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n) && n > 0 && String(n) === value.trim()) return { ok: true, value: n };
    return { ok: false, error: `${paramName} must be a positive integer.` };
  }
  return { ok: false, error: `${paramName} is required and must be a positive integer.` };
}

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
    new ResourceTemplate('whmcs://clients/{clientid}/summary', { list: undefined }),
    async (uri, params) => {
      const resourceLogger = logger.child();
      const safeUri = stripAuthFromUri(uri);

      const parsed = parsePositiveId(params.clientid, 'clientid');
      if (!parsed.ok) {
        return {
          contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: parsed.error }) }],
        };
      }
      const clientid = parsed.value;

      try {
        if (isClientMode()) {
          const scopeError = ensureClientAllowed(clientid);
          if (scopeError) {
            return {
              contents: [{
                uri: safeUri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }),
              }],
            };
          }
        }

        resourceLogger.info('Fetching client summary', { clientid });

        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }) }],
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
          stats?: {
            productsnumactive?: number;
            productsnumtotal?: number;
            numactivedomains?: number;
            numdomains?: number;
          };
        }>('GetClientsDetails', { clientid, stats: true });

        return governedResourceText({
          uri: safeUri,
          legacy: {
            clientid: client.id,
            name: `${client.firstname} ${client.lastname}`,
            email: client.email,
            status: client.status,
            credit_balance: client.credit,
            currency: client.currency_code,
            product_count: client.stats?.productsnumactive ?? 0,
            product_count_total: client.stats?.productsnumtotal ?? 0,
            domain_count: client.stats?.numactivedomains ?? 0,
            domain_count_total: client.stats?.numdomains ?? 0,
          },
          canonical: () =>
            mapToCanonicalClient(client as unknown as Record<string, unknown>),
        });
      } catch (error) {
        resourceLogger.error('Failed to fetch client summary', {
          clientid,
          error: error instanceof Error ? error.message : String(error),
        });

        if (error instanceof WhmcsBusinessError) {
          return {
            contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: error.message }) }],
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
    new ResourceTemplate('whmcs://invoices/{invoiceid}/history', { list: undefined }),
    async (uri, params) => {
      const resourceLogger = logger.child();
      const safeUri = stripAuthFromUri(uri);

      const parsed = parsePositiveId(params.invoiceid, 'invoiceid');
      if (!parsed.ok) {
        return {
          contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: parsed.error }) }],
        };
      }
      const invoiceid = parsed.value;

      try {
        resourceLogger.info('Fetching invoice history', { invoiceid });

        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }) }],
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
              contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }) }],
            };
          }
        }

        const items = normalizeToArray<InvoiceItem>(invoice.items?.item);
        const transactions = normalizeToArray<Transaction>(invoice.transactions?.transaction);

        return governedResourceText({
          uri: safeUri,
          legacy: {
            invoiceid: invoice.invoiceid,
            clientid: invoice.userid,
            date: invoice.date,
            duedate: invoice.duedate,
            datepaid: invoice.datepaid,
            status: invoice.status,
            total: invoice.total,
            balance: invoice.balance,
            items: items.map((i) => ({ id: i.id, description: i.description, amount: i.amount })),
            transactions: transactions.map((t) => ({
              id: t.id,
              date: t.date,
              gateway: t.gateway,
              amount_in: t.amountin,
              amount_out: t.amountout,
            })),
          },
          canonical: () =>
            mapToCanonicalInvoice(invoice as unknown as Record<string, unknown>),
        });
      } catch (error) {
        resourceLogger.error('Failed to fetch invoice history', {
          invoiceid,
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }) }],
        };
      }
    }
  );
  
  // ============================================
  // Resource: Ticket Thread
  // ============================================
  server.resource(
    'ticket-thread',
    new ResourceTemplate('whmcs://tickets/{ticketid}/thread', { list: undefined }),
    async (uri, params) => {
      const resourceLogger = logger.child();
      const safeUri = stripAuthFromUri(uri);

      const parsed = parsePositiveId(params.ticketid, 'ticketid');
      if (!parsed.ok) {
        return {
          contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: parsed.error }) }],
        };
      }
      const ticketid = parsed.value;

      try {
        resourceLogger.info('Fetching ticket thread', { ticketid });

        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }) }],
          };
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
          replies?: { reply?: unknown };
          notes?: { note?: unknown };
        }>('GetTicket', { ticketid });

        if (isClientMode()) {
          const ownerId = ticket.userid ?? ticket.clientid;
          if (!ownerId) {
            return {
              contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Unable to validate ticket ownership for client access mode.' }) }],
            };
          }
          const ownershipError = ensureClientOwnership(ownerId, { clientid: ownerId });
          if (ownershipError) {
            return {
              contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }) }],
            };
          }
        }

        const payload = formatTicketThread(ticket);

        return governedResourceText({
          uri: safeUri,
          legacy: payload,
          canonical: () =>
            mapToCanonicalTicket(ticket as unknown as Record<string, unknown>),
        });
      } catch (error) {
        resourceLogger.error('Failed to fetch ticket thread', {
          ticketid,
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }) }],
        };
      }
    }
  );
  
  // ============================================
  // Resource: Client Activity Log
  // ============================================
  server.resource(
    'client-log',
    new ResourceTemplate('whmcs://clients/{clientid}/log', { list: undefined }),
    async (uri, params) => {
      const resourceLogger = logger.child();
      const safeUri = stripAuthFromUri(uri);

      const parsed = parsePositiveId(params.clientid, 'clientid');
      if (!parsed.ok) {
        return {
          contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: parsed.error }) }],
        };
      }
      const clientid = parsed.value;

      try {
        if (isClientMode()) {
          const scopeError = ensureClientAllowed(clientid);
          if (scopeError) {
            return {
              contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Access denied: client scope mismatch.' }) }],
            };
          }
        }

        resourceLogger.info('Fetching client activity log', { clientid });

        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{ uri: safeUri, mimeType: 'application/json', text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }) }],
          };
        }
        
        // Fetch recent orders
        const orders = await whmcsClient.read<{
          orders?: { order?: {
            id: number;
            date: string;
            status: string;
            amount: string;
          }[] };
          totalresults?: number;
        }>('GetOrders', { userid: clientid, limitnum: 25 });

        // Fetch recent invoices
        const invoices = await whmcsClient.read<{
          invoices?: { invoice?: {
            id: number;
            date: string;
            duedate: string;
            status: string;
            total: string;
          }[] };
          totalresults?: number;
        }>('GetInvoices', { userid: clientid, limitnum: 10, orderby: 'date', order: 'desc' });

        // Fetch recent tickets
        const tickets = await whmcsClient.read<{
          tickets?: { ticket?: {
            id: number;
            date: string;
            subject: string;
            status: string;
          }[] };
          totalresults?: number;
        }>('GetTickets', { clientid, limitnum: 25, status: '' });
        
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
        
        // GetOrders/GetTickets do not reliably honor server-side ordering;
        // sort client-side by date DESC (newest-first) then keep a compact
        // top-10 timeline. GetInvoices is already server-ordered+limited.
        const recentOrders = [...normalizeToArray<OrderSummary>(orders.orders?.order)]
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, 10);
        const recentInvoices = normalizeToArray<InvoiceSummary>(invoices.invoices?.invoice);
        const recentTickets = [...normalizeToArray<TicketSummary>(tickets.tickets?.ticket)]
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, 10);

        return {
          contents: [{
            uri: safeUri,
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
              tickets_best_effort: recentTickets.map((t) => ({
                id: t.id,
                date: t.date,
                subject: t.subject,
                status: t.status,
              })),
              tickets_note: 'best-effort; not guaranteed full support history (GetTickets clientid filter may miss operator/admin-created tickets)',
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
            uri: safeUri,
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
    'whmcs://system/activity',
    async (uri) => {
      const resourceLogger = logger.child();
      const safeUri = stripAuthFromUri(uri);

      try {
        if (isClientMode()) {
          return {
            contents: [{
              uri: safeUri,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'System activity is not available in client access mode.' }),
            }],
          };
        }

        resourceLogger.info('Fetching system activity');
        
        if (!rateLimiter.tryConsume()) {
          return {
            contents: [{
              uri: safeUri,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Rate limit exceeded. Please retry shortly.' }),
            }],
          };
        }
        
        // Fetch recent activity log
        const activityLog = await whmcsClient.read<{
          activity?: { entry?: {
            id: number;
            date: string;
            description: string;
            user?: string;
            ipaddr?: string;
          }[] };
          totalresults?: number;
        }>('GetActivityLog', { limitnum: 25 });
        
        // Fetch admin logs for recent admin actions
        const adminLogs = await whmcsClient.read<{
          logs?: { log?: {
            id: number;
            date: string;
            action: string;
            adminusername: string;
          }[] };
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
            uri: safeUri,
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
            uri: safeUri,
            mimeType: 'application/json',
            text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
          }],
        };
      }
    }
  );
}
