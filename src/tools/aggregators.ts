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
import { getCapability } from '../governance/capabilities.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governanceEnabled,
} from '../governance/pipeline.js';
import type { Canonical, FieldClass, FieldClassMap } from '../governance/types.js';
import {
  mapToCanonicalTransactions,
  type CanonicalTransaction,
} from '../canonical/transaction.js';
import {
  mapToCanonicalCreditNotes,
  type CanonicalCreditNote,
} from '../canonical/creditNote.js';
import { asRecord, isRecord, num, str } from '../canonical/_shared.js';
import { mapToCanonicalTldPricing } from '../canonical/tldPricing.js';

/** Loose WHMCS API row / container object. */
type WhmcsRow = Record<string, unknown>;

function requireClientId(params: Record<string, unknown>): number {
  const id = num(params, 'clientid');
  if (id === undefined) {
    throw new Error('clientid is required');
  }
  return id;
}

function ticketSortKey(row: WhmcsRow): string {
  return str(row, 'lastreply') ?? str(row, 'date') ?? '';
}

function mapServiceRow(p: WhmcsRow) {
  return {
    serviceid: num(p, 'id'),
    product: str(p, 'name'),
    domain: str(p, 'domain'),
    status: str(p, 'status'),
    next_due_date: str(p, 'nextduedate'),
  };
}

function mapDomainRow(d: WhmcsRow) {
  return {
    domainid: num(d, 'id'),
    domain: str(d, 'domainname'),
    status: str(d, 'status'),
    expiry_date: str(d, 'expirydate'),
  };
}

function mapInvoiceSummaryRow(i: WhmcsRow) {
  return {
    invoiceid: num(i, 'id'),
    status: str(i, 'status'),
    total: str(i, 'total'),
    date: str(i, 'date'),
    duedate: str(i, 'duedate'),
  };
}

function mapOrderRow(o: WhmcsRow) {
  return {
    orderid: num(o, 'id'),
    date: str(o, 'date'),
    status: str(o, 'status'),
    amount: str(o, 'amount'),
  };
}

function mapTicketRow(t: WhmcsRow) {
  return {
    ticketid: num(t, 'id'),
    tid: str(t, 'tid'),
    subject: str(t, 'subject'),
    status: str(t, 'status'),
    lastreply: str(t, 'lastreply'),
  };
}

function mapInvoiceBillingRow(i: WhmcsRow) {
  return {
    invoiceid: num(i, 'id'),
    total: str(i, 'total'),
    duedate: str(i, 'duedate'),
    date: str(i, 'date'),
    status: str(i, 'status'),
  };
}

function mapReconInvoiceRow(i: WhmcsRow) {
  return {
    invoiceid: num(i, 'id'),
    status: str(i, 'status'),
    total: str(i, 'total'),
    balance: str(i, 'balance'),
    date: str(i, 'date'),
    datepaid: str(i, 'datepaid'),
  };
}

function mapProvisioningServiceRow(s: WhmcsRow) {
  return {
    serviceid: num(s, 'id'),
    product: str(s, 'name'),
    domain: str(s, 'domain'),
    status: str(s, 'status'),
    regdate: str(s, 'regdate'),
    next_due_date: str(s, 'nextduedate'),
  };
}

/**
 * Shared best-effort discovery caveat for ticket sections (see C2).
 * GetTickets clientid filtering can miss operator/admin-created tickets.
 */
const TICKET_BEST_EFFORT = {
  discovery: 'best-effort' as const,
  note: 'GetTickets clientid discovery may miss operator/admin-created tickets; use get_ticket_thread by known ticketid/tid for reliable retrieval.',
};

/**
 * Per-list fetch cap for get_renewal_snapshot. If a normalized list reaches
 * this length, more records may exist beyond it and the snapshot flags the
 * section as truncated (some upcoming renewals could be missed).
 */
const RENEWAL_FETCH_LIMIT = 100;

/**
 * Bounded per-client transaction fetch cap for get_reconciliation_snapshot.
 *
 * LIMITATION (documented): WHMCS GetTransactions accepts `clientid`/
 * `invoiceid`/`transid` filters, but server-side pagination semantics for
 * this action are UNOBSERVED on this build (no probed evidence of an
 * `offset`/`page` contract for GetTransactions). We therefore fetch a single
 * bounded page of `RECON_TX_FETCH_LIMIT` rows and, when the normalized list
 * reaches the cap, set `transactions.bounded = true` — meaning more
 * transactions may exist beyond this page and the reconciliation analysis is
 * over the bounded window only (it is NOT a full-ledger guarantee). We do
 * NOT paginate blindly or call any unverified pagination parameter.
 */
const RECON_TX_FETCH_LIMIT = 200;

/**
 * Window (days) within which a transaction referencing an Unpaid/Overdue
 * invoice is treated as a "recent payment" worth flagging for human review
 * (the invoice status may simply be stale relative to a just-recorded
 * payment). Conservative: a wider window only adds review candidates, it
 * never hides a discrepancy.
 */
const RECON_RECENT_PAYMENT_DAYS = 14;

/**
 * Day-proximity (inclusive) for the duplicate-risk heuristic: two
 * transactions for the SAME invoice and the SAME (rounded) amount whose
 * dates fall within this many days of each other are surfaced as a
 * duplicate-risk GROUP for human review. This is deliberately a *risk
 * signal*, never an assertion of an actual duplicate.
 */
const RECON_DUP_NEAR_DAYS = 3;

/** A reconciliation-shaped view of one canonical transaction. */
interface ReconTransaction extends CanonicalTransaction {
  /**
   * Conservative refund/reversal heuristic. TRUE when money clearly left
   * the system for this row (amountOut > 0) OR a net-negative inflow
   * (amountIn < 0) OR the free-text description contains an explicit
   * refund/reversal/chargeback token. This is a *hint* for human review,
   * not an authoritative WHMCS refund record.
   */
  is_refund_or_reversal: boolean;
}

/** Parse a WHMCS date-ish string to epoch-ms, or null if unusable. */
function reconDateMs(d: string | null): number | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const ms = Date.parse(d.slice(0, 10));
  return Number.isFinite(ms) ? ms : null;
}

const REFUND_TOKEN = /refund|revers|chargeback|charge-back/i;

/** Apply the conservative refund/reversal heuristic to a canonical txn. */
function isRefundOrReversal(t: CanonicalTransaction): boolean {
  if (typeof t.amountOut === 'number' && t.amountOut > 0) return true;
  if (typeof t.amountIn === 'number' && t.amountIn < 0) return true;
  if (typeof t.description === 'string' && REFUND_TOKEN.test(t.description)) {
    return true;
  }
  return false;
}

interface InvoiceLite {
  invoiceid: unknown;
  status: unknown;
  total: unknown;
  balance: unknown;
  date: unknown;
  datepaid: unknown;
}

interface ReconMatching {
  matched: { transactionRowId: number | null; invoiceId: number | null }[];
  unmatched_transaction_ids: (number | null)[];
  duplicate_risk: {
    invoiceId: number | null;
    amount: number | null;
    transaction_row_ids: (number | null)[];
  }[];
  unpaid_with_recent_payment: {
    invoiceId: number;
    status: string;
    transaction_row_ids: (number | null)[];
  }[];
}

