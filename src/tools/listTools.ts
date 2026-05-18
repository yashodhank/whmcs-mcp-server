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
import type { Canonical } from '../governance/types.js';
import {
  applyGovernanceOrLegacy,
  governedListResult,
  governanceEnabled,
} from '../governance/pipeline.js';
import {
  mapToCanonicalService,
  mapToCanonicalDomain,
  mapToCanonicalInvoice,
  mapToCanonicalTicket,
  mapToCanonicalOrder,
  mapToCanonicalActivity,
} from '../canonical/index.js';

/**
 * Bounded-scan caps for honest client-side status filtering.
 *
 * WHMCS `GetClientsDomains` has NO native status filter parameter and the
 * factory performs NO native filter for it. `list_client_domains` therefore
 * has to page through results and post-filter. A single-page post-filter
 * silently under-returns when more matches live on later pages, so we scan
 * successive pages until enough matches for the requested window are
 * collected OR the source is exhausted OR a hard bound is reached.
 *
 * The bound is intentionally generous but finite so the tool stays
 * read-only-but-cheap and never loops unboundedly on a huge / pathological
 * account:
 *  - MAX_SCAN_ITEMS — never read more than this many rows total.
 *  - MAX_SCAN_PAGES — never issue more than this many GetClientsDomains
 *    read pages (defence-in-depth if a backend reports a wrong totalresults
 *    or never shrinks the page).
 * When a cap is hit before the source is exhausted the result is marked
 * `scan_complete:false` with a human `warning` (more matches MAY exist).
 */
const MAX_SCAN_ITEMS = 2000;
const MAX_SCAN_PAGES = 50;

/** Tools that must honour `status` via the bounded client-side scan. */
const CLIENT_SIDE_STATUS_FILTER_TOOLS = new Set(['list_client_domains']);

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
 * Stable, additive output schema for every shared list-tool envelope.
 *
 * Describes BOTH runtime shapes without changing them:
 *  - legacy (governance OFF): `{ items, total, count, offset, limit, ...extra }`
 *  - governed (governance ON): `{ consumer, contract, items, total, count,
 *    offset, limit }`
 *
 * Permissive by design (`items` is an array of opaque records, envelope
 * counters are numeric, `consumer`/`contract` optional strings) so it
 * validates accurately whether governance is enabled or not. This is
 * metadata only — no runtime payload is altered. `.passthrough()`-style
 * tolerance is provided by leaving extra envelope keys (e.g. `discovery`,
 * `note`) unconstrained at the raw-shape level.
 */
export const LIST_TOOL_OUTPUT_SHAPE = {
  items: z.array(z.record(z.string(), z.unknown())),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  limit: z.number(),
  consumer: z.string().optional(),
  contract: z.string().optional(),
} as const;

/**
 * Extract the row array out of one WHMCS list response for a given
 * container path, tolerating every WHMCS quirk (flat array, numeric-keyed
 * object, single-object, empty object, `{singular: [...]}` wrapper) via the
 * shared repo normalizer. Pure; no side effects.
 */
function extractRows(
  resp: Record<string, unknown>,
  normalizerPath: string,
  singular: string
): unknown[] {
  const container = resp[normalizerPath];
  const inner =
    container !== null &&
    typeof container === 'object' &&
    !Array.isArray(container)
      ? (container as Record<string, unknown>)[singular] ?? container
      : container;
  return normalizeToArray<unknown>(inner);
}

/** Read a string `status` off an unknown WHMCS row, else undefined. */
function rowStatus(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const s = (row as Record<string, unknown>).status;
  return typeof s === 'string' ? s : undefined;
}

/**
 * Result of a bounded client-side status scan over WHMCS pages.
 */
interface ScanResult {
  /** Raw WHMCS rows whose status matched (case-insensitive), in order. */
  matched: unknown[];
  /** Total raw rows read across all scanned pages. */
  scannedCount: number;
  /**
   * True iff scanning read the ENTIRE source (WHMCS exhausted) — i.e.
   * `matched` is the COMPLETE matching set and counts are authoritative.
   */
  sourceExhausted: boolean;
  /**
   * True iff a hard cap (MAX_SCAN_ITEMS / MAX_SCAN_PAGES) stopped the scan
   * before the source was exhausted, so additional matches MAY exist
   * beyond what was read. Triggers the human `warning`.
   */
  capped: boolean;
}

/**
 * Page through a WHMCS list action accumulating rows whose `status` equals
 * `requestedStatus` (case-insensitive), until EITHER enough matches for the
 * `offset`+`limit` window are collected, OR WHMCS `totalresults` is
 * exhausted, OR a hard bound (MAX_SCAN_ITEMS / MAX_SCAN_PAGES) is hit.
 *
 * Read-only: issues only bounded `action` reads. Uses the configured page
 * size (`MCP_MAX_PAGE_SIZE`) for efficient scanning, independent of the
 * caller's `limit` (which applies to the FILTERED set, not WHMCS paging).
 */
