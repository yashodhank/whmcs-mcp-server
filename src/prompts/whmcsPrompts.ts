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
}