/**
 * PURE reconciliation analysis over canonical transactions + the snapshot's
 * invoice list. Preserves the financial references needed for matching;
 * derives duplicate-risk, unmatched, and unpaid-with-recent-payment signals.
 */
function reconcile(
  txns: ReconTransaction[],
  invoices: InvoiceLite[]
): ReconMatching {
  const invoiceIds = new Set<number>();
  const invoiceById = new Map<number, InvoiceLite>();
  for (const inv of invoices) {
    const id = Number(inv.invoiceid);
    if (Number.isFinite(id)) {
      invoiceIds.add(id);
      invoiceById.set(id, inv);
    }
  }

  const matched: { transactionRowId: number | null; invoiceId: number | null }[] = [];
  const unmatched: (number | null)[] = [];
  for (const t of txns) {
    if (t.invoiceId !== null && invoiceIds.has(t.invoiceId)) {
      matched.push({ transactionRowId: t.transactionRowId, invoiceId: t.invoiceId });
    } else {
      unmatched.push(t.transactionRowId);
    }
  }

  // Duplicate-risk: group by invoiceId + rounded amount; within a group,
  // flag if ≥2 rows fall within RECON_DUP_NEAR_DAYS of each other.
  const dupGroups = new Map<string, ReconTransaction[]>();
  for (const t of txns) {
    if (t.invoiceId === null) continue;
    const amt = typeof t.amountIn === 'number' && t.amountIn > 0 ? t.amountIn : null;
    if (amt === null) continue;
    const key = `${t.invoiceId}|${amt.toFixed(2)}`;
    const arr = dupGroups.get(key) ?? [];
    arr.push(t);
    dupGroups.set(key, arr);
  }
  const duplicate_risk: ReconMatching['duplicate_risk'] = [];
  for (const [key, group] of dupGroups) {
    if (group.length < 2) continue;
    const near = group.some((a, i) =>
      group.some((b, j) => {
        if (j <= i) return false;
        const am = reconDateMs(a.date);
        const bm = reconDateMs(b.date);
        if (am === null || bm === null) return true; // missing date ⇒ flag
        return Math.abs(am - bm) <= RECON_DUP_NEAR_DAYS * 86400000;
      })
    );
    if (!near) continue;
    const [invStr, amtStr] = key.split('|');
    duplicate_risk.push({
      invoiceId: Number(invStr),
      amount: Number(amtStr),
      transaction_row_ids: group.map((g) => g.transactionRowId),
    });
  }

  // Unpaid/Overdue invoice that nonetheless has a recent inbound payment
  // referencing it — a likely stale-status discrepancy for human review.
  const now = Date.now();
  const unpaid_with_recent_payment: ReconMatching['unpaid_with_recent_payment'] = [];
  for (const id of invoiceIds) {
    const inv = invoiceById.get(id);
    if (!inv) continue;
    const status =
      typeof inv.status === 'string' || typeof inv.status === 'number'
        ? String(inv.status)
        : '';
    if (!/^(unpaid|overdue)$/i.test(status)) continue;
    const recentPayers = txns.filter((t) => {
      if (t.invoiceId !== id) return false;
      if (!(typeof t.amountIn === 'number' && t.amountIn > 0)) return false;
      const ms = reconDateMs(t.date);
      // Unknown date ⇒ still flag (conservative: surface for review).
      if (ms === null) return true;
      return now - ms <= RECON_RECENT_PAYMENT_DAYS * 86400000;
    });
    if (recentPayers.length > 0) {
      unpaid_with_recent_payment.push({
        invoiceId: id,
        status,
        transaction_row_ids: recentPayers.map((t) => t.transactionRowId),
      });
    }
  }

  return {
    matched,
    unmatched_transaction_ids: unmatched,
    duplicate_risk,
    unpaid_with_recent_payment,
  };
}

/**
 * WHMCS 9 ledger semantics notice. ALWAYS safe to emit (public.safe):
 * informational only, never derived from a read, never fabricated data.
 */
const WHMCS9_NOTICE = {
  immutable_non_draft_invoices: true as const,
  corrections_via_credit_debit_notes: true as const,
  note: 'On WHMCS 9 non-draft invoices are immutable; do not assume invoice edits — reconcile via credit/debit notes. Reads are unaffected by this; this is an informational reconciliation caveat only.',
};

/**
 * WHMCS 9 credit/debit-note ledger-adjustment representation.
 *
 * There is NO capability-verified WHMCS read action for credit/debit notes
 * on this build, so this is ALWAYS a structured capability marker — never a
 * fabricated note. `mapToCanonicalCreditNotes` is imported and wired so that
 * IF a verified read/representation path is added behind this gate it can be
 * mapped without further structural change; until then the section carries
 * no note data. (Referenced here to keep the wiring live.)
 */
function ledgerAdjustmentsSection(): Record<string, unknown> {
  // Keep the canonical credit-note mapper referenced (wired-ready). Mapping
  // an empty representation yields zero canonical notes — proving the path
  // is connected WITHOUT inventing any data.
  const wiredReady: CanonicalCreditNote[] = mapToCanonicalCreditNotes({}).map(
    (c) => c.data
  );
  return {
    capability: 'whmcs9_credit_debit_notes',
    status: 'capability_unavailable' as const,
    canonical_notes: wiredReady, // always [] — no verified read action
    note: 'No capability-verified WHMCS read action for credit/debit notes on this build; represented as a structured capability marker. mapToCanonicalCreditNotes is wired behind this gate and used the moment a verified representation path exists — notes are never fabricated.',
  };
}

/**
 * Stable, additive output schema shared by every read-only aggregator.
 *
 * Aggregators have NO single canonical entity: each composes many WHMCS
 * reads into a heterogeneous nested summary. App consumers (dashboards /
 * reconciliation) still need a machine-readable contract, so this shape
 * describes BOTH runtime modes WITHOUT altering any payload:
 *
 *  - legacy (governance OFF): the raw aggregate object — `clientid` plus
 *    various per-aggregator summary objects, a `partial_errors` array,
 *    optional `truncated`, and capability-gated sections of the form
 *    `{ capability_unavailable: true, action, status, note? }`.
 *  - governed (governance ON): `{ entity, consumer, contract, data }`, or a
 *    structured failure `{ isError, error, status }` when a consumer is
 *    denied / the contract is env-forbidden.
 *
 * It is deliberately permissive: every key is optional and the small set of
 * commonly-present keys is loosely typed (objects/arrays as opaque records),
 * so a SINGLE shape validates accurately whether governance is on or off and
 * across all eight aggregators. No field is masked or removed; extra
 * per-aggregator keys are tolerated (Zod object raw-shapes ignore unknown
 * keys by default — passthrough tolerance without over-constraining).
 */
