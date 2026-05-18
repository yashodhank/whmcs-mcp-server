/**
 * Phase C — capability-shell read tools.
 *
 * These five WHMCS actions (GetTransactions/GetStats/GetUsers/GetToDoItems/
 * GetAutomationLog) are intentionally NOT in the read allowlist and are
 * B4-seeded `unverified`. Per docs/PHASE_B_GOVERNANCE.md §6 and the user
 * spec we register honest *capability shells*: schema-validated, governed
 * tools that consult the B4 capability registry and return a structured
 * `capability_unavailable` status. They NEVER call WHMCS, NEVER fake data,
 * and do NOT broadly expand READ_ALLOWLIST. When an action is later
 * deliberately allowlisted + prod-probed to `supported`, the shell can be
 * promoted to a real governed read without changing its public contract.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { ensureToolAuth, AUTH_SHAPE } from '../security.js';
import {
  getCapability,
  capabilityUnavailablePayload,
  CAPABILITY_REGISTRY,
} from '../governance/capabilities.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import type { Canonical } from '../governance/types.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governedListResult,
  governanceEnabled,
} from '../governance/pipeline.js';
import {
  mapToCanonicalTransaction,
  mapToCanonicalToDoItem,
  mapToCanonicalAutomationLogEntry,
  mapToCanonicalSystemStats,
} from '../canonical/index.js';

/**
 * Combined shell output schema: validates BOTH the capability_unavailable
 * shell payload AND a promoted tool's governed/legacy output (so the SDK
 * never strips fields once an action is promoted). All optional.
 */
const SHELL_OUTPUT_SHAPE = {
  capability_unavailable: z.literal(true).optional(),
  action: z.string().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
  capability: z.string().optional(),
  retriable: z.boolean().optional(),
  guidance: z.string().optional(),
  items: z.array(z.record(z.string(), z.unknown())).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  consumer: z.string().optional(),
  contract: z.string().optional(),
  entity: z.string().optional(),
  count: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  isError: z.boolean().optional(),
  error: z.string().optional(),
} as const;

/**
 * Stable, additive output schema for `get_capability_matrix`.
 *
 * Validates BOTH runtime modes without altering them:
 *  - ungoverned: `{ whmcs_version:{status,note}, capabilities:[...],
 *    compat_9x:{...} }`
 *  - governed: the same object wrapped under `data`, alongside optional
 *    `consumer`/`contract`. All wrapper keys are optional so a single shape
 *    validates governance ON and OFF.
 */
const CAPABILITY_MATRIX_OUTPUT_SHAPE = {
  whmcs_version: z
    .object({ status: z.string(), note: z.string().optional() })
    .optional(),
  capabilities: z
    .array(
      z.object({
        action: z.string(),
        capability: z.string().optional(),
        status: z.string(),
        note: z.string().optional(),
      })
    )
    .optional(),
  compat_9x: z.record(z.string(), z.unknown()).optional(),
  consumer: z.string().optional(),
  contract: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
} as const;

interface ShellSpec {
  /** MCP tool name. */
  name: string;
  /** WHMCS action it would call once verified/allowlisted. */
  action: string;
  /** Human-readable description. */
  description: string;
  /** Extra zod shape (forward-compatible with the eventual real tool). */
  extraSchema: z.ZodRawShape;
  /**
   * Phase H promotion wiring. A shell becomes a REAL governed read ONLY
   * when its capability is `supported` (deliberately allowlisted) AND a
   * canonicalMap is present; otherwise it stays a capability_unavailable
   * shell (e.g. list_users — no map → stays degraded/unverified).
   */
  kind?: 'list' | 'single';
  /** WHMCS response container key for `list` kind (e.g. 'transactions'). */
  normalizerPath?: string;
  /** Singular wrapper key for `list` kind (e.g. 'transaction'). */
  singular?: string;
  /** Per-row (list) / whole-response (single) canonical mapper. */
  canonicalMap?: (raw: unknown) => Canonical<unknown>;
}

const SHELLS: readonly ShellSpec[] = [
  {
    name: 'list_client_transactions',
    action: 'GetTransactions',
    description:
      "Read-only client payment transactions. WHMCS GetTransactions is not yet verified/allowlisted on this build — returns a structured capability status until prod-verified.",
    extraSchema: {
      clientid: z.number().int().positive().optional(),
      invoiceid: z.number().int().positive().optional(),
      transid: z.string().optional(),
      limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(25),
      offset: z.number().int().min(0).default(0),
    },
    kind: 'list',
    normalizerPath: 'transactions',
    singular: 'transaction',
    canonicalMap: mapToCanonicalTransaction,
  },
  {
    name: 'get_stats',
    action: 'GetStats',
    description:
      'Read-only system/income statistics. WHMCS GetStats is not yet verified/allowlisted — returns a structured capability status until prod-verified.',
    extraSchema: {},
    kind: 'single',
    canonicalMap: mapToCanonicalSystemStats,
  },
  {
    name: 'list_users',
    action: 'GetUsers',
    description:
      'Read-only user accounts (WHMCS 8+ User model). GetUsers is not yet verified/allowlisted — returns a structured capability status until prod-verified.',
    extraSchema: {
      search: z.string().optional(),
      limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(25),
      offset: z.number().int().min(0).default(0),
    },
  },
  {
    name: 'get_todo_items',
    action: 'GetToDoItems',
    description:
      'Read-only admin to-do items. GetToDoItems is not yet verified/allowlisted — returns a structured capability status until prod-verified.',
    extraSchema: {
      limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(25),
      offset: z.number().int().min(0).default(0),
    },
    kind: 'list',
    normalizerPath: 'todoitems',
    singular: 'todoitem',
    canonicalMap: mapToCanonicalToDoItem,
  },
  {
    name: 'get_automation_log',
    action: 'GetAutomationLog',
    description:
      'Read-only automation/cron log. GetAutomationLog is not yet verified/allowlisted — returns a structured capability status until prod-verified.',
    extraSchema: {
      date: z.string().optional(),
      limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(25),
      offset: z.number().int().min(0).default(0),
    },
    kind: 'list',
    normalizerPath: 'automationlog',
    singular: 'entry',
    canonicalMap: mapToCanonicalAutomationLogEntry,
  },
];

