/**
 * WHMCS MCP Prompts — reusable ops playbooks
 *
 * Each prompt is a workflow blueprint: it returns a single user-role message
 * that walks an agent through the RELEVANT existing read/write tools (by name).
 * Prompts never call tools themselves — they guide the agent that consumes them.
 *
 * SDK target (@modelcontextprotocol/sdk@1.29.0):
 *   server.registerPrompt<Args extends PromptArgsRawShape>(
 *     name: string,
 *     config: { title?: string; description?: string; argsSchema?: Args },
 *     cb: (args, extra) => GetPromptResult,
 *   )
 * where argsSchema is a zod *raw shape* (a plain object of ZodType values) and
 * the callback returns { messages: [{ role, content: { type:'text', text } }] }.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Build the standard single user-message GetPromptResult from a text body. */
function userMessage(text: string): {
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
} {
  return {
    messages: [{ role: 'user', content: { type: 'text', text: text.trim() } }],
  };
}

/** Render an optional clientid into a human scope hint. */
function scopeHint(clientid?: string): string {
  return clientid && clientid.trim().length > 0
    ? `Scope: client ${clientid.trim()}.`
    : 'Scope: all clients (no clientid supplied — operate portfolio-wide).';
}

/**
 * Register all WHMCS ops-playbook prompts on the given server.
 * Wired by index.ts alongside register*Tools / registerResources.
 */
