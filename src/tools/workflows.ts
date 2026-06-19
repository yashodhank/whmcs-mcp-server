/**
 * Executable composite WORKFLOW tools — the server-side twins of the #61
 * power-user prompts (`dunning_sweep`, `renewal_risk_triage`,
 * `ticket_triage_to_resolution`, `month_end_close`).
 *
 * Each tool performs the orchestration the matching prompt only DESCRIBES:
 *   1. read the WHMCS data it needs via `whmcs.read(...)` (fault-isolated:
 *      one failed read records a `partial_errors[]` entry, never aborts);
 *   2. compute candidates with the SAME logic the prompt prescribes;
 *   3. DRAFT the governed write-intents via `draftWorkflowIntent(...)`.
 *
 * DRAFT-ONLY INVARIANT (the whole point): these tools NEVER call
 * `whmcs.mutate`, NEVER validate-to-approved, NEVER approve, NEVER execute,
 * and NEVER reach the execution gate. They read + draft, and return a single
 * structured result with `executed: false` ALWAYS. Drafting reuses the
 * EXISTING governance (resolveWriteConsumer + assertWriteScopeAllowed, inside
 * `draftWorkflowIntent`) and the EXISTING `store`/`audit` singletons in
 * writeFlow.ts — so `get_write_intent` can fetch these drafts. A candidate
 * whose consumer/scope is not permitted is SKIPPED (recorded in `skipped[]`
 * with the deny reason), never drafted.
 *
 * The four tool names are prefixed `workflow_` to disambiguate from the
 * same-named prompts.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { assertNoPAN, PANDetectedError } from '../security/panScanner.js';
import { isToolAllowed } from '../config.js';
import { AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import { asRecord, isRecord, num, str } from '../canonical/_shared.js';
import { mapToCanonicalTransactions } from '../canonical/transaction.js';
import {
  draftWorkflowIntent,
  type WorkflowDraftRequest,
  type WorkflowDraftResult,
} from './writeFlow.js';
import { reconcile, type ReconTransaction, type InvoiceLite } from './aggregators.js';
import { ToolProgress, type ProgressExtra } from './progress.js';
import { deriveToolMeta } from './meta.js';

/** Loose WHMCS API row / container object. */
type WhmcsRow = Record<string, unknown>;

/** A fault-isolated sub-read failure record (mirrors the aggregators'). */
interface PartialError {
  readonly section: string;
  readonly error: string;
}

/** A candidate the workflow chose NOT to draft, with the reason why. */
interface SkippedCandidate {
  readonly ref: Record<string, unknown>;
  readonly reason: string;
}

/**
 * Per-tool fetch cap. A normalized list reaching this length is treated as
 * possibly-truncated (more records may exist beyond it).
 */
const FETCH_LIMIT = 100;

/** Default overdue threshold (days past due) for the dunning sweep. */
const DUNNING_DEFAULT_MIN_DAYS = 30;
/** Default candidate cap per workflow run. */
const DEFAULT_LIMIT = 50;
/** Default renewal horizon (days) for the renewal-risk triage. */
const RENEWAL_DEFAULT_HORIZON_DAYS = 30;
/** Default open-ticket cap for the ticket triage. */
const TICKET_DEFAULT_LIMIT = 25;
/** Default reconciliation window (days) for the month-end close. */
const CLOSE_DEFAULT_WINDOW_DAYS = 30;

/**
 * Normalize a WHMCS list container (e.g. `{ product: [...] }`) to an array,
 * tolerating both wrapped and bare shapes. Mirrors the aggregators' `norm`.
 */
function norm<T>(container: unknown, singular: string): T[] {
  const inner = isRecord(container) && singular in container ? container[singular] : container;
  return normalizeToArray<T>(inner);
}

