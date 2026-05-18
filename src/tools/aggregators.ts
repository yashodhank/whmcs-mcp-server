/**
 * Read-only aggregator tools for WHMCS MCP Server.
 *
 * Composes multiple WHMCS read calls into a single high-level snapshot.
 * Sub-reads are individually fault-isolated via `safeSection`: a failing
 * section degrades to a fallback value plus a `partial_errors` entry,
 * rather than failing the whole aggregator.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, isClientMode, ensureClientAllowed, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';

/**
 * Shared best-effort discovery caveat for ticket sections (see C2).
 * GetTickets clientid filtering can miss operator/admin-created tickets.
 */
const TICKET_BEST_EFFORT = {
  discovery: 'best-effort' as const,
  note: 'GetTickets clientid discovery may miss operator/admin-created tickets; use get_ticket_thread by known ticketid/tid for reliable retrieval.',
};

interface PartialError {
  section: string;
  error: string;
}

/**
 * Run a sub-read with fault isolation. On failure, records a
 * `{ section, error }` entry and returns the supplied fallback.
 */
async function safeSection<T>(
  section: string,
  errs: PartialError[],
  fallback: T,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errs.push({ section, error: e instanceof Error ? e.message : String(e) });
    return fallback;
  }
}

/**
 * Normalize a WHMCS list container (e.g. `{ product: [...] }`) to an array,
 * tolerating both wrapped and bare shapes.
 */
function norm<T>(container: any, singular: string): T[] {
  return normalizeToArray<T>(
    container && typeof container === 'object'
      ? (container[singular] ?? container)
      : container
  );
}

/**
 * Register a single read-only aggregator tool. Mirrors the listTools
 * factory: auth/scope checks, rate limiting, structured logging, and a
 * localized boundary cast for the SDK `ToolCallback` shape.
 *
 * No-op if the tool is disabled via `isToolAllowed`.
 */
function register(
  server: McpServer,
  name: string,
  description: string,
  extra: z.ZodRawShape,
  logger: Logger,
  rl: RateLimiter,
  run: (params: any) => Promise<unknown>
): void {
  if (!isToolAllowed(name)) return;
  const schema = z.object({ clientid: z.number().int().positive(), ...extra });

  // The shared `ensure*` helpers return a local `McpToolResponse` type that
  // lacks the SDK's `[x: string]: unknown` index signature, so the inferred
  // callback return type is not structurally assignable to `ToolCallback`.
  // This is a type-only boundary cast; runtime behavior is unchanged.
  const handler: ToolCallback<z.ZodRawShape> = (async (params: any) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params as Record<string, unknown>);
      if (authErr) return authErr;
      if (isClientMode()) {
        const s = ensureClientAllowed(params.clientid);
        if (s) return s;
      }
      log.logToolCall(name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();
      const payload = await run(params);
      log.logToolResult(name, true, Date.now() - t0);
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    } catch (e) {
      log.logToolResult(
        name,
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ isError: true, error: e.message }) },
          ],
          isError: true,
        };
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    name,
    {
      description,
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handler
  );
}

/**
 * Register the read-only aggregator tools on the MCP server.
 *
 * Currently wires up `get_account_360`. Additional snapshot aggregators
 * are appended here by later Phase-2 tasks.
 */
