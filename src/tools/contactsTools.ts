/**
 * Track A/B — get_client_contacts governed read tool.
 *
 *  - get_client_contacts ← WHMCS `GetContacts` (params: clientid required;
 *    optional limit). Returns a client's contacts / sub-accounts.
 *
 * This is a CLIENT-SCOPED read (carries per-person PII), so in client-mode the
 * resolved clientid is checked with ensureClientAllowed before any WHMCS call.
 * It follows the standard governed-read pattern: READ_ONLY_ANNOTATIONS,
 * AUTH_SHAPE, RateLimiter, governance projection via the pipeline, listy
 * envelope via governedListResult. Capability status is `unverified` (not yet
 * prod-probed — see capabilities.ts); the tool still functions while unverified
 * (status is informational, exactly like the Track A infra reads).
 *
 * WHMCS `GetContacts` returns `contacts.contact` as an array OR a single object
 * and numeric/boolean strings — defensive parsing lives in the canonical mapper
 * (mapToCanonicalContact / mapToCanonicalContacts).
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import {
  ensureToolAuth,
  isClientMode,
  ensureClientAllowed,
  AUTH_SHAPE,
} from '../security.js';
import {
  READ_ONLY_ANNOTATIONS,
  LIST_TOOL_OUTPUT_SCHEMA,
} from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedListResult,
  governanceEnabled,
  type GovernedToolResult,
} from '../governance/pipeline.js';
import { asRecord, num, listOf } from '../canonical/_shared.js';
import {
  mapToCanonicalContact,
  mapToCanonicalContacts,
} from '../canonical/contact.js';

/**
 * Extract the raw per-contact source rows from a GetContacts response so the
 * governance pipeline can map+project each row freshly (mirrors the nesting
 * the canonical mapper unwraps: contacts.contact, with a flat `contact`
 * fallback). Tolerates array / single-object / empty shapes.
 */
function extractContactRows(root: Record<string, unknown>): unknown[] {
  const rows = listOf(root.contacts, 'contact');
  return rows.length === 0 ? listOf(root.contact, 'contact') : rows;
}

const TOOL_VERSION = 'v1';

/** Standard structured-error result for a recoverable read failure. */
function errorResult(message: string): GovernedToolResult {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ isError: true, error: message }) },
    ],
    isError: true,
  };
}

export function registerContactsTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  if (!isToolAllowed('get_client_contacts')) return;

  const schema = z.object({
    clientid: z
      .number()
      .int()
      .positive()
      .describe('WHMCS client id whose contacts/sub-accounts to list (required)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(config.MCP_MAX_PAGE_SIZE)
      .optional()
      .describe('Max contacts to return; defaults to the WHMCS page size'),
    contract: z
      .string()
      .optional()
      .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
  });

  const handler: ToolCallback<z.ZodRawShape> = (async (
    rawParams: Record<string, unknown>
  ) => {
    const params = rawParams as z.infer<typeof schema> & { auth_token?: string };
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authToken =
        typeof params.auth_token === 'string' ? params.auth_token : undefined;
      const requestedContract =
        typeof params.contract === 'string' ? params.contract : undefined;

      const authErr = ensureToolAuth(params as Record<string, unknown>);
      if (authErr) return authErr;

      const clientIdNum = num(params as Record<string, unknown>, 'clientid');
      if (clientIdNum === undefined) {
        return errorResult('clientid is required');
      }

      // Client-scoped PII read: in client-mode the caller may only read their
      // own client record.
      if (isClientMode()) {
        const denied = ensureClientAllowed(clientIdNum);
        if (denied) return denied;
      }

      log.logToolCall('get_client_contacts', params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const apiParams: Record<string, unknown> = { clientid: clientIdNum };
      if (params.limit !== undefined) {
        apiParams.limitnum = params.limit;
      }

      const resp = await whmcs.read<Record<string, unknown>>(
        'GetContacts',
        apiParams
      );
      const root = asRecord(resp);
      // Same nesting the canonical mapper unwraps (contacts.contact, with a
      // flat `contact` fallback); each raw row is mapped per-row downstream.
      const rows = extractContactRows(root);
      const items = mapToCanonicalContacts(resp).map((c) => c.data);

      const envelope = {
        total: num(root, 'totalresults') ?? items.length,
        count: num(root, 'numreturned') ?? items.length,
        offset: num(root, 'startnumber') ?? 0,
        limit: params.limit ?? items.length,
        note: 'Client contacts / sub-accounts (GetContacts). Per-person PII (name/email/phone/address) is visible to operator/portal contracts only; never to LLM contracts.',
      };

      log.logToolResult('get_client_contacts', true, Date.now() - t0);

      const legacy = { items, ...envelope };
      return applyGovernanceOrLegacy({
        enabled: governanceEnabled(),
        legacy,
        govern: () =>
          governedListResult({
            rows,
            mapItem: mapToCanonicalContact,
            envelope,
            authToken,
            requestedContract,
          }),
      });
    } catch (e) {
      log.logToolResult(
        'get_client_contacts',
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
        return errorResult((e as Error).message);
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    'get_client_contacts',
    {
      description: `List a WHMCS client's contacts / sub-accounts (read-only): name, email, phone, postal address, company, and sub-account permission flags. Version: ${TOOL_VERSION}`,
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      outputSchema: LIST_TOOL_OUTPUT_SCHEMA,
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}