const AGGREGATOR_OUTPUT_SHAPE = {
  // Common legacy identifiers / metadata.
  clientid: z.number().optional(),
  count: z.number().optional(),
  window_days: z.number().optional(),
  horizon: z.string().optional(),
  truncated: z.record(z.string(), z.unknown()).optional(),
  // Fault-isolation: always an array of `{ section, error }`-ish records.
  partial_errors: z.array(z.record(z.string(), z.unknown())).optional(),
  // Capability-gated sections — structured, never faked, never thrown.
  transactions: z.record(z.string(), z.unknown()).optional(),
  automation_log: z.record(z.string(), z.unknown()).optional(),
  // Heterogeneous per-aggregator summary blocks (opaque, never masked).
  client: z.record(z.string(), z.unknown()).optional(),
  counts: z.record(z.string(), z.unknown()).optional(),
  recent: z.record(z.string(), z.unknown()).optional(),
  risk: z.record(z.string(), z.unknown()).optional(),
  // Common list-bearing summary keys + their source-ID arrays.
  invoices: z.array(z.record(z.string(), z.unknown())).optional(),
  services: z.array(z.record(z.string(), z.unknown())).optional(),
  orders: z.array(z.record(z.string(), z.unknown())).optional(),
  departments: z.array(z.record(z.string(), z.unknown())).optional(),
  upcoming: z.array(z.record(z.string(), z.unknown())).optional(),
  timeline: z.array(z.record(z.string(), z.unknown())).optional(),
  overdue_invoices: z.array(z.record(z.string(), z.unknown())).optional(),
  suspended_services: z.array(z.record(z.string(), z.unknown())).optional(),
  source_invoice_ids: z.array(z.unknown()).optional(),
  source_service_ids: z.array(z.unknown()).optional(),
  source_transaction_ids: z.array(z.unknown()).optional(),
  // Track 2/6 reconciliation sections (structured, never faked). The
  // detailed `reconciliation_ledger` is classified system.audit so it is
  // preserved for billing reconcilers but dropped for LLM consumers.
  reconciliation_ledger: z.record(z.string(), z.unknown()).optional(),
  ledger_adjustments: z.record(z.string(), z.unknown()).optional(),
  whmcs9_notice: z.record(z.string(), z.unknown()).optional(),
  // Governed envelope ({ entity, consumer, contract, data }) + structured
  // failure ({ isError, error, status }). All optional so one shape
  // validates governance ON and OFF.
  entity: z.string().optional(),
  consumer: z.string().optional(),
  contract: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  error: z.string().optional(),
  status: z.string().optional(),
} as const;

/**
 * Registered as a single PASSTHROUGH ZodObject (one shared instance) so the
 * SDK-derived JSON Schema permits additional properties — aggregator
 * governance-OFF legacy payloads are heterogeneous; strict MCP runtimes
 * (Kilo) otherwise reject extras with -32602.
 */
const AGGREGATOR_OUTPUT_SCHEMA = z
  .object(AGGREGATOR_OUTPUT_SHAPE)
  .catchall(z.unknown());

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
function norm<T>(container: unknown, singular: string): T[] {
  const inner =
    isRecord(container) && singular in container
      ? container[singular]
      : container;
  return normalizeToArray<T>(inner);
}

/**
 * Best-effort field classification for an aggregator's assembled summary.
 *
 * An aggregator does NOT map to a single B1 canonical entity: it composes
 * many read-only WHMCS calls into a CUSTOM nested summary. We therefore gate
 * the WHOLE assembled object as one ad-hoc `activity` canonical with an
 * explicit, conservative top-level field-class map.
 *
 * The projection boundary (`project()`) walks ONLY the top-level keys of
 * `canonical.data`; any top-level key absent from the returned map is DROPPED
 * by projection (fail-safe — never leaked). Classification is pragmatic and
 * keyword-driven; the projection layer enforces the actual safety.
 */
export function classifyAggregateKey(key: string): FieldClass {
  const k = key.toLowerCase();

  // ── 1. PII FIRST. A real PII key is NEVER downgraded to a more-
  //    permissive class by a later structural rule. The client identity
  //    block carries name/email/phone/address inside it.
  if (k === 'client') {
    return 'pii.name';
  }
  if (k.includes('email')) return 'pii.email';
  if (/phone|mobile/.test(k)) return 'pii.phone';
  if (/address|street|city|postcode|zip/.test(k)) return 'pii.address';

  // ── 2. Exact structural / status / label / id keys (Track B). These are
  //    pinned BEFORE the keyword regexes so a status/label is no longer
  //    mis-classed (the pilot showed false "under-masked" on labels and
  //    `violations == unknown_fields` on status flags).

  // Reconciliation ledger (Track 2): the DETAILED per-transaction match
  // structure carries raw financial refs (gateway/transid) + matching
  // analysis. `system.audit` creates the required exposure asymmetry:
  //   billing_reconciliation ⇒ allow (refs preserved to reconcile),
  //   llm_safe_summary       ⇒ drop  (raw gateway/transid never to an LLM).
  if (k === 'reconciliation_ledger') {
    return 'system.audit';
  }
  // Raw internal error strings (e.g. partial_errors[].error). Conservative:
  // dropped for LLM/portal, summarized for the automations, raw only for a
  // trusted operator/admin/local (see system.diagnostic in contracts.ts).
  if (k === 'partial_errors') {
    return 'system.diagnostic';
  }
  // Capability / partial-error PRESENCE, truncated/composed/bounded flags,
  // counts, risk roll-ups, ledger-adjustment status marker — operational
  // STATUS only (no PII, no raw refs) ⇒ safe in every contract.
  if (
    k === 'counts' ||
    k === 'risk' ||
    k === 'truncated' ||
    k === 'ledger_adjustments'
  ) {
    return 'system.status';
  }
  // Source-id arrays so a consumer can re-fetch by id.
  if (
    k === 'source_invoice_ids' ||
    k === 'source_transaction_ids' ||
    k === 'source_service_ids'
  ) {
    return 'business.identifier';
  }
  // Non-sensitive business DISPLAY labels: the WHMCS-9 notice, the
  // department directory, the upcoming-renewal label list.
  if (k === 'whmcs9_notice' || k === 'departments' || k === 'upcoming') {
    return 'business.label';
  }
  // The SAFE transaction summary block (capability + counts only; raw
  // gateway/transid live under reconciliation_ledger). financial.reference
  // is `allow` for both billing and llm consumers.
  if (k === 'transactions') {
    return 'financial.reference';
  }

  // ── 3. Keyword fallbacks (unchanged intent). Ticket bundles
  //    (`client_tickets`) remain untrusted.free_text.
  if (/ticket|subject|message|note|reply|free_text/.test(k)) {
    return 'untrusted.free_text';
  }
  if (
    /amount|balance|credit|total|paid|unpaid|overdue|refund|cancel|draft|recurring|currency/.test(
      k
    )
  ) {
    return 'financial.amount';
  }
  if (/invoice|transaction|order|gateway|recent_/.test(k)) {
    return 'financial.reference';
  }
  if (/id$|_id$|clientid|serviceid|domainid/.test(k)) {
    return 'business.identifier';
  }
  // Dates, scope strings, window/horizon, discovery notes — non-sensitive
  // aggregate metadata.
  return 'public.safe';
}

/**
 * Wrap an assembled aggregator summary as a single ad-hoc `activity`
 * canonical with a conservative top-level field-class map. Unmapped keys
 * are dropped by the projection layer (safe by construction).
 */
