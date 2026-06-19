/**
 * WHMCS 8.13 ↔ 9.x compatibility notes.
 * Exposed as a static MCP resource at whmcs://docs/compat-9x.
 *
 * Read-only MCP: reads are unaffected by 9.x write-side changes; this
 * document records the compatibility concerns so future write tooling
 * (not built in this engagement) and reconciliation consumers behave
 * correctly across versions. Verified facts vs assumptions are marked.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '../logging.js';
import { stripAuthFromUri } from '../security.js';

export const WHMCS_COMPAT_9X = `
# WHMCS 8.13 ↔ 9.x Compatibility

> Scope: this MCP is **read-heavy with a sealed-by-default governed
> write-flow**. All read tools/aggregators work on both branches. The items
> below apply to the governed write scopes (sealed by default in production)
> and to reconciliation consumers.

## Verified facts

- **WHMCS 8.13** is the LTS branch (support until **2026-05-31**). PHP 8.3 is
  only safe **after** upgrading WHMCS first.
- **WHMCS 9.0** is the current GA branch and introduces:
  - **Immutable non-draft invoices** — once an invoice leaves draft it cannot
    be edited; corrections happen via **credit/debit notes**.
  - **Credit / debit notes** as first-class billing entities.
- \`GetClientsDetails\` documents top-level client fields as **deprecated**;
  parse defensively from both the root and nested \`client\` / \`client.stats\`
  (this server already does — see canonical client mapper).
- \`GetInvoices\` supports server-side \`orderby\`/\`order\` (used by this server).
- \`GetTickets\` ordering is **not documented** — this server sorts tickets
  client-side by \`lastreply\`/\`date\`. Do not assume server ordering.

## Assumptions (require production verification)

- 9.x preserves the read action shapes this server's canonical mappers expect.
  The capability registry stays \`unverified\` for actions not allowlisted; a
  small read-only probe must confirm before promotion.
- Exact credit/debit-note read action names on 9.x are unverified here.

## Impact on this server

- **Reads / Account-360 / billing / renewals / support / activity**: unaffected.
- **Reconciliation**: on 9.x, full reconciliation must also account for
  credit/debit notes. \`get_reconciliation_snapshot\` currently summarises
  invoices and reports transactions as a capability-gated unavailable section;
  credit/debit-note inclusion is a 9.x follow-up gated the same way.
- **Governed write-flow (sealed by default)**: the controlled write-flow and
  workflow tools draft governed intents; production execution is sealed by
  default. On 9.x, write paths must treat non-draft invoices as immutable and
  issue credit/debit notes instead of editing invoices.

## Guidance

- Treat WHMCS version + any unverified action as **unverified** until a
  read-only probe confirms it. Never fake support. Prefer \`get_capability_matrix\`
  for the machine-readable status.
`;

/**
 * Register the WHMCS 8.13/9.x compatibility notes as an MCP resource.
 */
export function registerCompat9xResource(
  server: McpServer,
  logger: Logger
): void {
  logger.info('Registering WHMCS 8.13/9.x compatibility resource');

   
  server.resource(
    'compat-9x',
    'whmcs://docs/compat-9x',
    (uri) => {
      logger.debug('Fetching compat-9x resource');
      return {
        contents: [
          {
            uri: stripAuthFromUri(uri),
            mimeType: 'text/markdown',
            text: WHMCS_COMPAT_9X.trim(),
          },
        ],
      };
    }
  );
}