/**
 * Run a sub-read with fault isolation. On failure, records a
 * `{ section, error }` entry and returns the supplied fallback. Mirrors the
 * aggregators' `safeSection` so one failed read never aborts the workflow.
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

const TODAY = (): string => new Date().toISOString().slice(0, 10);

/** Days a due date is past today (positive ⇒ overdue), or null if unparseable. */
function daysPastDue(due: string | undefined, today: string): number | null {
  if (!due || !/^\d{4}-\d{2}-\d{2}/.test(due)) return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

/** Days until a future date (positive ⇒ upcoming), or null if unparseable. */
function daysUntil(d: string | undefined, today: string): number | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const ms = Date.parse(`${d.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

const TRUTHY = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'on' || v === 'enabled';

/** Shared, machine-readable workflow output schema (single shape). */
const WORKFLOW_OUTPUT_SHAPE = {
  workflow: z.string(),
  generated_at_note: z.string(),
  candidates: z.array(z.record(z.string(), z.unknown())),
  drafted_intent_ids: z.array(z.string()),
  skipped: z.array(z.record(z.string(), z.unknown())),
  partial_errors: z.array(z.record(z.string(), z.unknown())),
  // ALWAYS the literal false — these tools never execute. Declared as a
  // literal so the contract is machine-checkable.
  executed: z.literal(false),
  // Optional per-workflow summary block (e.g. month-end close roll-up).
  close_summary: z.record(z.string(), z.unknown()).optional(),
  // Diagnostic keys carried only by an error result.
  isError: z.literal(true).optional(),
  error: z.string().optional(),
} as const;

function err(message: string, extra?: Record<string, unknown>) {
  const payload = { isError: true, error: message, ...(extra ?? {}) };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function out(payload: Record<string, unknown>) {
  const _meta = deriveToolMeta(payload);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(_meta ? { _meta } : {}),
  };
}

const WORKFLOW_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

type Handler = ToolCallback<z.ZodRawShape>;

/**
 * Register a single composite workflow tool. Replicates the MINIMAL wrapper the
 * writeFlow tools use (rate-limit, PAN guard, structured logging, `AUTH_SHAPE`,
 * write-flow annotations) — these are write-DRAFTING tools gated by the caller's
 * `auth_token`, NOT read-projection aggregators, so they do not run the
 * aggregator governance projection. No-op if the tool is disabled.
 */
function register(
  server: McpServer,
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  logger: Logger,
  rl: RateLimiter,
  // The 2nd arg is the SDK `RequestHandlerExtra` (narrowed to `ProgressExtra`),
  // forwarded so a `run` callback can emit MCP progress notifications during a
  // long portfolio fan-out + draft loop. OPTIONAL and backward compatible.
  run: (
    params: Record<string, unknown>,
    extra?: ProgressExtra
  ) => Promise<Record<string, unknown> | ReturnType<typeof err>>
): void {
  if (!isToolAllowed(name)) return;
  const handler: Handler = (async (params: Record<string, unknown>, extra?: ProgressExtra) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      log.logToolCall(name, {}, false);
      if (!rl.tryConsume()) throw new RateLimitError();
      // PCI-DSS input guard: reject raw card numbers (PAN). Never echoed.
      try {
        assertNoPAN(params);
      } catch (e) {
        if (e instanceof PANDetectedError) {
          log.logToolResult(name, false, Date.now() - t0, 'PAN detected in input (rejected)');
          return err(
            'input rejected: a credit card number (PAN) was detected; never send raw card data through this tool'
          );
        }
        throw e;
      }
      const r = await run(params, extra);
      log.logToolResult(name, true, Date.now() - t0);
      return r;
    } catch (e) {
      log.logToolResult(name, false, Date.now() - t0, e instanceof Error ? e.message : String(e));
      if (e instanceof RateLimitError) return err(e.message);
      throw e;
    }
  }) as unknown as Handler;
  server.registerTool(
    name,
    {
      description,
      inputSchema: { ...inputShape, ...AUTH_SHAPE },
      outputSchema: WORKFLOW_OUTPUT_SHAPE,
      annotations: WORKFLOW_ANNOTATIONS,
    },
    handler
  );
}

/**
 * Draft via the governance helper, routing the outcome into either
 * `drafted` or `skipped[]`. A consumer/scope DENY is a SKIP (the candidate is
 * flagged for human review), never a hard failure — so one ungranted scope
 * never aborts the sweep. Returns the new intent_id on success, else null.
 */
function draftOrSkip(
  req: WorkflowDraftRequest,
  ref: Record<string, unknown>,
  drafted: string[],
  skipped: SkippedCandidate[]
): string | null {
  const res: WorkflowDraftResult = draftWorkflowIntent(req);
  if (res.ok) {
    drafted.push(res.intent_id);
    return res.intent_id;
  }
  skipped.push({ ref, reason: res.reason });
  return null;
}

function baseResult(workflow: string): {
  workflow: string;
  generated_at_note: string;
  candidates: Record<string, unknown>[];
  drafted_intent_ids: string[];
  skipped: SkippedCandidate[];
  partial_errors: PartialError[];
  executed: false;
} {
  return {
    workflow,
    generated_at_note: `computed ${new Date().toISOString()}; DRAFT-ONLY — nothing executed`,
    candidates: [],
    drafted_intent_ids: [],
    skipped: [],
    partial_errors: [],
    executed: false,
  };
}

export function registerWorkflowTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  // ============================================================
  // workflow_dunning_sweep (mirrors the `dunning_sweep` prompt)
  // ============================================================
  register(
    server,
    'workflow_dunning_sweep',
    'Composite DRAFT-ONLY dunning sweep: reads overdue invoices + client identity, then DRAFTS a per-client client_note:write reminder (LOW) and, where goodwill policy applies, an OPTIONAL billing:credit:add DRAFT (HIGH, sealed — never executed here). Never mutates, approves, or executes. Consumer + write-scope gated.',
    {
      overdue_min_days: z.number().int().min(0).max(3650).default(DUNNING_DEFAULT_MIN_DAYS),
      limit: z.number().int().min(1).max(500).default(DEFAULT_LIMIT),
      goodwill_credit: z
        .boolean()
        .default(false)
        .describe(
          'When true, ALSO draft an OPTIONAL billing:credit:add (HIGH, sealed) per overdue client.'
        ),
    },
    logger,
    rl,
    async (p, extra) => {
      const result = baseResult('dunning_sweep');
      const progress = new ToolProgress(0, extra);
      const authToken = typeof p.auth_token === 'string' ? p.auth_token : undefined;
      const minDays = num(p, 'overdue_min_days') ?? DUNNING_DEFAULT_MIN_DAYS;
      const limit = num(p, 'limit') ?? DEFAULT_LIMIT;
      const goodwill = p.goodwill_credit === true;
      const today = TODAY();

      // Read overdue invoices (Unpaid + Overdue) across the portfolio.
      const invoices = await safeSection<WhmcsRow[]>(
        'invoices',
        result.partial_errors,
        [],
        async () => {
          const fetchByStatus = async (status: string): Promise<WhmcsRow[]> =>
            norm<WhmcsRow>(
              (
                await whmcs.read<Record<string, unknown>>('GetInvoices', {
                  status,
                  limitnum: FETCH_LIMIT,
                  orderby: 'duedate',
                  order: 'asc',
                })
              ).invoices,
              'invoice'
            );
          const [unpaid, overdue] = await Promise.all([
            fetchByStatus('Unpaid'),
            fetchByStatus('Overdue'),
          ]);
          const byId = new Map<string, WhmcsRow>();
          for (const inv of [...unpaid, ...overdue]) {
            byId.set(String(num(inv, 'id') ?? str(inv, 'id') ?? Math.random()), inv);
          }
          return [...byId.values()];
        }
      );

      // Filter to genuinely-overdue invoices and group by client.
      interface ClientGroup {
        clientid: number;
        invoice_ids: number[];
        oldest_days: number;
        overdue_total: number;
      }
      const byClient = new Map<number, ClientGroup>();
      for (const inv of invoices) {
        const dpd = daysPastDue(str(inv, 'duedate'), today);
        if (dpd === null || dpd < minDays) continue;
        const cid = num(inv, 'userid') ?? num(inv, 'clientid');
        const invId = num(inv, 'id');
        if (cid === undefined || invId === undefined) continue;
        const bal = num(inv, 'balance') ?? (num(inv, 'total') ?? 0) - (num(inv, 'amountpaid') ?? 0);
        const g = byClient.get(cid) ?? {
          clientid: cid,
          invoice_ids: [],
          oldest_days: 0,
          overdue_total: 0,
        };
        g.invoice_ids.push(invId);
        g.oldest_days = Math.max(g.oldest_days, dpd);
        g.overdue_total += Number.isFinite(bal) ? bal : 0;
        byClient.set(cid, g);
      }

      const groups = [...byClient.values()]
        .sort((a, b) => b.oldest_days - a.oldest_days)
        .slice(0, limit);
      progress.setTotal(groups.length);

      for (const g of groups) {
        const candidate: Record<string, unknown> = {
          clientid: g.clientid,
          overdue_total: Number(g.overdue_total.toFixed(2)),
          oldest_days_past_due: g.oldest_days,
          overdue_invoice_ids: g.invoice_ids,
          drafted_intent_ids: [] as string[],
        };
        progress.step(`client ${g.clientid}`);
        // LOW-risk reminder note referencing the overdue invoice id(s).
        const noteId = draftOrSkip(
          {
            auth_token: authToken,
            scope: 'client_note:write',
            params: {
              userid: g.clientid,
              note: `Dunning reminder: ${g.invoice_ids.length} overdue invoice(s) (${g.invoice_ids.join(', ')}), oldest ${g.oldest_days}d past due, outstanding ${g.overdue_total.toFixed(2)}.`,
            },
            naturalKey: `dunning_note:${g.clientid}:${g.invoice_ids.join('-')}`,
            projected_effect: `Add a dunning reminder note to client ${g.clientid}.`,
            preconditions: { overdue_invoice_ids: g.invoice_ids },
          },
          { clientid: g.clientid, kind: 'client_note:write' },
          result.drafted_intent_ids,
          result.skipped
        );
        if (noteId) (candidate.drafted_intent_ids as string[]).push(noteId);

        // OPTIONAL goodwill credit — HIGH risk, sealed; only drafted (never
        // executed here) and only when the caller opts in.
        if (goodwill) {
          const creditId = draftOrSkip(
            {
              auth_token: authToken,
              scope: 'billing:credit:add',
              params: {
                clientid: g.clientid,
                description: `Goodwill credit re: overdue invoices ${g.invoice_ids.join(', ')}`,
              },
              naturalKey: `dunning_goodwill:${g.clientid}:${g.invoice_ids.join('-')}`,
              projected_effect: `Draft a goodwill credit for client ${g.clientid} (HIGH; sealed — not executed).`,
              preconditions: { overdue_invoice_ids: g.invoice_ids },
            },
            { clientid: g.clientid, kind: 'billing:credit:add' },
            result.drafted_intent_ids,
            result.skipped
          );
          if (creditId) (candidate.drafted_intent_ids as string[]).push(creditId);
        }
        result.candidates.push(candidate);
      }
      progress.finish();
      return out(result);
    }
  );

  // ============================================================
  // workflow_renewal_risk_triage (mirrors `renewal_risk_triage`)
  // ============================================================
  register(
    server,
    'workflow_renewal_risk_triage',
    'Composite DRAFT-ONLY renewal-risk triage: reads upcoming service + domain renewals in the horizon, ranks by churn risk (auto-renew off / soonest first), and DRAFTS a ticket:create reminder (LOW) for at-risk renewals. NEVER drafts domain:renew or any charge. Never mutates, approves, or executes. Consumer + write-scope gated.',
    {
      horizon_days: z.number().int().min(1).max(3650).default(RENEWAL_DEFAULT_HORIZON_DAYS),
      limit: z.number().int().min(1).max(500).default(DEFAULT_LIMIT),
    },
    logger,
    rl,
    async (p, extra) => {
      const result = baseResult('renewal_risk_triage');
      const progress = new ToolProgress(0, extra);
      const authToken = typeof p.auth_token === 'string' ? p.auth_token : undefined;
      const horizon = num(p, 'horizon_days') ?? RENEWAL_DEFAULT_HORIZON_DAYS;
      const limit = num(p, 'limit') ?? DEFAULT_LIMIT;
      const today = TODAY();

      const inWindow = (days: number | null): boolean =>
        days !== null && days >= -3650 && days <= horizon;

      interface Renewal {
        type: 'service' | 'domain';
        clientid: number | undefined;
        id: number | undefined;
        name: string | undefined;
        due_date: string | undefined;
        days_remaining: number | null;
        auto_renew: boolean;
      }
      const renewals: Renewal[] = [];

      await safeSection('services', result.partial_errors, null, async () => {
        const raw = norm<WhmcsRow>(
          (
            await whmcs.read<Record<string, unknown>>('GetClientsProducts', {
              limitnum: FETCH_LIMIT,
            })
          ).products,
          'product'
        );
        for (const s of raw) {
          const due = str(s, 'nextduedate');
          const dr = daysUntil(due, today);
          if (!inWindow(dr)) continue;
          renewals.push({
            type: 'service',
            clientid: num(s, 'clientid') ?? num(s, 'userid'),
            id: num(s, 'id'),
            name: str(s, 'name'),
            due_date: due,
            days_remaining: dr,
            // recurringamount of 0 / 'donotrenew' flag ⇒ auto-renew off-ish.
            auto_renew: !TRUTHY(s.donotrenew),
          });
        }
        return null;
      });

      await safeSection('domains', result.partial_errors, null, async () => {
        const raw = norm<WhmcsRow>(
          (
            await whmcs.read<Record<string, unknown>>('GetClientsDomains', {
              limitnum: FETCH_LIMIT,
            })
          ).domains,
          'domain'
        );
        for (const d of raw) {
          const due = str(d, 'expirydate') ?? str(d, 'nextduedate');
          const dr = daysUntil(due, today);
          if (!inWindow(dr)) continue;
          renewals.push({
            type: 'domain',
            clientid: num(d, 'clientid') ?? num(d, 'userid'),
            id: num(d, 'id'),
            name: str(d, 'domainname'),
            due_date: due,
            days_remaining: dr,
            auto_renew: !TRUTHY(d.donotrenew),
          });
        }
        return null;
      });

      // Rank: at-risk first (auto-renew off), then soonest expiry.
      const ranked = renewals
        .map((r) => ({
          ...r,
          at_risk: !r.auto_renew,
        }))
        .sort((a, b) => {
          if (a.at_risk !== b.at_risk) return a.at_risk ? -1 : 1;
          return (a.days_remaining ?? 9999) - (b.days_remaining ?? 9999);
        })
        .slice(0, limit);
      progress.setTotal(ranked.length);

      for (const r of ranked) {
        progress.step(`${r.type} ${String(r.id ?? '')}`);
        const candidate: Record<string, unknown> = {
          clientid: r.clientid,
          type: r.type,
          item_id: r.id,
          item: r.name,
          due_date: r.due_date,
          days_remaining: r.days_remaining,
          auto_renew: r.auto_renew,
          at_risk: r.at_risk,
          drafted_intent_id: null as string | null,
        };
        // ONLY at-risk renewals get a reminder ticket DRAFT. Non-at-risk
        // renewals are recommended for human action (not drafted) — recorded
        // as a candidate without a draft.
        if (r.at_risk && r.clientid !== undefined) {
          const id = draftOrSkip(
            {
              auth_token: authToken,
              scope: 'ticket:create',
              params: {
                clientid: r.clientid,
                subject: `Upcoming renewal at risk: ${r.name ?? r.type} due ${r.due_date ?? 'soon'}`,
                message: `The ${r.type} "${r.name ?? r.id}" is due ${r.due_date ?? 'soon'} (${r.days_remaining ?? '?'} days) with auto-renew OFF. Please review.`,
              },
              naturalKey: `renewal_ticket:${r.clientid}:${r.type}:${String(r.id)}:${r.due_date ?? ''}`,
              projected_effect: `Draft a renewal-reminder ticket for client ${r.clientid} (${r.type} ${String(r.id)}).`,
              preconditions: { due_date: r.due_date, auto_renew: r.auto_renew },
            },
            { clientid: r.clientid, kind: 'ticket:create' },
            result.drafted_intent_ids,
            result.skipped
          );
          candidate.drafted_intent_id = id;
        }
        result.candidates.push(candidate);
      }
      progress.finish();
      return out(result);
    }
  );

  // ============================================================
  // workflow_ticket_triage_to_resolution (mirrors the prompt)
  // ============================================================
  register(
    server,
    'workflow_ticket_triage_to_resolution',
    'Composite DRAFT-ONLY ticket triage: reads open tickets + each thread, then DRAFTS the smallest appropriate action — an internal ticket:note (LOW) and/or a ticket:status change (MEDIUM). Customer-facing replies stay drafts only and are flagged for human review. Never mutates, approves, or executes. Consumer + write-scope gated.',
    {
      deptid: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(TICKET_DEFAULT_LIMIT),
    },
    logger,
    rl,
    async (p, extra) => {
      const result = baseResult('ticket_triage_to_resolution');
      const progress = new ToolProgress(0, extra);
      const authToken = typeof p.auth_token === 'string' ? p.auth_token : undefined;
      const limit = num(p, 'limit') ?? TICKET_DEFAULT_LIMIT;
      const deptid = num(p, 'deptid');

      const tickets = await safeSection<WhmcsRow[]>(
        'tickets',
        result.partial_errors,
        [],
        async () => {
          const readParams: Record<string, unknown> = { status: 'Open', limitnum: FETCH_LIMIT };
          if (deptid !== undefined) readParams.deptid = deptid;
          return norm<WhmcsRow>(
            (await whmcs.read<Record<string, unknown>>('GetTickets', readParams)).tickets,
            'ticket'
          );
        }
      );

      const selected = tickets.slice(0, limit);
      progress.setTotal(selected.length);
      for (const t of selected) {
        const ticketid = num(t, 'id');
        if (ticketid === undefined) continue;
        progress.step(`ticket ${ticketid}`);
        const subject = str(t, 'subject') ?? '';
        const status = str(t, 'status') ?? '';
        const clientid = num(t, 'userid') ?? num(t, 'clientid');

        // Read the full thread for context (fault-isolated per ticket).
        const thread = await safeSection<WhmcsRow>(
          `thread:${ticketid}`,
          result.partial_errors,
          {},
          async () => asRecord(await whmcs.read<Record<string, unknown>>('GetTicket', { ticketid }))
        );
        const replyCount = normalizeToArray(
          isRecord(thread.replies) ? thread.replies.reply : thread.replies
        ).length;

        const candidate: Record<string, unknown> = {
          ticketid,
          subject,
          status,
          clientid,
          reply_count: replyCount,
          drafted_intent_ids: [] as string[],
          needs_human_review: false,
        };

        // Always draft an internal note summarizing findings for a human.
        const noteId = draftOrSkip(
          {
            auth_token: authToken,
            scope: 'ticket:note',
            params: {
              ticketid,
              message: `Triage note: subject="${subject}", status=${status}, ${replyCount} repl(y/ies). Reviewed thread for resolution.`,
            },
            naturalKey: `triage_note:${ticketid}`,
            projected_effect: `Add an internal triage note to ticket ${ticketid}.`,
            preconditions: { status },
          },
          { ticketid, kind: 'ticket:note' },
          result.drafted_intent_ids,
          result.skipped
        );
        if (noteId) (candidate.drafted_intent_ids as string[]).push(noteId);

        // A MEDIUM status change is drafted only when the ticket is awaiting
        // staff action (heuristic mirrors the prompt's "smallest appropriate
        // action"): move a "Customer-Reply"/"Open" ticket to "Answered" for
        // human confirmation. The MEDIUM draft is NOT executed here.
        if (/customer.?reply|open/i.test(status)) {
          const statusId = draftOrSkip(
            {
              auth_token: authToken,
              scope: 'ticket:status',
              params: { ticketid, status: 'Answered' },
              naturalKey: `triage_status:${ticketid}`,
              projected_effect: `Draft a status change for ticket ${ticketid} to "Answered" (MEDIUM; not executed).`,
              preconditions: { from_status: status },
            },
            { ticketid, kind: 'ticket:status' },
            result.drafted_intent_ids,
            result.skipped
          );
          if (statusId) (candidate.drafted_intent_ids as string[]).push(statusId);
        }

        // Customer-facing replies are HUMAN-GATED: we never draft a
        // customer-visible ticket:reply automatically — flag for human review.
        candidate.needs_human_review = true;
        result.candidates.push(candidate);
      }
      progress.finish();
      return out(result);
    }
  );

  // ============================================================
  // workflow_month_end_close (mirrors `month_end_close`)
  // ============================================================
  register(
    server,
    'workflow_month_end_close',
    'Composite DRAFT-ONLY month-end close: reads transactions + invoices, runs the pure reconcile() analysis, then DRAFTS a client_note:write audit annotation (LOW) per flagged discrepancy. Annotate-only — NEVER drafts any billing/money scope. Never mutates, approves, or executes. Consumer + write-scope gated.',
    {
      window_days: z.number().int().min(1).max(3650).default(CLOSE_DEFAULT_WINDOW_DAYS),
      limit: z.number().int().min(1).max(500).default(DEFAULT_LIMIT),
    },
    logger,
    rl,
    async (p, extra) => {
      const result = baseResult('month_end_close');
      const progress = new ToolProgress(0, extra);
      const authToken = typeof p.auth_token === 'string' ? p.auth_token : undefined;
      const windowDays = num(p, 'window_days') ?? CLOSE_DEFAULT_WINDOW_DAYS;
      const limit = num(p, 'limit') ?? DEFAULT_LIMIT;

      // Read transactions + invoices (mirror get_reconciliation_snapshot's
      // actions: GetTransactions + GetInvoices).
      const rawTxns = await safeSection<unknown>(
        'transactions',
        result.partial_errors,
        { transactions: [] },
        async () =>
          whmcs.read<Record<string, unknown>>('GetTransactions', { limitnum: FETCH_LIMIT })
      );
      const invoiceRows = await safeSection<WhmcsRow[]>(
        'invoices',
        result.partial_errors,
        [],
        async () =>
          norm<WhmcsRow>(
            (await whmcs.read<Record<string, unknown>>('GetInvoices', { limitnum: FETCH_LIMIT }))
              .invoices,
            'invoice'
          )
      );

      // Build the inputs the PURE exported reconcile() expects. The refund
      // heuristic is computed on the canonical txn (matches the aggregator).
      const REFUND_TOKEN = /refund|revers|chargeback|charge-back/i;
      const txns: ReconTransaction[] = mapToCanonicalTransactions(rawTxns).map((c) => {
        const t = c.data;
        const is_refund_or_reversal =
          (typeof t.amountOut === 'number' && t.amountOut > 0) ||
          (typeof t.amountIn === 'number' && t.amountIn < 0) ||
          (typeof t.description === 'string' && REFUND_TOKEN.test(t.description));
        return { ...t, is_refund_or_reversal };
      });
      const invoices: InvoiceLite[] = invoiceRows.map((i) => ({
        invoiceid: num(i, 'id'),
        status: str(i, 'status'),
        total: str(i, 'total'),
        balance: str(i, 'balance'),
        date: str(i, 'date'),
        datepaid: str(i, 'datepaid'),
      }));

      // The exported, pure reconciliation analysis.
      const matching = reconcile(txns, invoices);

      // Flag discrepancies: unmatched transactions, duplicate-risk groups, and
      // unpaid invoices with a recent payment. Annotate the affected client.
      const invoiceClient = new Map<number, number | undefined>();
      for (const i of invoiceRows) {
        const id = num(i, 'id');
        if (id !== undefined) invoiceClient.set(id, num(i, 'userid') ?? num(i, 'clientid'));
      }

      interface Discrepancy {
        kind: string;
        invoiceid: number | null;
        clientid: number | undefined;
        detail: string;
      }
      const discrepancies: Discrepancy[] = [];
      for (const d of matching.duplicate_risk) {
        discrepancies.push({
          kind: 'duplicate_risk',
          invoiceid: d.invoiceId,
          clientid: d.invoiceId !== null ? invoiceClient.get(d.invoiceId) : undefined,
          detail: `Duplicate-risk: amount ${String(d.amount)} across transactions ${d.transaction_row_ids.join(', ')}.`,
        });
      }
      for (const u of matching.unpaid_with_recent_payment) {
        discrepancies.push({
          kind: 'unpaid_with_recent_payment',
          invoiceid: u.invoiceId,
          clientid: invoiceClient.get(u.invoiceId),
          detail: `Invoice ${u.invoiceId} is ${u.status} but has a recent payment (transactions ${u.transaction_row_ids.join(', ')}).`,
        });
      }

      const close_summary = {
        window_days: windowDays,
        matched_count: matching.matched.length,
        unmatched_transaction_count: matching.unmatched_transaction_ids.length,
        duplicate_risk_groups: matching.duplicate_risk.length,
        unpaid_with_recent_payment: matching.unpaid_with_recent_payment.length,
        total_flagged: discrepancies.length,
      };

      const flagged = discrepancies.slice(0, limit);
      progress.setTotal(flagged.length);
      for (const d of flagged) {
        progress.step(`flag ${d.kind}`);
        const candidate: Record<string, unknown> = {
          kind: d.kind,
          invoiceid: d.invoiceid,
          clientid: d.clientid,
          detail: d.detail,
          drafted_intent_id: null as string | null,
        };
        if (d.clientid !== undefined) {
          const id = draftOrSkip(
            {
              auth_token: authToken,
              scope: 'client_note:write',
              params: {
                userid: d.clientid,
                note: `Month-end close audit annotation (${d.kind}): ${d.detail}`,
              },
              naturalKey: `close_note:${d.clientid}:${d.kind}:${String(d.invoiceid)}`,
              projected_effect: `Annotate client ${d.clientid} with a month-end close discrepancy note.`,
              preconditions: { invoiceid: d.invoiceid, kind: d.kind },
            },
            { clientid: d.clientid, invoiceid: d.invoiceid, kind: 'client_note:write' },
            result.drafted_intent_ids,
            result.skipped
          );
          candidate.drafted_intent_id = id;
        } else {
          // No resolvable client ⇒ recommend for human action (not drafted).
          result.skipped.push({
            ref: { invoiceid: d.invoiceid, kind: d.kind },
            reason: 'no resolvable clientid for annotation; recommend for human action',
          });
        }
        result.candidates.push(candidate);
      }

      progress.finish();
      return out({ ...result, close_summary });
    }
  );
}