function aggregateCanonical(
  entity: string,
  payload: Record<string, unknown>
): Canonical<unknown> {
  void entity;
  const classes: Record<string, FieldClass> = {};
  for (const key of Object.keys(payload)) {
    classes[key] = classifyAggregateKey(key);
  }
  return {
    entity: 'activity' as const,
    data: payload,
    classes: classes as FieldClassMap,
  };
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
  run: (params: Record<string, unknown>) => Promise<unknown>
): void {
  if (!isToolAllowed(name)) return;
  const schema = z.object({
    clientid: z.number().int().positive(),
    contract: z
      .string()
      .optional()
      .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
    ...extra,
  });

  // The shared `ensure*` helpers return a local `McpToolResponse` type that
  // lacks the SDK's `[x: string]: unknown` index signature, so the inferred
  // callback return type is not structurally assignable to `ToolCallback`.
  // This is a type-only boundary cast; runtime behavior is unchanged.
  const handler: ToolCallback<z.ZodRawShape> = (async (params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      // Capture the bearer token + requested contract before
      // ensureToolAuth strips auth fields from params.
      const authToken =
        typeof params.auth_token === 'string' ? params.auth_token : undefined;
      const requestedContract =
        typeof params.contract === 'string' ? params.contract : undefined;

      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;
      if (isClientMode()) {
        const scopedClientId = num(params, 'clientid');
        if (scopedClientId === undefined) {
          return {
            content: [{ type: 'text', text: 'clientid is required' }],
            isError: true,
          };
        }
        const s = ensureClientAllowed(scopedClientId);
        if (s) return s;
      }
      log.logToolCall(name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();
      const payload = await run(params);
      log.logToolResult(name, true, Date.now() - t0);
      return applyGovernanceOrLegacy({
        enabled: governanceEnabled(),
        legacy: payload,
        govern: () =>
          governedToolResult({
            canonical: aggregateCanonical(
              name,
              payload as Record<string, unknown>
            ),
            authToken,
            requestedContract,
          }),
      });
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
      outputSchema: AGGREGATOR_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handler
  );
}

/**
 * Register the read-only aggregator tools on the MCP server:
 * get_account_360, get_billing_snapshot, get_support_snapshot,
 * get_renewal_snapshot.
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
      const cid = requireClientId(params);
      const n = num(params, 'recent') ?? 5;
      const cd = asRecord(
        await safeSection('client', errs, {}, () =>
          whmcs.read('GetClientsDetails', { clientid: cid, stats: true })
        )
      );
      const st = asRecord(cd.stats);
      const services = await safeSection('services', errs, [], async () =>
        norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetClientsProducts', { clientid: cid, limitnum: n })).products,
          'product'
        ).map(mapServiceRow)
      );
      const domains = await safeSection('domains', errs, [], async () =>
        norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetClientsDomains', { clientid: cid, limitnum: n })).domains,
          'domain'
        ).map(mapDomainRow)
      );
      const invoices = await safeSection('invoices', errs, [], async () =>
        norm<WhmcsRow>(
          (
            await whmcs.read<Record<string, unknown>>('GetInvoices', {
              userid: cid,
              limitnum: n,
              orderby: 'date',
              order: 'desc',
            })
          ).invoices,
          'invoice'
        ).map(mapInvoiceSummaryRow)
      );
      const orders = await safeSection('orders', errs, [], async () =>
        norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetOrders', { userid: cid, limitnum: 25 })).orders,
          'order'
        )
          .map(mapOrderRow)
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
          .slice(0, n)
      );
      const tickets = await safeSection('tickets', errs, [], async () =>
        norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetTickets', { clientid: cid, limitnum: 25 })).tickets,
          'ticket'
        )
          .map(mapTicketRow)
          .sort((a, b) => ticketSortKey(b).localeCompare(ticketSortKey(a)))
          .slice(0, n)
      );
      return {
        client: {
          clientid: num(cd, 'id'),
          name: `${str(cd, 'firstname') ?? ''} ${str(cd, 'lastname') ?? ''}`.trim(),
          email: str(cd, 'email'),
          status: str(cd, 'status'),
          credit_balance: str(cd, 'credit'),
          currency: str(cd, 'currency_code'),
        },
        counts: {
          services_active: num(st, 'productsnumactive') ?? 0,
          services_total: num(st, 'productsnumtotal') ?? 0,
          domains_active: num(st, 'numactivedomains') ?? 0,
          domains_total: num(st, 'numdomains') ?? 0,
          unpaid_invoices: num(st, 'numunpaidinvoices') ?? 0,
          overdue_invoices: num(st, 'numoverdueinvoices') ?? 0,
          active_tickets: num(st, 'numactivetickets') ?? 0,
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
      const cid = requireClientId(params);
      const cd = asRecord(
        await safeSection('client', errs, {}, () =>
          whmcs.read('GetClientsDetails', { clientid: cid, stats: true })
        )
      );
      const st = asRecord(cd.stats);
      const recent_unpaid = await safeSection('unpaid', errs, [], async () =>
        norm<WhmcsRow>(
            (
              await whmcs.read<Record<string, unknown>>('GetInvoices', {
                userid: cid,
                status: 'Unpaid',
                limitnum: 5,
                orderby: 'duedate',
                order: 'desc',
              })
            ).invoices,
            'invoice'
          ).map(mapInvoiceBillingRow)
      );
      const recent_overdue = await safeSection('overdue', errs, [], async () =>
        norm<WhmcsRow>(
            (
              await whmcs.read<Record<string, unknown>>('GetInvoices', {
                userid: cid,
                status: 'Overdue',
                limitnum: 5,
                orderby: 'duedate',
                order: 'desc',
              })
            ).invoices,
            'invoice'
          ).map(mapInvoiceBillingRow)
      );
      return {
        currency: str(cd, 'currency_code'),
        credit_balance: str(st, 'creditbalance') ?? str(cd, 'credit'),
        unpaid: {
          count: num(st, 'numunpaidinvoices') ?? 0,
          amount: str(st, 'unpaidinvoicesamount') ?? '0.00',
        },
        overdue: {
          count: num(st, 'numoverdueinvoices') ?? 0,
          amount: str(st, 'overdueinvoicesbalance') ?? '0.00',
        },
        paid: {
          count: num(st, 'numpaidinvoices') ?? 0,
          amount: str(st, 'paidinvoicesamount') ?? '0.00',
        },
        cancelled: { count: num(st, 'numcancelledinvoices') ?? 0 },
        refunded: { count: num(st, 'numrefundedinvoices') ?? 0 },
        draft: { count: num(st, 'numDraftInvoices') ?? 0 },
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
      const cid = requireClientId(params);
      const departments = await safeSection('departments', errs, [], async () =>
        norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetSupportDepartments', {})).departments,
          'department'
        ).map((d) => ({
          id: num(d, 'id'),
          name: str(d, 'name'),
          open_tickets: num(d, 'opentickets') ?? 0,
          awaiting_reply: num(d, 'awaitingreply') ?? 0,
        }))
      );
      const items = await safeSection('tickets', errs, [], async () =>
        norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetTickets', { clientid: cid, limitnum: 25 })).tickets,
          'ticket'
        )
          .map(mapTicketRow)
          .sort((a, b) => (b.lastreply ?? '').localeCompare(a.lastreply ?? ''))
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
      const cid = requireClientId(params);
      const windowDays = num(params, 'days') ?? 60;
      const horizon = new Date(Date.now() + windowDays * 86400000)
        .toISOString()
        .slice(0, 10);
      const inWindow = (d?: string) =>
        !!d &&
        /^\d{4}-\d{2}-\d{2}/.test(d) &&
        d.slice(0, 10) >= '1971-01-01' &&
        d.slice(0, 10) <= horizon;
      const truncated = { services: false, domains: false };
      const svc = await safeSection('services', errs, [], async () => {
        const raw = norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetClientsProducts', { clientid: cid, limitnum: RENEWAL_FETCH_LIMIT }))
            .products,
          'product'
        );
        truncated.services = raw.length >= RENEWAL_FETCH_LIMIT;
        return raw
          .filter((p) => inWindow(str(p, 'nextduedate')))
          .map((p) => ({
            type: 'service' as const,
            id: num(p, 'id'),
            name: str(p, 'name'),
            due_date: str(p, 'nextduedate'),
            status: str(p, 'status'),
            recurring_amount: str(p, 'recurringamount'),
          }));
      });
      const dom = await safeSection('domains', errs, [], async () => {
        const raw = norm<WhmcsRow>(
          (await whmcs.read<Record<string, unknown>>('GetClientsDomains', { clientid: cid, limitnum: RENEWAL_FETCH_LIMIT }))
            .domains,
          'domain'
        );
        truncated.domains = raw.length >= RENEWAL_FETCH_LIMIT;
        return raw
          .filter((d) => inWindow(str(d, 'expirydate') ?? str(d, 'nextduedate')))
          .map((d) => ({
            type: 'domain' as const,
            id: num(d, 'id'),
            name: str(d, 'domainname'),
            due_date: str(d, 'expirydate') ?? str(d, 'nextduedate'),
            status: str(d, 'status'),
          }));
      });
      const upcoming = [...dom, ...svc].sort((a, b) =>
        (a.due_date ?? '').localeCompare(b.due_date ?? '')
      );
      return {
        window_days: windowDays,
        horizon,
        upcoming,
        truncated,
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_domain_portfolio_snapshot',
    'Read-only domain portfolio for a client: each domain with status, registrar, expiry, days-to-expiry, lock/id-protection, and an estimated 1-year renewal cost matched from GetTLDPricing. Sub-reads fault-isolated; pricing is best-effort (omitted on failure).',
    { clientid: z.number().int().positive().optional() },
    logger,
    rl,
    async (params) => {
      const errs: PartialError[] = [];
      const cid = requireClientId(params);

      // Best-effort TLD price map: longest-suffix → first-year renew price.
      interface PriceMap {
        map: Map<string, number>;
        currency: string | null;
      }
      const pricing = await safeSection<PriceMap | null>('tld_pricing', errs, null, async () => {
        const raw = await whmcs.read<Record<string, unknown>>('GetTLDPricing', {});
        const canon = mapToCanonicalTldPricing(raw);
        const map = new Map<string, number>();
        for (const p of canon.data.prices) {
          if (p.renew.length > 0) {
            const renew1 = p.renew.find((r) => r.period === 1) ?? p.renew[0];
            map.set(p.tld.toLowerCase(), renew1.price);
          }
        }
        return { map, currency: canon.data.currencyCode };
      });
      // Longest matching TLD suffix (so example.co.uk prefers .co.uk over .uk).
      const tldKeys = pricing
        ? [...pricing.map.keys()].sort((a, b) => b.length - a.length)
        : [];
      const renewalCostFor = (domainName: string): number | null => {
        if (!pricing) return null;
        const lower = domainName.toLowerCase();
        for (const k of tldKeys) {
          if (lower.endsWith(k)) return pricing.map.get(k) ?? null;
        }
        return null;
      };
      const truthy = (v: unknown): boolean =>
        v === true || v === 1 || v === '1' || v === 'on' || v === 'enabled';
      const today = new Date().toISOString().slice(0, 10);
      const daysTo = (d?: string): number | null => {
        if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
        const ms = Date.parse(`${d.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
        return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
      };

      let domainsTruncated = false;
      const domains = await safeSection('domains', errs, [], async () => {
        const raw = norm<WhmcsRow>(
          (
            await whmcs.read<Record<string, unknown>>('GetClientsDomains', {
              clientid: cid,
              limitnum: RENEWAL_FETCH_LIMIT,
            })
          ).domains,
          'domain'
        );
        domainsTruncated = raw.length >= RENEWAL_FETCH_LIMIT;
        return raw.map((d) => {
          const name = str(d, 'domainname') ?? '';
          const expiry = str(d, 'expirydate') ?? str(d, 'nextduedate');
          return {
            id: num(d, 'id'),
            domain: name,
            status: str(d, 'status'),
            registrar: str(d, 'registrar'),
            expiry_date: expiry,
            days_to_expiry: daysTo(expiry),
            id_protection: truthy(d.idprotection),
            do_not_renew: truthy(d.donotrenew),
            registrar_lock: truthy(d.registrarlock ?? d.registrarlockstatus),
            estimated_renewal_cost: renewalCostFor(name),
          };
        });
      });

      const soon = domains.filter(
        (d) => d.days_to_expiry !== null && d.days_to_expiry <= 30 && d.days_to_expiry >= -3650
      ).length;
      const knownCosts = domains
        .map((d) => d.estimated_renewal_cost)
        .filter((c): c is number => typeof c === 'number');
      return {
        clientid: cid,
        currency: pricing ? pricing.currency : null,
        summary: {
          total: domains.length,
          expiring_within_30d: soon,
          estimated_total_renewal_cost: knownCosts.reduce((a, b) => a + b, 0),
          priced_domains: knownCosts.length,
        },
        domains: domains.sort((a, b) => (a.expiry_date ?? '').localeCompare(b.expiry_date ?? '')),
        truncated: { domains: domainsTruncated },
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_accounts_receivable_aging',
    'Read-only A/R aging for a client: unpaid + overdue invoices bucketed by days-past-due (current / 1-30 / 31-60 / 61-90 / 90+), with per-bucket count + outstanding amount and a total. Sub-reads fault-isolated.',
    { clientid: z.number().int().positive().optional() },
    logger,
    rl,
    async (params) => {
      const errs: PartialError[] = [];
      const cid = requireClientId(params);
      const today = new Date().toISOString().slice(0, 10);
      const daysPastDue = (due?: string): number | null => {
        if (!due || !/^\d{4}-\d{2}-\d{2}/.test(due)) return null;
        const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
        return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
      };
      const outstanding = (inv: WhmcsRow): number => {
        const bal = num(inv, 'balance');
        if (bal !== undefined && Number.isFinite(bal)) return bal;
        const total = num(inv, 'total') ?? 0;
        const paid = num(inv, 'amountpaid') ?? 0;
        return total - paid;
      };

      const fetchByStatus = async (status: string): Promise<WhmcsRow[]> =>
        norm<WhmcsRow>(
          (
            await whmcs.read<Record<string, unknown>>('GetInvoices', {
              userid: cid,
              status,
              limitnum: RENEWAL_FETCH_LIMIT,
            })
          ).invoices,
          'invoice'
        );

      const invoices = await safeSection<WhmcsRow[]>('invoices', errs, [], async () => {
        const [unpaid, overdue] = await Promise.all([
          fetchByStatus('Unpaid'),
          fetchByStatus('Overdue'),
        ]);
        // De-dup by invoice id (an overdue invoice may appear in both lists).
        const byId = new Map<string, WhmcsRow>();
        for (const inv of [...unpaid, ...overdue]) {
          byId.set(String(num(inv, 'id') ?? str(inv, 'id') ?? Math.random()), inv);
        }
        return [...byId.values()];
      });

      const buckets = {
        current: { count: 0, amount: 0 },
        d1_30: { count: 0, amount: 0 },
        d31_60: { count: 0, amount: 0 },
        d61_90: { count: 0, amount: 0 },
        d90_plus: { count: 0, amount: 0 },
      };
      let currency: string | null = null;
      for (const inv of invoices) {
        currency ??= str(inv, 'currencycode') ?? str(inv, 'currency') ?? null;
        const amt = outstanding(inv);
        const dpd = daysPastDue(str(inv, 'duedate'));
        const b =
          dpd === null || dpd <= 0
            ? buckets.current
            : dpd <= 30
              ? buckets.d1_30
              : dpd <= 60
                ? buckets.d31_60
                : dpd <= 90
                  ? buckets.d61_90
                  : buckets.d90_plus;
        b.count += 1;
        b.amount += amt;
      }
      const total = Object.values(buckets).reduce((a, b) => a + b.amount, 0);
      return {
        clientid: cid,
        currency,
        buckets,
        summary: { open_invoices: invoices.length, total_outstanding: total },
        partial_errors: errs,
      };
    }
  );

  // ── Phase D aggregators (compose governed reads; degrade on unavailable
  //    capability; source IDs included; partial/incomplete clearly marked) ──

  /**
   * Truthful capability section. If the action is now `supported`
   * (Phase H promoted) we MUST NOT claim capability_unavailable — instead
   * report it supported with composition pending (a future aggregator
   * enhancement). Only an un-promoted capability is flagged unavailable.
   */
  const capSection = (action: string) => {
    const c = getCapability(action);
    if (c.status === 'supported') {
      return {
        action: c.action,
        status: c.status,
        composed: false,
        note: 'Capability supported (promoted); direct composition into this aggregator is a pending enhancement.',
      };
    }
    return {
      capability_unavailable: true as const,
      action: c.action,
      status: c.status,
      note: c.note,
    };
  };

  register(
    server,
    'get_activity_timeline',
    'Read-only merged timeline: client activity log + recent invoices + recent orders, newest first. Source IDs included; sub-reads fault-isolated.',
    { limit: z.number().int().min(1).max(50).default(20) },
    logger,
    rl,
    async (params) => {
      const cid = requireClientId(params);
      const n = num(params, 'limit') ?? 20;
      const errs: PartialError[] = [];
      const events: {
        type: string;
        id: number | string | undefined;
        date: string | undefined;
        summary: string;
      }[] = [];
      await safeSection('activity', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetActivityLog', {
          clientid: cid,
          limitnum: n,
        });
        for (const e of norm<WhmcsRow>(r.activity, 'entry')) {
          events.push({
            type: 'activity',
            id: num(e, 'id') ?? str(e, 'id'),
            date: str(e, 'date'),
            summary: str(e, 'description') ?? '',
          });
        }
        return [];
      });
      await safeSection('invoices', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetInvoices', {
          userid: cid,
          limitnum: n,
          orderby: 'date',
          order: 'desc',
        });
        for (const i of norm<WhmcsRow>(r.invoices, 'invoice')) {
          events.push({
            type: 'invoice',
            id: num(i, 'id') ?? str(i, 'id'),
            date: str(i, 'date'),
            summary: `invoice ${str(i, 'status') ?? ''} total ${str(i, 'total') ?? ''}`,
          });
        }
        return [];
      });
      await safeSection('orders', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetOrders', {
          userid: cid,
          limitnum: n,
        });
        for (const o of norm<WhmcsRow>(r.orders, 'order')) {
          events.push({
            type: 'order',
            id: num(o, 'id') ?? str(o, 'id'),
            date: str(o, 'date'),
            summary: `order ${str(o, 'status') ?? ''} amount ${str(o, 'amount') ?? ''}`,
          });
        }
        return [];
      });
      const timeline = events
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
        .slice(0, n);
      return { clientid: cid, count: timeline.length, timeline, partial_errors: errs };
    }
  );

  register(
    server,
    'get_reconciliation_snapshot',
    'Read-only reconciliation: invoice balances/status + (when GetTransactions is supported) per-client transactions matched to invoices with duplicate-risk / unmatched / unpaid-with-recent-payment signals. Detailed payment refs are scoped so a billing consumer can reconcile while an LLM consumer never sees raw gateway/transid. Includes a WHMCS 9 immutability notice and a structured (never faked) credit/debit-note capability marker. Degrades cleanly if GetTransactions is not supported.',
    {},
    logger,
    rl,
    async (params) => {
      const cid = requireClientId(params);
      const errs: PartialError[] = [];
      const invoices = await safeSection('invoices', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetInvoices', {
          userid: cid,
          limitnum: 50,
          orderby: 'date',
          order: 'desc',
        });
        return norm<WhmcsRow>(r.invoices, 'invoice').map(mapReconInvoiceRow);
      });

      const base: Record<string, unknown> = {
        clientid: cid,
        invoices,
        source_invoice_ids: invoices.map((i) => i.invoiceid),
        // Track 6: ALWAYS-safe informational sections (public.safe). Reads
        // are unaffected; these never carry fabricated data.
        whmcs9_notice: WHMCS9_NOTICE,
        ledger_adjustments: ledgerAdjustmentsSection(),
        partial_errors: errs,
      };

      // ── Track 2: transactions are the HIGHEST-sensitivity data here ──
      // Capability gate FIRST. Only compose if GetTransactions is
      // `supported` (Phase H promoted). Otherwise degrade to the existing
      // structured capability section and NEVER call the action — the
      // snapshot still returns invoices.
      const cap = getCapability('GetTransactions');
      if (cap.status !== 'supported') {
        return { ...base, transactions: capSection('GetTransactions') };
      }

      // Composed path. Fault-isolated: a GetTransactions failure becomes a
      // partial_errors entry and yields an empty (never fabricated) page.
      // The section returns BOTH rows and the bounded flag so there is no
      // closure-mutated `let` (which control-flow narrowing would otherwise
      // pin to a literal `false`).
      const txnResult = await safeSection<{
        rows: ReconTransaction[];
        bounded: boolean;
      }>('transactions', errs, { rows: [], bounded: false }, async () => {
        const r = await whmcs.read<Record<string, unknown>>(
          'GetTransactions',
          {
            // Per-client filter — the snapshot is per-client. WHMCS
            // GetTransactions supports clientid/invoiceid/transid filters.
            clientid: cid,
            limitnum: RECON_TX_FETCH_LIMIT,
          }
        );
        const canon = mapToCanonicalTransactions(r);
        return {
          rows: canon.map((c) => ({
            ...c.data,
            is_refund_or_reversal: isRefundOrReversal(c.data),
          })),
          bounded: canon.length >= RECON_TX_FETCH_LIMIT,
        };
      });
      const reconTxns = txnResult.rows;
      const txnPageBounded = txnResult.bounded;

      const matching = reconcile(reconTxns, invoices as InvoiceLite[]);

      const boundedNote = txnPageBounded
        ? {
            bounded_note: `Transaction page capped at ${String(RECON_TX_FETCH_LIMIT)} rows; more may exist. Reconciliation is over the bounded window only (GetTransactions pagination is unobserved on this build).`,
          }
        : {};

      return {
        ...base,
        // Safe summary (financial.reference ⇒ allowed for billing AND llm):
        // capability metadata + counts only. NO raw gateway/transid here.
        transactions: {
          action: cap.action,
          status: cap.status,
          composed: true as const,
          count: reconTxns.length,
          bounded: txnPageBounded,
        },
        // Numeric source row IDs (business.identifier-ish; allowed) so a
        // consumer can re-fetch a specific transaction by id.
        source_transaction_ids: reconTxns.map((t) => t.transactionRowId),
        // DETAILED payment refs + matching analysis. Classified
        // `system.audit` (see classifyAggregateKey): preserved for
        // `billing_reconciliation` (matching needs the refs) but DROPPED
        // for `llm_safe_summary` (raw gateway/transid never reach an LLM).
        reconciliation_ledger: {
          transactions: reconTxns,
          matching,
          bounded: txnPageBounded,
          ...boundedNote,
        },
      };
    }
  );

  register(
    server,
    'get_provisioning_snapshot',
    'Read-only provisioning audit: services (status/next-due) + provisioning orders, with source IDs. Automation log is capability-gated (GetAutomationLog unverified) and reported as a structured unavailable section.',
    {},
    logger,
    rl,
    async (params) => {
      const cid = requireClientId(params);
      const errs: PartialError[] = [];
      const services = await safeSection('services', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetClientsProducts', {
          clientid: cid,
          limitnum: 100,
        });
        return norm<WhmcsRow>(r.products, 'product').map(mapProvisioningServiceRow);
      });
      const orders = await safeSection('orders', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetOrders', {
          userid: cid,
          limitnum: 25,
        });
        return norm<WhmcsRow>(r.orders, 'order').map(mapOrderRow);
      });
      return {
        clientid: cid,
        services,
        orders,
        source_service_ids: services.map((s) => s.serviceid),
        automation_log: capSection('GetAutomationLog'),
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_risk_snapshot',
    'Read-only risk summary: overdue exposure, suspended services, do-not-renew domains. IDs/amounts/status only — no contact PII. Sub-reads fault-isolated.',
    {},
    logger,
    rl,
    async (params) => {
      const cid = requireClientId(params);
      const errs: PartialError[] = [];
      const overdue = await safeSection('overdue', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetInvoices', {
          userid: cid,
          status: 'Overdue',
          limitnum: 50,
          orderby: 'duedate',
          order: 'asc',
        });
        return norm<WhmcsRow>(r.invoices, 'invoice').map((i) => ({
          invoiceid: num(i, 'id'),
          balance: str(i, 'balance'),
          duedate: str(i, 'duedate'),
        }));
      });
      const suspended = await safeSection('suspended_services', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetClientsProducts', {
          clientid: cid,
          limitnum: 100,
        });
        return norm<WhmcsRow>(r.products, 'product')
          .filter((s) => str(s, 'status') === 'Suspended')
          .map((s) => ({
            serviceid: num(s, 'id'),
            product: str(s, 'name'),
            status: str(s, 'status'),
          }));
      });
      const overdueBalance = overdue.reduce(
        (sum, i) => sum + (Number(i.balance ?? 0) || 0),
        0
      );
      return {
        clientid: cid,
        risk: {
          overdue_invoice_count: overdue.length,
          overdue_balance: overdueBalance.toFixed(2),
          suspended_service_count: suspended.length,
        },
        overdue_invoices: overdue,
        suspended_services: suspended,
        source_invoice_ids: overdue.map((i) => i.invoiceid),
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_service_lifecycle',
    'Read-only lifecycle of a single service: the service record (status/next-due/recurring), its provisioning orders (GetOrders, matched by serviceid), and a capability-gated automation section (GetAutomationLog — degrades to a structured unavailable/supported marker). Sub-reads fault-isolated.',
    { serviceid: z.number().int().positive() },
    logger,
    rl,
    async (params) => {
      const cid = requireClientId(params);
      const sid = num(params, 'serviceid');
      if (sid === undefined) throw new Error('serviceid is required');
      const errs: PartialError[] = [];

      const service = await safeSection<Record<string, unknown> | null>(
        'service',
        errs,
        null,
        async () => {
          const r = await whmcs.read<Record<string, unknown>>(
            'GetClientsProducts',
            { clientid: cid, serviceid: sid }
          );
          const row = norm<WhmcsRow>(r.products, 'product').find(
            (p) => num(p, 'id') === sid
          );
          if (!row) return null;
          return {
            id: num(row, 'id'),
            name: str(row, 'name'),
            domain: str(row, 'domain'),
            status: str(row, 'status'),
            nextduedate: str(row, 'nextduedate'),
            recurringamount: str(row, 'recurringamount'),
          };
        }
      );

      const orders = await safeSection('orders', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetOrders', {
          userid: cid,
          limitnum: 50,
        });
        return norm<WhmcsRow>(r.orders, 'order')
          .filter((o) => {
            // Provisioning orders referencing this service (best-effort:
            // WHMCS exposes serviceid on order line items in some builds).
            const direct = num(o, 'serviceid');
            if (direct !== undefined) return direct === sid;
            // Fall back to scanning a nested line-item container if present.
            const lines = norm<WhmcsRow>(
              (o as Record<string, unknown>).lineitems,
              'lineitem'
            );
            return lines.some((li) => num(li, 'relid') === sid);
          })
          .map(mapOrderRow);
      });

      return {
        clientid: cid,
        service,
        orders,
        automation: capSection('GetAutomationLog'),
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_revenue_report',
    'Read-only revenue report over a `days` window (default 90): paid invoices (count + total) from GetInvoices filtered client-side by date, plus a capability-gated transactions roll-up (GetTransactions — total_in/total_out, or a structured unavailable marker). Includes an accrual-vs-cash caveat. Sub-reads fault-isolated.',
    { days: z.number().int().min(1).max(3650).default(90) },
    logger,
    rl,
    async (params) => {
      const cid = requireClientId(params);
      const windowDays = num(params, 'days') ?? 90;
      const errs: PartialError[] = [];
      const since = new Date(Date.now() - windowDays * 86400000)
        .toISOString()
        .slice(0, 10);
      const inWindow = (d: string | null): boolean =>
        !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && d.slice(0, 10) >= since;

      let currency: string | null = null;
      const paid = await safeSection<{ count: number; total: number }>(
        'invoices',
        errs,
        { count: 0, total: 0 },
        async () => {
          const r = await whmcs.read<Record<string, unknown>>('GetInvoices', {
            userid: cid,
            status: 'Paid',
            limitnum: RENEWAL_FETCH_LIMIT,
            orderby: 'date',
            order: 'desc',
          });
          const rows = norm<WhmcsRow>(r.invoices, 'invoice').filter((i) =>
            inWindow(str(i, 'datepaid') ?? str(i, 'date') ?? null)
          );
          let total = 0;
          for (const i of rows) {
            currency ??= str(i, 'currencycode') ?? str(i, 'currency') ?? null;
            total += num(i, 'total') ?? 0;
          }
          return { count: rows.length, total: Number(total.toFixed(2)) };
        }
      );

      // Transactions roll-up is capability-gated (highest-sensitivity data).
      const cap = getCapability('GetTransactions');
      let transactions: Record<string, unknown>;
      if (cap.status !== 'supported') {
        transactions = capSection('GetTransactions');
      } else {
        const txn = await safeSection<{
          count: number;
          total_in: number;
          total_out: number;
        }>(
          'transactions',
          errs,
          { count: 0, total_in: 0, total_out: 0 },
          async () => {
            const r = await whmcs.read<Record<string, unknown>>(
              'GetTransactions',
              { clientid: cid, limitnum: RECON_TX_FETCH_LIMIT }
            );
            const canon = mapToCanonicalTransactions(r);
            let totalIn = 0;
            let totalOut = 0;
            let count = 0;
            for (const c of canon) {
              const t = c.data;
              const dt = inWindow(t.date);
              if (!dt) continue;
              count += 1;
              if (typeof t.amountIn === 'number') totalIn += t.amountIn;
              if (typeof t.amountOut === 'number') totalOut += t.amountOut;
            }
            return {
              count,
              total_in: Number(totalIn.toFixed(2)),
              total_out: Number(totalOut.toFixed(2)),
            };
          }
        );
        transactions = {
          action: cap.action,
          status: cap.status,
          composed: true as const,
          count: txn.count,
          total_in: txn.total_in,
          total_out: txn.total_out,
        };
      }

      return {
        clientid: cid,
        window_days: windowDays,
        currency,
        paid: { count: paid.count, total: paid.total },
        transactions,
        accrual_vs_cash:
          'Paid invoices reflect accrual revenue (invoice total marked paid); transactions reflect cash movements (gateway in/out). They can differ due to credits, partial payments, fees, or refunds — reconcile before reporting.',
        partial_errors: errs,
      };
    }
  );

  register(
    server,
    'get_reconciliation_export',
    'Read-only NORMALIZED reconciliation ledger: each entry pairs an invoice with its matching transaction (invoice_id/total/status, transaction_id/gateway/amount_in/amount_out/date, matched flag) suitable for bank / 26AS reconciliation, plus unmatched_invoices / unmatched_transactions counts. Built on GetInvoices + (capability-gated) GetTransactions. Clearly marks when GetTransactions is unavailable. Sub-reads fault-isolated.',
    {},
    logger,
    rl,
    async (params) => {
      const cid = requireClientId(params);
      const errs: PartialError[] = [];

      const invoices = await safeSection('invoices', errs, [], async () => {
        const r = await whmcs.read<Record<string, unknown>>('GetInvoices', {
          userid: cid,
          limitnum: RENEWAL_FETCH_LIMIT,
          orderby: 'date',
          order: 'desc',
        });
        return norm<WhmcsRow>(r.invoices, 'invoice').map(mapReconInvoiceRow);
      });

      const cap = getCapability('GetTransactions');
      const base: Record<string, unknown> = {
        clientid: cid,
        source_invoice_ids: invoices.map((i) => i.invoiceid),
        whmcs9_notice: WHMCS9_NOTICE,
        partial_errors: errs,
      };

      // Without GetTransactions we cannot pair payments — degrade clearly:
      // emit invoice-only entries (unmatched) and a capability marker.
      if (cap.status !== 'supported') {
        const entries = invoices.map((inv) => ({
          invoice_id: inv.invoiceid,
          invoice_total: inv.total,
          invoice_status: inv.status,
          transaction_id: null,
          gateway: null,
          amount_in: null,
          amount_out: null,
          date: inv.date,
          matched: false,
        }));
        return {
          ...base,
          transactions: capSection('GetTransactions'),
          reconciliation_ledger: { entries },
          unmatched_invoices: entries.length,
          unmatched_transactions: 0,
        };
      }

      const txnRows = await safeSection<CanonicalTransaction[]>(
        'transactions',
        errs,
        [],
        async () => {
          const r = await whmcs.read<Record<string, unknown>>(
            'GetTransactions',
            { clientid: cid, limitnum: RECON_TX_FETCH_LIMIT }
          );
          return mapToCanonicalTransactions(r).map((c) => c.data);
        }
      );

      // Index invoices by id; build the normalized ledger.
      const invById = new Map<number, (typeof invoices)[number]>();
      for (const inv of invoices) {
        const id = Number(inv.invoiceid);
        if (Number.isFinite(id)) invById.set(id, inv);
      }
      const matchedInvoiceIds = new Set<number>();
      let unmatchedTransactions = 0;

      const entries = txnRows.map((t) => {
        const inv =
          t.invoiceId !== null ? invById.get(t.invoiceId) : undefined;
        const isMatched = inv !== undefined;
        if (isMatched && t.invoiceId !== null) {
          matchedInvoiceIds.add(t.invoiceId);
        } else {
          unmatchedTransactions += 1;
        }
        return {
          invoice_id: inv ? inv.invoiceid : t.invoiceId,
          invoice_total: inv ? inv.total : null,
          invoice_status: inv ? inv.status : null,
          transaction_id: t.transactionId,
          gateway: t.gateway,
          amount_in: t.amountIn,
          amount_out: t.amountOut,
          date: t.date,
          matched: isMatched,
        };
      });

      // Invoices with no transaction at all → unmatched ledger rows.
      for (const inv of invoices) {
        const id = Number(inv.invoiceid);
        if (Number.isFinite(id) && matchedInvoiceIds.has(id)) continue;
        entries.push({
          invoice_id: inv.invoiceid,
          invoice_total: inv.total ?? null,
          invoice_status: inv.status ?? null,
          transaction_id: null,
          gateway: null,
          amount_in: null,
          amount_out: null,
          date: inv.date ?? null,
          matched: false,
        });
      }

      const unmatchedInvoices = invoices.filter(
        (inv) => !matchedInvoiceIds.has(Number(inv.invoiceid))
      ).length;

      return {
        ...base,
        transactions: {
          action: cap.action,
          status: cap.status,
          composed: true as const,
          count: txnRows.length,
        },
        source_transaction_ids: txnRows.map((t) => t.transactionRowId),
        reconciliation_ledger: { entries },
        unmatched_invoices: unmatchedInvoices,
        unmatched_transactions: unmatchedTransactions,
      };
    }
  );
}