export function registerAggregatorTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  register(
    server,
    'get_account_360',
    'Read-only 360 snapshot: client identity/status/credit, account counts (from GetClientsDetails stats), and recent services/domains/invoices/orders/tickets. Ticket discovery is best-effort.',
    { recent: z.number().int().min(1).max(20).default(5) },
    logger,
    rl,
    async (params) => {
      const errs: PartialError[] = [];
      const cid = params.clientid;
      const n = params.recent ?? 5;
      const cd: any = await safeSection('client', errs, {}, () =>
        whmcs.read('GetClientsDetails', { clientid: cid, stats: true })
      );
      const st = cd.stats ?? {};
      const services = await safeSection('services', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetClientsProducts', { clientid: cid, limitnum: n })).products,
          'product'
        ).map((p) => ({
          serviceid: p.id,
          product: p.name,
          domain: p.domain,
          status: p.status,
          next_due_date: p.nextduedate,
        }))
      );
      const domains = await safeSection('domains', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetClientsDomains', { clientid: cid, limitnum: n })).domains,
          'domain'
        ).map((d) => ({
          domainid: d.id,
          domain: d.domainname,
          status: d.status,
          expiry_date: d.expirydate,
        }))
      );
      const invoices = await safeSection('invoices', errs, [], async () =>
        norm<any>(
          (
            await whmcs.read<any>('GetInvoices', {
              userid: cid,
              limitnum: n,
              orderby: 'date',
              order: 'desc',
            })
          ).invoices,
          'invoice'
        ).map((i) => ({
          invoiceid: i.id,
          status: i.status,
          total: i.total,
          date: i.date,
          duedate: i.duedate,
        }))
      );
      const orders = await safeSection('orders', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetOrders', { userid: cid, limitnum: 25 })).orders,
          'order'
        )
          .map((o) => ({ orderid: o.id, date: o.date, status: o.status, amount: o.amount }))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, n)
      );
      const tickets = await safeSection('tickets', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetTickets', { clientid: cid, limitnum: 25 })).tickets,
          'ticket'
        )
          .map((t) => ({
            ticketid: t.id,
            tid: t.tid,
            subject: t.subject,
            status: t.status,
            lastreply: t.lastreply,
          }))
          .sort((a, b) =>
            String(b.lastreply || '').localeCompare(String(a.lastreply || ''))
          )
          .slice(0, n)
      );
      return {
        client: {
          clientid: cd.id,
          name: `${cd.firstname ?? ''} ${cd.lastname ?? ''}`.trim(),
          email: cd.email,
          status: cd.status,
          credit_balance: cd.credit,
          currency: cd.currency_code,
        },
        counts: {
          services_active: st.productsnumactive ?? 0,
          services_total: st.productsnumtotal ?? 0,
          domains_active: st.numactivedomains ?? 0,
          domains_total: st.numdomains ?? 0,
          unpaid_invoices: st.numunpaidinvoices ?? 0,
          overdue_invoices: st.numoverdueinvoices ?? 0,
          active_tickets: st.numactivetickets ?? 0,
        },
        recent: {
          services,
          domains,
          invoices,
          orders,
          tickets: { items: tickets, ...TICKET_BEST_EFFORT },
        },
        partial_errors: errs,
      };
    }
  );
  register(
    server,
    'get_billing_snapshot',
    'Read-only billing snapshot: unpaid/overdue/paid/cancelled/refunded/draft counts+amounts (from GetClientsDetails stats), credit balance, and recent unpaid/overdue invoices.',
    {},
    logger,
    rl,
    async (params) => {
      const errs: PartialError[] = [];
      const cid = params.clientid;
      const cd: any = await safeSection('client', errs, {}, () =>
        whmcs.read('GetClientsDetails', { clientid: cid, stats: true })
      );
      const st = cd.stats ?? {};
      const mapInv = (arr: any[]) =>
        arr.map((i) => ({
          invoiceid: i.id,
          total: i.total,
          duedate: i.duedate,
          date: i.date,
          status: i.status,
        }));
      const recent_unpaid = await safeSection('unpaid', errs, [], async () =>
        mapInv(
          norm<any>(
            (
              await whmcs.read<any>('GetInvoices', {
                userid: cid,
                status: 'Unpaid',
                limitnum: 5,
                orderby: 'duedate',
                order: 'desc',
              })
            ).invoices,
            'invoice'
          )
        )
      );
      const recent_overdue = await safeSection('overdue', errs, [], async () =>
        mapInv(
          norm<any>(
            (
              await whmcs.read<any>('GetInvoices', {
                userid: cid,
                status: 'Overdue',
                limitnum: 5,
                orderby: 'duedate',
                order: 'desc',
              })
            ).invoices,
            'invoice'
          )
        )
      );
      return {
        currency: cd.currency_code,
        credit_balance: st.creditbalance ?? cd.credit,
        unpaid: {
          count: st.numunpaidinvoices ?? 0,
          amount: st.unpaidinvoicesamount ?? '0.00',
        },
        overdue: {
          count: st.numoverdueinvoices ?? 0,
          amount: st.overdueinvoicesbalance ?? '0.00',
        },
        paid: {
          count: st.numpaidinvoices ?? 0,
          amount: st.paidinvoicesamount ?? '0.00',
        },
        cancelled: { count: st.numcancelledinvoices ?? 0 },
        refunded: { count: st.numrefundedinvoices ?? 0 },
        draft: { count: st.numDraftInvoices ?? 0 },
        recent_unpaid,
        recent_overdue,
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_support_snapshot',
    'Read-only support snapshot: global department open/awaiting counts (GetSupportDepartments — NOT client-scoped) + best-effort recent client tickets (GetTickets clientid may miss operator/admin tickets).',
    {},
    logger,
    rl,
    async (params) => {
      const errs: PartialError[] = [];
      const cid = params.clientid;
      const departments = await safeSection('departments', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetSupportDepartments', {})).departments,
          'department'
        ).map((d) => ({
          id: d.id,
          name: d.name,
          open_tickets: d.opentickets ?? 0,
          awaiting_reply: d.awaitingreply ?? 0,
        }))
      );
      const items = await safeSection('tickets', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetTickets', { clientid: cid, limitnum: 25 })).tickets,
          'ticket'
        )
          .map((t) => ({
            ticketid: t.id,
            tid: t.tid,
            subject: t.subject,
            status: t.status,
            lastreply: t.lastreply,
          }))
          .sort((a, b) =>
            String(b.lastreply || '').localeCompare(String(a.lastreply || ''))
          )
          .slice(0, 10)
      );
      return {
        departments,
        departments_scope: 'global (not client-scoped)',
        client_tickets: { items, ...TICKET_BEST_EFFORT },
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_renewal_snapshot',
    'Read-only renewal snapshot: services (next_due_date) and domains (expiry/next_due) due within `days` (default 60), sorted soonest-first. Date window filtered client-side.',
    { days: z.number().int().min(1).max(3650).default(60) },
    logger,
    rl,
    async (params) => {
      const errs: PartialError[] = [];
      const cid = params.clientid;
      const horizon = new Date(Date.now() + (params.days ?? 60) * 86400000)
        .toISOString()
        .slice(0, 10);
      const inWindow = (d?: string) =>
        !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && d.slice(0, 10) <= horizon;
      const svc = await safeSection('services', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetClientsProducts', { clientid: cid, limitnum: 100 }))
            .products,
          'product'
        )
          .filter((p) => inWindow(p.nextduedate))
          .map((p) => ({
            type: 'service' as const,
            id: p.id,
            name: p.name,
            due_date: p.nextduedate,
            status: p.status,
            recurring_amount: p.recurringamount,
          }))
      );
      const dom = await safeSection('domains', errs, [], async () =>
        norm<any>(
          (await whmcs.read<any>('GetClientsDomains', { clientid: cid, limitnum: 100 }))
            .domains,
          'domain'
        )
          .filter((d) => inWindow(d.expirydate ?? d.nextduedate))
          .map((d) => ({
            type: 'domain' as const,
            id: d.id,
            name: d.domainname,
            due_date: d.expirydate ?? d.nextduedate,
            status: d.status,
          }))
      );
      const upcoming = [...dom, ...svc].sort((a, b) =>
        String(a.due_date).localeCompare(String(b.due_date))
      );
      return {
        window_days: params.days ?? 60,
        horizon,
        upcoming,
        partial_errors: errs,
      };
    }
  );
  // PHASE-2 TASKS 2-4 register(...) FOR get_billing_snapshot / get_support_snapshot / get_renewal_snapshot appended above.
}