function registerShell(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter,
  spec: ShellSpec
): void {
  if (!isToolAllowed(spec.name)) return;
  const schema = z.object({ ...spec.extraSchema });

  const handler: ToolCallback<z.ZodRawShape> = (async (params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const pview = params;
      const authToken = typeof pview.auth_token === 'string' ? pview.auth_token : undefined;
      const requestedContract = typeof pview.contract === 'string' ? pview.contract : undefined;
      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;

      log.logToolCall(spec.name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const cap = getCapability(spec.action);

      // PROMOTED: capability verified+allowlisted AND a canonical mapper
      // exists ⇒ real governed read. Otherwise honest capability_unavailable
      // (e.g. list_users — no map, stays degraded; never fakes data).
      if (cap.status === 'supported' && spec.canonicalMap !== undefined) {
        const limit = typeof pview.limit === 'number' ? pview.limit : 25;
        const offset = typeof pview.offset === 'number' ? pview.offset : 0;
        const apiParams: Record<string, unknown> = {};
        for (const k of Object.keys(spec.extraSchema)) {
          if (pview[k] !== undefined && k !== 'limit' && k !== 'offset') apiParams[k] = pview[k];
        }
        if (spec.kind === 'list') {
          apiParams.limitnum = limit;
          apiParams.limitstart = offset;
        }
        const resp = await whmcs.read<Record<string, unknown>>(spec.action, apiParams);
        const cmap = spec.canonicalMap;
        const result =
          spec.kind === 'list'
            ? (() => {
                const container = resp[spec.normalizerPath ?? ''];
                const rows = normalizeToArray<unknown>(
                  container && typeof container === 'object'
                    ? ((container as Record<string, unknown>)[spec.singular ?? ''] ?? container)
                    : container
                );
                const legacy = { items: rows.map((r) => cmap(r).data), count: rows.length };
                return applyGovernanceOrLegacy({
                  enabled: governanceEnabled(),
                  legacy,
                  govern: () =>
                    governedListResult({
                      rows,
                      mapItem: cmap,
                      envelope: { count: rows.length, limit, offset },
                      authToken,
                      requestedContract,
                    }),
                });
              })()
            : applyGovernanceOrLegacy({
                enabled: governanceEnabled(),
                legacy: cmap(resp).data as Record<string, unknown>,
                govern: () =>
                  governedToolResult({ canonical: cmap(resp), authToken, requestedContract }),
              });
        log.logToolResult(spec.name, true, Date.now() - t0);
        return result;
      }

      // Honest capability gate: never call WHMCS, never fake data.
      const payload = capabilityUnavailablePayload(cap);
      log.logToolResult(spec.name, true, Date.now() - t0);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
        isError: true,
      };
    } catch (e) {
      log.logToolResult(
        spec.name,
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
    spec.name,
    {
      description: spec.description,
      inputSchema: {
        ...schema.shape,
        contract: z
          .string()
          .optional()
          .describe('Requested data contract (honoured only once the capability is verified and the consumer permits it)'),
        ...AUTH_SHAPE,
      },
      outputSchema: SHELL_OUTPUT_SHAPE,
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}

/**
 * Register the five Phase-C capability-shell read tools.
 */
/**
 * get_capability_matrix — machine-readable capability + version status.
 * Pure (no WHMCS call). Honest: WHMCS version is `unverified` (no
 * allowlisted version source probed); never fabricated.
 */
function registerCapabilityMatrixTool(
  server: McpServer,
  logger: Logger,
  rl: RateLimiter
): void {
  const name = 'get_capability_matrix';
  if (!isToolAllowed(name)) return;

  const handler: ToolCallback<z.ZodRawShape> = ((params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;
      log.logToolCall(name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const capabilities = Object.values(CAPABILITY_REGISTRY).map((c) => ({
        action: c.action,
        capability: c.capability,
        status: c.status,
        note: c.note,
      }));
      const payload = {
        whmcs_version: {
          status: 'unverified' as const,
          note: 'No allowlisted WHMCS version source is probed by this read-only build; version must be confirmed in production.',
        },
        capabilities,
        compat_9x: {
          immutable_non_draft_invoices: true,
          credit_debit_notes: true,
          note: 'WHMCS 9.0 GA: non-draft invoices are immutable; corrections via credit/debit notes. Reads unaffected. See whmcs://docs/compat-9x.',
        },
      };

      log.logToolResult(name, true, Date.now() - t0);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
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
      description:
        'Read-only machine-readable capability + WHMCS-version status matrix (supported/unverified/unsupported per action). Pure; calls no WHMCS API. WHMCS version is reported unverified until prod-probed.',
      inputSchema: { ...AUTH_SHAPE },
      outputSchema: CAPABILITY_MATRIX_OUTPUT_SHAPE,
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}

export function registerCapabilityShellTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  for (const spec of SHELLS) {
    registerShell(server, whmcs, logger, rl, spec);
  }
  registerCapabilityMatrixTool(server, logger, rl);
}