async function scanByStatus(
  whmcs: WhmcsClient,
  action: string,
  baseParams: Record<string, unknown>,
  normalizerPath: string,
  singular: string,
  requestedStatus: string,
  offset: number,
  limit: number
): Promise<ScanResult> {
  const want = requestedStatus.toLowerCase();
  const pageSize = config.MCP_MAX_PAGE_SIZE;
  // Enough matches to satisfy the requested window (offset+limit) before we
  // can stop early; otherwise we must keep scanning so pagination is honest.
  const need = offset + limit;

  const matched: unknown[] = [];
  let scannedCount = 0;
  let pages = 0;
  let start = 0;
  let sourceExhausted = false;
  let capped = false;

  for (;;) {
    if (pages >= MAX_SCAN_PAGES || scannedCount >= MAX_SCAN_ITEMS) {
      capped = true; // hard bound hit before exhaustion
      break;
    }
    const resp = await whmcs.read<Record<string, unknown>>(action, {
      ...baseParams,
      limitnum: pageSize,
      limitstart: start,
    });
    pages += 1;
    const rows = extractRows(resp, normalizerPath, singular);
    scannedCount += rows.length;
    for (const r of rows) {
      const s = rowStatus(r);
      if (s !== undefined && s.toLowerCase() === want) {
        matched.push(r);
      }
    }

    const totalRaw = resp.totalresults;
    const total =
      typeof totalRaw === 'number' ? totalRaw : Number(totalRaw);
    const haveTotal = Number.isFinite(total);

    // Source exhausted: WHMCS reports we've read everything, an empty page
    // arrived, or a short page (< page size) signals no further rows.
    if (
      rows.length === 0 ||
      (haveTotal && scannedCount >= total) ||
      rows.length < pageSize
    ) {
      sourceExhausted = true;
      break;
    }
    // Window already satisfiable from matches so far. We stop early WITHOUT
    // claiming exhaustion — `total`/`scan_complete` stay conservative so
    // counts are never over-claimed (more matches may exist on later pages,
    // but the requested offset/limit window is fully and honestly served).
    if (matched.length >= need) {
      break;
    }
    start += pageSize;
  }

  return { matched, scannedCount, sourceExhausted, capped };
}

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
  /** Maps a raw WHMCS row to the public item shape (legacy output). */
  mapItem: (raw: any) => T;
  /**
   * Maps a raw WHMCS row to a canonical entity for governed projection.
   * Required for governed output; if absent, legacy output is used even
   * when governance is enabled (safe fallback — never leaks).
   */
  canonicalMap?: (raw: unknown) => Canonical<unknown>;
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
    contract: z
      .string()
      .optional()
      .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
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
        // Capture the bearer token before ensureToolAuth strips it.
        const pview = params as Record<string, unknown>;
        const authToken =
          typeof pview.auth_token === 'string' ? pview.auth_token : undefined;
        const requestedContract =
          typeof pview.contract === 'string' ? pview.contract : undefined;

        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        if (isClientMode()) {
          const scopeErr = ensureClientAllowed(params.clientid);
          if (scopeErr) return scopeErr;
        }

        log.logToolCall(c.name, params, false);

        if (!rl.tryConsume()) throw new RateLimitError();

        const { limit = 10, offset = 0, clientid } = params;
        const singular =
          c.singular ??
          c.normalizerPath.replace(/ies$/, 'y').replace(/s$/, '');

        // Cleanly-typed views of the (schema-validated) numeric params for
        // the new bounded-scan path — avoids propagating the handler's
        // legacy `any` params type into the typed scan helper.
        const pbag = params as Record<string, unknown>;
        const limitNum =
          typeof pbag.limit === 'number' ? pbag.limit : Number(limit);
        const offsetNum =
          typeof pbag.offset === 'number' ? pbag.offset : Number(offset);

        const rawStatus = pbag.status;
        const requestedStatus: string | undefined =
          typeof rawStatus === 'string' && rawStatus.length > 0
            ? rawStatus
            : undefined;
        const useClientSideStatusScan =
          CLIENT_SIDE_STATUS_FILTER_TOOLS.has(c.name) &&
          requestedStatus !== undefined;

        let rows: unknown[];
        let envelope: Record<string, unknown>;

        if (requestedStatus !== undefined && useClientSideStatusScan) {
          // HONEST client-side status filter via a bounded multi-page scan.
          // WHMCS GetClientsDomains ignores any `status` param, so it is
          // intentionally NOT forwarded — we filter the scanned rows here.
          const clientIdNum =
            typeof pbag.clientid === 'number'
              ? pbag.clientid
              : Number(clientid);
          const baseParams: Record<string, unknown> = {
            [c.clientParam]: clientIdNum,
            ...(c.fixedParams ?? {}),
          };
          for (const k of Object.keys(c.extraSchema)) {
            if (k === 'status') continue; // honoured client-side, not by WHMCS
            if (pbag[k] !== undefined) baseParams[k] = pbag[k];
          }

          const scan = await scanByStatus(
            whmcs,
            c.action,
            baseParams,
            c.normalizerPath,
            singular,
            requestedStatus,
            offsetNum,
            limitNum
          );

          // Honest pagination over the FILTERED set only.
          rows = scan.matched.slice(offsetNum, offsetNum + limitNum);
          const matchedCount = scan.matched.length;
          const returnedCount = rows.length;
          // `scan_complete` is true ONLY when the whole source was read, so
          // matched_count/total are authoritative. A capped OR early-stopped
          // scan reports false (counts are the lower bound observed so far).
          const scanComplete = scan.sourceExhausted;

          // Counts reflect the FILTERED view. `total` is never over-claimed:
          // it is matchedCount (authoritative when scan_complete, otherwise
          // the conservative count of matches actually observed).
          envelope = {
            total: matchedCount,
            count: returnedCount,
            offset: offsetNum,
            limit: limitNum,
            ...(c.extraPayload ?? {}),
            filter_mode: 'client_side',
            filter_applied: true,
            requested_status: requestedStatus,
            scanned_count: scan.scannedCount,
            matched_count: matchedCount,
            returned_count: returnedCount,
            scan_complete: scanComplete,
          };
          if (scan.capped) {
            envelope.warning =
              `Status filter scan hit a safety bound (scanned ${String(
                scan.scannedCount
              )} domains) before exhausting all results; more '${requestedStatus}' domains may exist beyond the returned window. ` +
              `Narrow the query or page within the matched results shown.`;
          }
        } else {
          const apiParams: Record<string, unknown> = {
            [c.clientParam]: clientid,
            limitnum: limit,
            limitstart: offset,
            ...(c.fixedParams ?? {}),
          };
          for (const k of Object.keys(c.extraSchema)) {
            if (params[k] !== undefined) apiParams[k] = params[k];
          }

          const resp = await whmcs.read<Record<string, any>>(
            c.action,
            apiParams
          );
          rows = extractRows(resp, c.normalizerPath, singular);
          envelope = {
            total: resp.totalresults ?? rows.length,
            count: resp.numreturned ?? rows.length,
            offset: resp.startnumber ?? offset,
            limit,
            ...(c.extraPayload ?? {}),
          };
        }

        let items = rows.map(c.mapItem);
        if (c.postSort) items = c.postSort(items);

        log.logToolResult(c.name, true, Date.now() - t0);

        const legacy = { items, ...envelope };

        return applyGovernanceOrLegacy({
          enabled: governanceEnabled() && c.canonicalMap !== undefined,
          legacy,
          govern: () =>
            governedListResult({
              rows,
              mapItem: c.canonicalMap as (raw: unknown) => Canonical<unknown>,
              envelope,
              authToken,
              requestedContract,
            }),
        });
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
      outputSchema: LIST_TOOL_OUTPUT_SHAPE,
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
    canonicalMap: mapToCanonicalService,
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
    canonicalMap: mapToCanonicalDomain,
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
    canonicalMap: mapToCanonicalInvoice,
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
    canonicalMap: mapToCanonicalTicket,
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
    canonicalMap: mapToCanonicalOrder,
  });

  // get_activity_log — GetActivityLog is allowlisted (actionPolicy) and
  // capability-supported (B4); delivered through the governed factory.
  // clientid is required here (client-scoped activity); the global log
  // remains available via the whmcs://system/activity resource.
  registerListTool(server, whmcs, logger, rl, {
    name: 'get_activity_log',
    description:
      "Read-only client activity log (newest first). WHMCS GetActivityLog; client-scoped via clientid. Pagination via limit/offset.",
    action: 'GetActivityLog',
    clientParam: 'clientid',
    normalizerPath: 'activity',
    singular: 'entry',
    extraSchema: {
      date: z.string().optional(),
      user: z.string().optional(),
    },
    mapItem: (e: Record<string, unknown>) => ({
      id: e.id,
      date: e.date,
      user: e.user,
      description: e.description,
      ipaddr: e.ipaddr ?? e.ipaddress,
    }),
    postSort: (xs) =>
      [...xs].sort((a, b) =>
        String(b.date).localeCompare(String(a.date))
      ),
    canonicalMap: mapToCanonicalActivity,
  });
}
