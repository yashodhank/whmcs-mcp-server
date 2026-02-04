/**
 * WHMCS Ops Playbook
 * 
 * Provides behavioral guidance for AI agents interacting with WHMCS.
 * Exposed as an MCP resource at whmcs://docs/ops-playbook
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '../logging.js';
import { ensureResourceAuth } from '../security.js';

/**
 * The WHMCS Operations Playbook content
 * This is injected into the LLM context to guide proper tool usage
 */
export const WHMCS_OPS_PLAYBOOK = `
# WHMCS Operations Playbook

This playbook provides guidelines for AI agents administering WHMCS installations.

## Core Principles

### 1. Search Before Creating
- **Always** use \`search_clients\` before \`create_client\` for the same email
- This prevents duplicate client accounts
- Use \`mode: 'reuse_if_exists'\` when appropriate

### 2. Fetch Before Modifying
- Always call \`get_invoice\` before any billing action
- Verify the current state matches expectations
- Check invoice status before \`mark_invoice_paid\` or \`record_refund\`

## Billing Operations

### Refunds
- Prefer \`record_refund\` with \`refund_type='Credit'\` for most disputes
- **Important**: This tool ONLY records refunds in WHMCS
- Gateway refunds (Stripe, PayPal) must be processed manually at the gateway
- Never refund more than the total paid amount

### Payment Capture
- Only use \`capture_payment\` when:
  - Invoice status is 'Unpaid'
  - Balance is greater than 0
  - User or admin has explicitly requested a charge
- Avoid repeated capture attempts on the same invoice

## Service Operations

### Suspension vs Termination
- **Prefer \`suspend_service\`** over \`terminate_service\` when in doubt
- Suspension is reversible; termination is permanent
- For overdue accounts, suspend first and escalate

### Termination Safety
- Requires explicit \`confirm: true\` parameter
- Check for unpaid invoices before terminating
- Consider open support tickets that may relate to billing disputes

## Support Operations

### Reply Types
- Use \`type: 'Client'\` for replies visible to the customer
- Use \`type: 'AdminNote'\` for internal notes (human review)
- Use \`type: 'AdminPublic'\` for admin replies visible to client

### Escalation Pattern
For sensitive operations:
1. Draft response as \`AdminNote\`
2. Request human review
3. Wait for approval before sending \`Client\` reply

## Dangerous Operations

### Large Transactions
- For invoices or refunds above normal thresholds:
  1. Add an \`AdminNote\` explaining the intended action
  2. Notify human administrator
  3. Wait for approval before executing

### Batch Operations
- Process one item at a time
- Verify success before proceeding to next
- Maintain an audit trail

## Error Recovery

### Rate Limit Exceeded
- Wait before retrying
- Consider reducing batch sizes
- Spread operations over time

### WHMCS Business Errors
- Log the error details
- Check if the resource state has changed
- Provide clear error message to user

## Anti-Patterns (What NOT to Do)

❌ Never bypass confirmation on \`terminate_service\`
❌ Never assume gateway refund when using \`record_refund\`
❌ Never create duplicate clients without checking first
❌ Never modify paid invoices without proper justification
❌ Never ignore rate limit warnings
`;

/**
 * Register the WHMCS Ops Playbook as an MCP resource
 */
export function registerPlaybookResource(
  server: McpServer,
  logger: Logger
): void {
  logger.info('Registering WHMCS Ops Playbook resource');

  // Register the playbook as a static resource
  server.resource(
    'ops-playbook',
    new ResourceTemplate('whmcs://docs/ops-playbook{?token,auth_token}', { list: undefined }),
    async (uri) => {
      logger.debug('Fetching ops-playbook resource');

      const authResult = ensureResourceAuth(uri);
      if (!authResult.ok) return authResult.response;
      
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: WHMCS_OPS_PLAYBOOK.trim(),
          }
        ],
      };
    }
  );
}
