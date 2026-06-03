/**
 * Argument completions for WHMCS resource-template URI variables (MCP
 * `completion/complete`, spec 2025-11-25).
 *
 * Each factory returns a `CompleteResourceTemplateCallback`:
 *   (value: string, context?: { arguments?: Record<string,string> }) =>
 *     string[] | Promise<string[]>
 * matching the SDK 1.29 `ResourceTemplate({ complete: { <var>: cb } })` shape.
 *
 * Governance rules baked in (per task brief):
 *  - BOUNDED: client-id completion caps WHMCS results at COMPLETION_LIMIT (10)
 *    and only fires once the user has typed a prefix — never an unbounded dump.
 *  - ALLOWLISTED reads only: GetClients (already in READ_ALLOWLIST). Goes
 *    through whmcsClient.read(), which calls assertReadAction().
 *  - NO PII leak: suggestions are bare numeric ids (labels would carry
 *    name/email). Enum vars return the small known closed set.
 *  - CLIENT-MODE allowlist respected: in client access mode the client-id
 *    completion returns only the configured MCP_ALLOWED_CLIENT_IDS (filtered by
 *    the typed prefix); it never queries WHMCS for ids outside scope.
 */

import type { WhmcsClient } from '../whmcs/WhmcsClient.js';
import type { Logger } from '../logging.js';
import type { CompleteResourceTemplateCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { isClientMode } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';

/** Hard cap on completion suggestions — keeps the list bounded. */
export const COMPLETION_LIMIT = 10;

/**
 * Closed enum sets. WHMCS service/domain statuses and the few ticket/invoice
 * statuses worth autosuggesting. These never hit WHMCS — pure local constants,
 * so they leak nothing and cost nothing.
 */
export const SERVICE_STATUSES = [
  'Active',
  'Pending',
  'Suspended',
  'Terminated',
  'Cancelled',
  'Fraud',
  'Completed',
] as const;

export const DOMAIN_STATUSES = [
  'Active',
  'Pending',
  'Pending Registration',
  'Pending Transfer',
  'Expired',
  'Cancelled',
  'Fraud',
  'Transferred Away',
] as const;

/** Case-insensitive prefix filter + bound. */
function filterBounded(values: readonly string[], value: string): string[] {
  const q = value.trim().toLowerCase();
  const matched = q
    ? values.filter((v) => v.toLowerCase().startsWith(q))
    : values.slice();
  return matched.slice(0, COMPLETION_LIMIT);
}

/**
 * Completion for an enum-ish variable (status, etc): returns the bounded,
 * prefix-filtered known set. Pure-local, no WHMCS call.
 */
export function makeEnumCompletion(
  values: readonly string[]
): CompleteResourceTemplateCallback {
  return (value: string) => filterBounded(values, value);
}

/**
 * Completion for `{clientid}`.
 *
 * - Empty input → []  (never dump the whole client base).
 * - Client access mode → only the in-scope allowlisted ids whose string form
 *   starts with the typed prefix. No WHMCS call.
 * - Admin mode → GetClients search (ALLOWLISTED) capped at COMPLETION_LIMIT;
 *   returns bare ids only (no name/email PII).
 *
 * Any read error degrades to [] (completions are best-effort UX, never fatal).
 */
export function makeClientIdCompletion(
  whmcsClient: WhmcsClient,
  logger: Logger
): CompleteResourceTemplateCallback {
  return async (value: string): Promise<string[]> => {
    const q = value.trim();
    if (q.length === 0) return [];

    // Client-mode: never query WHMCS for ids outside the configured scope.
    if (isClientMode()) {
      const allowed = config.MCP_ALLOWED_CLIENT_IDS.map(String);
      return filterBounded(allowed, q);
    }

    try {
      const result = await whmcsClient.read<{
        clients?: { client?: { id: number }[] };
      }>('GetClients', { search: q, limitstart: 0, limitnum: COMPLETION_LIMIT });

      const clients = normalizeToArray<{ id: number }>(result.clients?.client);
      return clients
        .map((c) => c.id)
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, COMPLETION_LIMIT)
        .map(String);
    } catch (error) {
      logger.child().debug('clientid completion failed (degraded to empty)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
}