export function registerWhmcsPrompts(server: McpServer): void {
  // ============================================================
  // 1. month_end_reconciliation
  // ============================================================
  server.registerPrompt(
    'month_end_reconciliation',
    {
      title: 'Month-end reconciliation',
      description:
        'Reconcile invoices against transactions for the period and flag mismatches.',
      argsSchema: {
        clientid: z
          .string()
          .optional()
          .describe('Optional WHMCS client id to scope the reconciliation.'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are performing a month-end reconciliation. ${scopeHint(clientid)}

Follow this workflow, one step at a time, citing the tool you used at each step:

1. Call \`get_reconciliation_snapshot\`${clientid ? ` for client ${clientid}` : ''} to get the
   composite invoice-vs-transaction view. Note any flagged discrepancies it already surfaces.
2. Call \`get_accounts_receivable_aging\` to capture outstanding balances by aging bucket
   (current / 30 / 60 / 90+). Record totals per bucket.
3. Call \`list_invoices\` (use \`status\`, \`datepaid_from\`/\`datepaid_to\` and a sufficient
   \`scan_limit\`; if \`complete_scan=false\`, raise \`scan_limit\` and rerun). For client scope
   prefer \`list_client_invoices\`.
4. Reconcile each invoice against its recorded transaction(s): Paid invoice total must equal
   the sum of its transaction amount_in. Flag:
     - Paid invoices with no / short transaction (under-recorded receipt),
     - transactions with no matching invoice,
     - balance != total - amount_in.
5. Produce a reconciliation report: matched count, mismatch list (invoice id, expected,
   actual, delta), and AR aging summary. Do NOT mutate anything — this is read-only.
`)
  );

  // ============================================================
  // 2. phantom_tds_sweep
  // ============================================================
  server.registerPrompt(
    'phantom_tds_sweep',
    {
      title: 'Phantom / inverse-phantom TDS sweep',
      description:
        'Bank-only sweep: detect Paid-but-no-arrival (phantom) and unpaid-but-arrived (inverse-phantom) invoices.',
      argsSchema: {
        clientid: z
          .string()
          .optional()
          .describe('Optional WHMCS client id to scope the sweep.'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are running a bank-only phantom / inverse-phantom receipt sweep. ${scopeHint(clientid)}

Rule: consider ONLY real bank / 26AS arrivals as evidence of money received. Never treat a
cash entry or a WHMCS status flag alone as proof of arrival.

Workflow:

1. Call \`get_reconciliation_snapshot\`${clientid ? ` for client ${clientid}` : ''} to get the
   invoice<->transaction mapping and status.
2. Call \`list_client_transactions\` to pull the actual recorded bank transactions (gateway,
   date, amount_in). Treat these (matched to bank/26AS) as ground truth for arrivals.
3. PHANTOM (overstated receipts): list every invoice marked \`Paid\` that has NO matching
   bank arrival in the transaction set — money was never received.
4. INVERSE-PHANTOM (overstated receivables): list every \`Unpaid\`/\`Overdue\` invoice that
   DOES have a real bank arrival matching its amount — money arrived but the invoice was
   never reconciled.
5. Report both lists separately (invoice id, amount, expected vs observed arrival). Read-only;
   recommend corrective draft_write_intent steps but do not execute them here.
`)
  );

  // ============================================================
  // 3. suspend_for_nonpayment
  // ============================================================
  server.registerPrompt(
    'suspend_for_nonpayment',
    {
      title: 'Suspend services for non-payment',
      description:
        'Identify 90+ day overdue accounts and draft a governed service:suspend write intent (never direct).',
      argsSchema: {
        clientid: z
          .string()
          .describe('WHMCS client id to evaluate for suspension (required).'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are evaluating client ${clientid} for suspension due to non-payment.

GOVERNANCE — this is a mutation. You MUST NOT call \`suspend_service\` directly. All writes
flow through the tiered governance pipeline: draft -> validate -> approve -> execute.

Workflow:

1. Call \`get_accounts_receivable_aging\` for client ${clientid}. Identify invoices in the
   90+ days overdue bucket. If there is NO 90+ overdue balance, STOP and report no action.
2. For each qualifying service, confirm the overdue invoice is genuinely unpaid (cross-check
   via the reconciliation tools) and that no related open billing-dispute ticket exists.
3. Draft the suspension via \`draft_write_intent\` with the \`service:suspend\` scope and the
   target service id and a reason referencing the 90+ overdue invoice(s). Do NOT skip this.
4. Validate the intent (\`validate_write_intent\`), then surface it for human approval
   (\`approve_write_intent\`); execution (\`execute_write_intent\`) only after approval.
5. Report: the drafted intent id(s), the overdue evidence, and that execution awaits approval.
   Prefer suspension over termination — it is reversible.
`)
  );

  // ============================================================
  // 4. new_client_onboarding
  // ============================================================
  server.registerPrompt(
    'new_client_onboarding',
    {
      title: 'New client onboarding review',
      description:
        'Pull the 360 view of a newly created client and run an onboarding checklist.',
      argsSchema: {
        clientid: z.string().describe('WHMCS client id to onboard (required).'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are running the onboarding review for client ${clientid}.

Workflow:

1. Call \`get_account_360\` for client ${clientid} to load the consolidated account view
   (profile, services, invoices, domains, tickets, risk).
2. Walk this onboarding checklist against the 360 result and mark each pass/fail/NA:
   - Contact details present and email valid.
   - At least one active product/service provisioned.
   - First invoice generated; payment method on file or invoice paid.
   - Any domain registered/transferred is active with correct expiry.
   - No immediate risk flags (fraud / chargeback / duplicate account).
   - Welcome / support channel established (no unanswered onboarding ticket).
3. Report the checklist with evidence per item and a short list of follow-ups. Read-only.
`)
  );

  // ============================================================
  // 5. domain_renewal_review
  // ============================================================
  server.registerPrompt(
    'domain_renewal_review',
    {
      title: 'Domain renewal review',
      description:
        'Surface domains expiring within 30 days and their renewal cost.',
      argsSchema: {
        clientid: z
          .string()
          .optional()
          .describe('Optional WHMCS client id to scope the renewal review.'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are reviewing upcoming domain renewals. ${scopeHint(clientid)}

Workflow:

1. Call \`get_domain_portfolio_snapshot\`${clientid ? ` for client ${clientid}` : ''} to load
   the domain portfolio with expiry dates and status.
2. Filter to domains expiring within the next 30 days (expiry <= today + 30d). For client
   scope you may cross-check with \`list_client_domains\`.
3. For each expiring domain capture: domain name, expiry date, days remaining, auto-renew
   on/off, and renewal cost.
4. Report a prioritized renewal list (soonest expiry first) with total renewal cost and any
   domains lacking auto-renew that need attention. Read-only — do not call \`renew_domain\`;
   recommend renewals for human action.
`)
  );

  // ============================================================
  // 6. dunning_sweep
  // ============================================================
  server.registerPrompt(
    'dunning_sweep',
    {
      title: 'Dunning sweep (draft-only AR follow-up)',
      description:
        'Find overdue accounts and DRAFT a per-client dunning action (reminder note, optional goodwill credit) — never mutates.',
      argsSchema: {
        clientid: z
          .string()
          .optional()
          .describe('Optional WHMCS client id to scope the dunning sweep.'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are running a dunning sweep over overdue accounts. ${scopeHint(clientid)}

GOVERNANCE — any follow-up here is a mutation. You MUST NOT mutate directly; every proposed
change MUST be routed through \`draft_write_intent\`. This workflow STOPS at the draft —
execution is OUT OF SCOPE. Production is sealed by default, so you must not assume any draft
will be executed. Do not approve or execute any drafted intent here.

Workflow, one step at a time, citing the tool you used at each step:

1. Call \`get_accounts_receivable_aging\`${clientid ? ` for client ${clientid}` : ''} to identify
   clients carrying a 30+ / 60+ / 90+ days overdue balance. Record the oldest bucket per client.
2. For EACH overdue client, call \`get_billing_snapshot\` to confirm the current unpaid/overdue
   total and capture the overdue invoice id(s).
3. For that same client, call \`get_support_snapshot\` — if an OPEN billing-dispute ticket
   exists, SKIP the nudge and FLAG the client for human review (do NOT draft anything).
4. For each remaining overdue client, DRAFT a dunning action via \`draft_write_intent\`:
   - a reminder note with scope \`client_note:write\` (LOW risk) referencing the overdue
     invoice id(s) and the oldest aging bucket; and
   - OPTIONALLY, where policy allows goodwill, a \`billing:credit:add\` DRAFT. This is HIGH
     risk and sealed in production by default: it only ever proceeds through the full
     validate -> human approval -> execute ceremony with caps. This prompt STOPS at the
     draft; do not run that ceremony here.

STRUCTURED OUTPUT:
  (a) an AR summary by bucket (current / 30 / 60 / 90+ totals);
  (b) a per-client table of \`{clientid, overdue_total, oldest_bucket, dispute_open?,
      drafted_intent_ids[]}\`;
  (c) a "next actions" list.
Read-only except for the governed drafts above.
`)
  );

  // ============================================================
  // 7. renewal_risk_triage
  // ============================================================
  server.registerPrompt(
    'renewal_risk_triage',
    {
      title: 'Renewal risk triage (draft-only)',
      description:
        'Rank upcoming service+domain renewals by churn risk and DRAFT reminder tickets for at-risk ones — never auto-renews.',
      argsSchema: {
        clientid: z
          .string()
          .optional()
          .describe('Optional WHMCS client id to scope the renewal triage.'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are triaging upcoming renewals by churn risk. ${scopeHint(clientid)}

GOVERNANCE — NEVER auto-renew and NEVER charge. The ONLY proposed mutation is a
\`ticket:create\` DRAFT routed through \`draft_write_intent\`. This workflow STOPS at the
draft; do not approve or execute any intent. Renewals themselves are recommended for human
action, never drafted. Do NOT draft any renewal/charge scope (registrar renew, service
upgrade, or any billing write) — those are HIGH-risk money actions and out of scope.

Workflow, one step at a time, citing the tool you used at each step:

1. Call \`get_renewal_snapshot\`${clientid ? ` for client ${clientid}` : ''} to load upcoming
   service + domain renewals in the window (default next 30 days; you may widen it). Capture
   \`{client, item, type, due/expiry date, days_remaining, auto_renew?, amount}\`.
2. For each client with an upcoming renewal, call \`get_risk_snapshot\` and capture risk
   signals. Classify a renewal as \`at_risk\` if risk flags exist OR auto-renew is off.
3. For \`at_risk\` clients, call \`get_billing_snapshot\` to confirm whether a payment method
   or recent paid invoice exists (a missing one raises the priority).
4. For each \`at_risk\` renewal, DRAFT a reminder ticket via \`draft_write_intent\` with scope
   \`ticket:create\` (LOW risk), the subject/body referencing the item and due date. Dedup:
   one ticket per client per renewal window.

STRUCTURED OUTPUT:
  (a) a ranked table \`{clientid, item, type, days_remaining, auto_renew, risk_flags,
      payment_on_file?, priority, drafted_ticket_intent_id}\`, sorted soonest-expiry-first
      then by risk;
  (b) a "recommend for human action" list of renewals (not drafted — renewals stay a human
      decision).
`)
  );

  // ============================================================
  // 8. ticket_triage_to_resolution
  // ============================================================
  server.registerPrompt(
    'ticket_triage_to_resolution',
    {
      title: 'Ticket triage to resolution (draft-only)',
      description:
        'Triage the open-ticket queue, read each thread + account context, and DRAFT a reply/note/status change — never executes.',
      argsSchema: {
        clientid: z
          .string()
          .optional()
          .describe(
            'Optional WHMCS client id to scope the ticket queue to one client.',
          ),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are triaging the open-ticket queue toward resolution. ${scopeHint(clientid)}

GOVERNANCE — you MUST NOT mutate directly; every change MUST be routed through
\`draft_write_intent\`. This workflow STOPS at the draft — do not approve or execute any
intent. Customer-visible replies are HUMAN-GATED: follow the ops-playbook escalation pattern
and draft a customer reply only after a human has reviewed it; prefer an internal note for
anything sensitive.

Workflow, one step at a time, citing the tool you used at each step:

1. Call \`get_support_snapshot\`${clientid ? ` for client ${clientid}` : ''} to list OPEN /
   customer-awaiting tickets${clientid ? '' : ' across the portfolio'}. For each capture
   \`{ticketid, subject, dept, status, lastreply}\`.
2. For each open ticket, call \`get_ticket_thread\` (by ticket id) to read the full thread —
   initial message + replies + internal notes — and understand the ask.
3. For the ticket's client, call \`get_account_360\` to pull context (services / invoices /
   risk) that should inform the response.
4. Decide and DRAFT, via \`draft_write_intent\`, the SMALLEST appropriate action:
   - an internal \`ticket:note\` (LOW) summarizing findings for a human; and/or
   - a \`ticket:reply\` (LOW) DRAFTED for human review — per the escalation pattern, draft as
     an internal/AdminNote first; a customer-visible reply is sent only after human approval;
     and/or
   - a \`ticket:status\` change (MEDIUM). Confirm this MEDIUM draft INLINE via the write-flow's
     own Elicitation (\`elicitInput\`) confirm — do NOT invent a free-text "are you sure"
     step; rely on the write-flow's elicit prompt.

STRUCTURED OUTPUT:
  a per-ticket table \`{ticketid, subject, proposed_action, scope, risk, drafted_intent_id,
  needs_human_review?}\`, plus a short triage summary (counts by proposed action).
`)
  );

  // ============================================================
  // 9. month_end_close
  // ============================================================
  server.registerPrompt(
    'month_end_close',
    {
      title: 'Month-end close (with-drafts)',
      description:
        'Full month-end CLOSE: reconcile + AR-age + revenue + export, then DRAFT a client_note annotation per flagged discrepancy — never executes.',
      argsSchema: {
        clientid: z
          .string()
          .optional()
          .describe('Optional WHMCS client id to scope the close.'),
      },
    },
    ({ clientid }) =>
      userMessage(`
You are running the WITH-DRAFTS month-end close. ${scopeHint(clientid)}

This is the close that leaves an audit trail. For a quick, no-write review use the read-only
\`month_end_reconciliation\` prompt instead — this prompt extends it with a revenue view, an
export artifact, and a DRAFTED audit annotation per discrepancy.

GOVERNANCE — the ONLY proposed mutation is a \`client_note:write\` DRAFT annotation, routed
through \`draft_write_intent\`. This workflow STOPS at the draft — do not approve or execute
any intent. NEVER draft any billing/money scope: ledger corrections are recommended for human
action, never drafted; the close only ANNOTATES.

Workflow, one step at a time, citing the tool you used at each step:

1. Call \`get_reconciliation_snapshot\`${clientid ? ` for client ${clientid}` : ''} to get the
   invoice<->transaction view; capture flagged discrepancies
   \`{invoice_id, expected, actual, delta, clientid}\`.
2. Call \`get_accounts_receivable_aging\` to capture AR totals per bucket (current / 30 / 60 /
   90+).
3. Call \`get_revenue_report\` to capture the period revenue for the close summary.
4. Call \`get_reconciliation_export\` to produce the exportable reconciliation dataset — this
   export is the artifact to file in the finance record.
5. For EACH flagged discrepancy, DRAFT an audit annotation via \`draft_write_intent\` with
   scope \`client_note:write\` (LOW), the note body citing the invoice id, expected vs actual,
   and the delta.

STRUCTURED OUTPUT:
  (a) close summary — matched count, total flagged, AR by bucket, period revenue, export
      reference;
  (b) a discrepancy table \`{invoice_id, clientid, expected, actual, delta,
      drafted_note_intent_id}\`;
  (c) a "recommend for human action" corrections list (ledger corrections stay a human
      decision — not drafted).
`)
  );
}
