import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import { CAPABILITY_REGISTRY } from '../../governance/capabilities.js';
import { Logger } from '../../logging.js';
import { RateLimiter, RateLimitError } from '../../rateLimiter.js';
import { AUTH_SHAPE, ensureToolAuth } from '../../security.js';
import { READ_ONLY_ANNOTATIONS } from '../../tools/listTools.js';
import { OperationCatalog } from '../registry.js';
import type { OperationDefinition } from '../types.js';
import { PLANNING_CATALOG_VERSION, planningOperationDescriptors } from './planningOperations.js';

export const CAPABILITY_CATALOG_VERSION = 3;

/** Stable, additive output schema retained from the manual registrar. */
const CAPABILITY_MATRIX_OUTPUT_SHAPE = {
  whmcs_version: z.object({ status: z.string(), note: z.string().optional() }).optional(),
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

const DESCRIPTION =
  'Read-only machine-readable capability + WHMCS-version status matrix (supported/unverified/unsupported per action). Pure; calls no WHMCS API. WHMCS version is reported unverified until prod-probed.';

function createCapabilityMatrixHandler(
  logger: Logger,
  rl: RateLimiter
): ToolCallback<z.ZodRawShape> {
  const name = 'get_capability_matrix';
  return ((params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;
      log.logToolCall(name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const capabilities = Object.values(CAPABILITY_REGISTRY).map((capability) => ({
        action: capability.action,
        capability: capability.capability,
        status: capability.status,
        note: capability.note,
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
    } catch (error) {
      log.logToolResult(
        name,
        false,
        Date.now() - t0,
        error instanceof Error ? error.message : String(error)
      );
      if (error instanceof RateLimitError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ isError: true, error: error.message }),
            },
          ],
          isError: true,
        };
      }
      throw error;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;
}

function defineCapabilityMatrixOperation(
  handler: ToolCallback<z.ZodRawShape>
): OperationDefinition {
  return {
    id: 'capabilities.matrix.read',
    publicName: 'get_capability_matrix',
    domain: 'capabilities',
    description: DESCRIPTION,
    inputSchema: { ...AUTH_SHAPE },
    outputSchema: CAPABILITY_MATRIX_OUTPUT_SHAPE,
    annotations: { ...READ_ONLY_ANNOTATIONS },
    effects: 'pure',
    riskTier: 'none',
    whmcsActions: [],
    capability: { mode: 'none', probe: 'none' },
    governance: { scope: null, output: 'sanitized', rawWhmcsOutput: false },
    cache: { mode: 'none' },
    cost: { kind: 'constant', maxWhmcsCalls: 0, maxItems: 100 },
    auth: { toolAuthRequired: true, consumerFiltered: false },
    pagination: null,
    prerequisites: [],
    fallbacks: [],
    protocolFeatures: ['tools'],
    handler,
    version: 1,
  };
}

export function createCapabilityMatrixDefinition(
  logger: Logger,
  rl: RateLimiter
): OperationDefinition {
  return defineCapabilityMatrixOperation(createCapabilityMatrixHandler(logger, rl));
}

export function createCapabilityShellCatalog(logger: Logger, rl: RateLimiter): OperationCatalog {
  return new OperationCatalog(
    [createCapabilityMatrixDefinition(logger, rl)],
    CAPABILITY_CATALOG_VERSION,
    config.MCP_MAX_PAGE_SIZE
  );
}

/** Deterministic server-owned manifest used by CI; the inert handler is never registered. */
export function capabilityShellCatalogMachineView(globalMaxPageSize: number) {
  const inertHandler = (() => {
    throw new Error('Catalog manifest handler is not executable');
  }) as unknown as ToolCallback<z.ZodRawShape>;
  return new OperationCatalog(
    [defineCapabilityMatrixOperation(inertHandler), ...planningOperationDescriptors()],
    PLANNING_CATALOG_VERSION,
    globalMaxPageSize
  ).machineView();
}
