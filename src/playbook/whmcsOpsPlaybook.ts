/**
 * WHMCS Ops Playbook
 *
 * Behavioral guidance for Grok / staff agents. Exposed at whmcs://docs/ops-playbook.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '../logging.js';
import { stripAuthFromUri } from '../security.js';

export const WHMCS_OPS_PLAYBOOK = `
# WHMCS Operations Playbook (Grok / staff)

This MCP talks to WHMCS **8.13.7**. Prefer jobs over raw tools. Do not invent
OAuth, WhatsApp, or Admin API impersonation.

## First tools

1. \`ops_ask\` — staff shift jobs (\`morning_digest\`, \`overdue_digest\`,
   \`ticket_inbox\`, \`next_best_action\`, \`billing_card\`, \`close_pack\`,
   \`system_health\`, \`draft_work\`, \`gdpr_export_pack\`). Audience comes from
   the staff allow-list, never from the prompt.
2. \`mcp_doctor\` — version, OIDC, API role, OAuth RS, **Grok write posture**.
3. List tools for reports: \`list_invoices\`, \`list_services\`,
   \`list_client_tickets\`, \`get_ticket_thread\`.

Customer-door jobs stay link/handoff until a user-delegated API is proven.
Do not present a WHMCS token as the MCP Bearer. No \`ValidateLogin\`, no
passwords in chat, no \`CreateOAuthCredential\`.

## Reporting

- Revenue / paid clients: \`list_invoices\` \`status=Paid\` + datepaid range.
- Unpaid / overdue: \`list_invoices\` \`status=Unpaid|Overdue\`.
- Paying MRR: \`list_services\` \`status=Active\` \`paying_only=true\`.
- Tickets: \`list_client_tickets\` + \`get_ticket_thread\`. Staff inbox is
  \`ops_ask\` \`ticket_inbox\` (do **not** use GetTickets+clientid alone).

## Writes (governed only)

Use \`draft_write_intent\` → \`validate_write_intent\` → \`approve_write_intent\`
→ \`execute_write_intent\` (or one-call \`write\` for low/medium). Legacy
direct tools (\`create_client\`, \`accept_order\`, \`mark_invoice_paid\`,
\`capture_payment\`, \`suspend_service\`, …) are **retired**.

### Order accept (Grok-safe)

\`order:accept\` sends \`autosetup=false\` and \`sendemail=false\` unless you
explicitly pass \`true\`. Default = accept without ModuleCreate / Welcome Email.

### Package / product / CFs

- \`service:product:set\` \`{serviceid, pid}\` — set local product id.
- \`service:change_package\` \`{serviceid}\` — push current product to the module
  (cannot pick a package by itself).
- \`service:customfields:update\` \`{serviceid, customfields:{fieldId:value}}\`
  — service CFs including a packageId field.
- \`service:upgrade\` — billed UpgradeProduct (high-risk, distinct approver).

### Ticket merge

\`ticket:merge\` maps to WHMCS \`MergeTicket\`. Needs API role \`mergeticket\`.
Do not assume the production role has it — check \`mcp_doctor\`.

### Owner transfer / invoice reassign

\`service:transfer_owner\` and \`billing:invoice:reassign\` need
\`MCP_WHMCS_DB_*\` (direct DB). High-risk + distinct approver. No grant-only fix.

## Still sealed (do not unseal from chat)

- \`service:terminate\` / ModuleTerminate
- Domain transfer / release
- \`client:contact:delete\` / DeleteClient
- High-risk money: distinct **other** approver, not the drafter

Operator backups live **outside git** (local secret dir / env backups). Never
commit \`.env.production\` or consumer tokens.

## Support notes

- Client-visible reply vs \`AdminNote\`.
- Escalate money / delete / terminate to a human.

## Anti-patterns

- Do not guess \`clientid\` when a user has several clients.
- Do not run staff jobs as a customer principal.
- Do not log tokens, PANs, or raw ticket bodies.
- Do not treat WhatsApp number as identity.
`;

export function registerPlaybookResource(server: McpServer, logger: Logger): void {
  logger.info('Registering WHMCS Ops Playbook resource');

  server.resource('ops-playbook', 'whmcs://docs/ops-playbook', (uri) => {
    logger.debug('Fetching ops-playbook resource');

    return {
      contents: [
        {
          uri: stripAuthFromUri(uri),
          mimeType: 'text/markdown',
          text: WHMCS_OPS_PLAYBOOK.trim(),
        },
      ],
    };
  });
}
