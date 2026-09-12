import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import { CAPABILITY_REGISTRY } from '../../governance/capabilities.js';
import { consumerWriteScopes, resolveConsumer } from '../../governance/consumers.js';
import { getConsumerRegistry, getProjectionEnv } from '../../governance/pipeline.js';
import { Logger } from '../../logging.js';
import { RateLimiter, RateLimitError } from '../../rateLimiter.js';
import { resolveStdioDefaultToken } from '../../auth/trustedStdioDefault.js';
import { AUTH_SHAPE, ensureToolAuth } from '../../security.js';
import { READ_ONLY_ANNOTATIONS } from '../../tools/listTools.js';
import type { WhmcsClient } from '../../whmcs/WhmcsClient.js';
import { getWhmcsVersionProfile } from '../../whmcs/versionProfile.js';
import {
  buildAvailabilityMatrix,
  type ScopeAvailabilityEntry,
} from '../../write/actionAvailability.js';
import { WRITE_SCOPES } from '../../write/types.js';
import { OperationCatalog } from '../registry.js';
import type { OperationDefinition } from '../types.js';
import { PLANNING_CATALOG_VERSION, planningOperationDescriptors } from './planningOperations.js';

export const CAPABILITY_CATALOG_VERSION = 4;

/** Stable, additive output schema retained from the manual registrar. */
const CAPABILITY_MATRIX_OUTPUT_SHAPE = {
  whmcs_version: z
    .object({
      status: z.string(),
      family: z.string().optional(),
      version: z.string().nullable().optional(),
      release: z.string().nullable().optional(),
      probed_at: z.string().optional(),
      note: z.string().optional(),
    })
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
  write_scope_availability_summary: z
    .object({
      total: z.number(),
      executable: z.number(),
      missing_api: z.number(),
      version_gated: z.number(),
      needs_infra: z.number(),
      non_executable_scopes: z.array(z.string()),
    })
    .optional(),
  consumer: z.string().optional(),
  contract: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
} as const;

const DESCRIPTION =
  'Read-only machine-readable capability + WHMCS-version status matrix (supported/unverified/unsupported per action). Pure; calls no WHMCS API. WHMCS version is reported unverified until prod-probed.';

function createCapabilityMatrixHandler(
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): ToolCallback<z.ZodRawShape> {
  const name = 'get_capability_matrix';
  return (async (params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;
      log.logToolCall(name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const versionProfile = await getWhmcsVersionProfile(whmcs);
      const capabilities = Object.values(CAPABILITY_REGISTRY).map((capability) => ({
        action: capability.action,
        capability: capability.capability,
        status: capability.status,
        note: capability.note,
      }));

      const allScopes = new Set<string>(WRITE_SCOPES);
      const availabilityMatrix = buildAvailabilityMatrix(allScopes, versionProfile.family);
      const nonExecutable = availabilityMatrix.filter((e) => !e.executable);

      const payload = {
        whmcs_version: {
          status:
            versionProfile.family === 'unknown' ? ('unverified' as const) : ('supported' as const),
          family: versionProfile.family,
          version: versionProfile.version,
          release: versionProfile.release,
          probed_at: versionProfile.probedAt,
        },
        capabilities,
        compat_9x: {
          immutable_non_draft_invoices: versionProfile.family === '9.x',
          credit_debit_notes: versionProfile.family === '9.x',
          note: 'WHMCS 9.0 GA: non-draft invoices are immutable; corrections via credit/debit notes. Reads unaffected. See whmcs://docs/compat-9x.',
        },
        write_scope_availability_summary: {
          total: availabilityMatrix.length,
          executable: availabilityMatrix.filter((e) => e.executable).length,
          missing_api: availabilityMatrix.filter((e) => e.availability === 'missing_api').length,
          version_gated: availabilityMatrix.filter((e) => e.availability === 'version_gated')
            .length,
          needs_infra: availabilityMatrix.filter((e) => e.availability === 'needs_infra').length,
          non_executable_scopes: nonExecutable.map((e) => e.scope),
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
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): OperationDefinition {
  return defineCapabilityMatrixOperation(createCapabilityMatrixHandler(whmcs, logger, rl));
}

/* ─────────── list_write_scope_availability ─────────────────────────────── */

const WRITE_SCOPE_AVAILABILITY_OUTPUT_SHAPE = {
  whmcs_version: z
    .object({
      family: z.string(),
      version: z.string().nullable(),
      release: z.string().nullable(),
      probed_at: z.string(),
    })
    .optional(),
  scopes: z
    .array(
      z.object({
        scope: z.string(),
        action: z.string(),
        risk: z.string(),
        api_surface: z.string(),
        whmcs_api_exists: z.boolean(),
        grant_status: z.string(),
        availability: z.string(),
        executable: z.boolean(),
        reason: z.string(),
        note: z.string(),
      })
    )
    .optional(),
  summary: z
    .object({
      total: z.number(),
      granted: z.number(),
      executable: z.number(),
      missing_api: z.number(),
      version_gated: z.number(),
      needs_infra: z.number(),
    })
    .optional(),
  isError: z.boolean().optional(),
  error: z.string().optional(),
} as const;

const WRITE_SCOPE_AVAILABILITY_DESCRIPTION =
  'Read-only listing of all declared write scopes with their dynamic availability ' +
  'on the current WHMCS install. Shows which granted scopes are actually executable, ' +
  'which are missing from the WHMCS API, which are version-gated, and which need ' +
  'infrastructure (DB DSN / custom executor). Never removes scopes from grants — ' +
  'informational only. Filters to consumer-granted scopes by default.';

function resolveCallerWriteScopes(params: Record<string, unknown>): ReadonlySet<string> {
  const callerToken = typeof params.auth_token === 'string' ? params.auth_token : undefined;
  const token = resolveStdioDefaultToken(config.MCP_TRANSPORT, callerToken) ?? callerToken;
  const resolution = resolveConsumer(token, getProjectionEnv(), getConsumerRegistry(), {
    allowAnon: true,
  });
  if (!resolution.ok) return new Set<string>();
  return new Set(consumerWriteScopes(resolution.profile));
}

function createWriteScopeAvailabilityHandler(
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): ToolCallback<z.ZodRawShape> {
  const name = 'list_write_scope_availability';
  return (async (params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;
      log.logToolCall(name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const showAll = params.show_all === true;
      const versionProfile = await getWhmcsVersionProfile(whmcs);
      const grantedScopes = resolveCallerWriteScopes(params);

      const allScopes = new Set<string>(WRITE_SCOPES);
      const matrix = buildAvailabilityMatrix(allScopes, versionProfile.family);
      const filtered: ScopeAvailabilityEntry[] = showAll
        ? [...matrix]
        : matrix
            .map((entry) => ({
              ...entry,
              grant_status: grantedScopes.has(entry.scope)
                ? ('granted' as const)
                : ('not_granted' as const),
            }))
            .filter((entry) => entry.grant_status === 'granted');

      const grantedMatrix = matrix.map((entry) => ({
        ...entry,
        grant_status: grantedScopes.has(entry.scope)
          ? ('granted' as const)
          : ('not_granted' as const),
      }));
      const finalEntries = showAll ? grantedMatrix : filtered;

      const summary = {
        total: finalEntries.length,
        granted: finalEntries.filter((e) => e.grant_status === 'granted').length,
        executable: finalEntries.filter((e) => e.executable).length,
        missing_api: finalEntries.filter((e) => e.availability === 'missing_api').length,
        version_gated: finalEntries.filter((e) => e.availability === 'version_gated').length,
        needs_infra: finalEntries.filter((e) => e.availability === 'needs_infra').length,
      };

      const payload = {
        whmcs_version: {
          family: versionProfile.family,
          version: versionProfile.version,
          release: versionProfile.release,
          probed_at: versionProfile.probedAt,
        },
        scopes: finalEntries,
        summary,
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

function defineWriteScopeAvailabilityOperation(
  handler: ToolCallback<z.ZodRawShape>
): OperationDefinition {
  return {
    id: 'capabilities.write_scope_availability.read',
    publicName: 'list_write_scope_availability',
    domain: 'capabilities',
    description: WRITE_SCOPE_AVAILABILITY_DESCRIPTION,
    inputSchema: {
      show_all: z
        .boolean()
        .optional()
        .describe(
          'When true, list all declared scopes (not just consumer-granted). Default false.'
        ),
      ...AUTH_SHAPE,
    },
    outputSchema: WRITE_SCOPE_AVAILABILITY_OUTPUT_SHAPE,
    annotations: { ...READ_ONLY_ANNOTATIONS },
    effects: 'pure',
    riskTier: 'none',
    whmcsActions: [],
    capability: { mode: 'none', probe: 'none' },
    governance: { scope: null, output: 'sanitized', rawWhmcsOutput: false },
    cache: { mode: 'none' },
    cost: { kind: 'constant', maxWhmcsCalls: 0, maxItems: 200 },
    auth: { toolAuthRequired: true, consumerFiltered: false },
    pagination: null,
    prerequisites: [],
    fallbacks: [],
    protocolFeatures: ['tools'],
    handler,
    version: 1,
  };
}

export function createWriteScopeAvailabilityDefinition(
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): OperationDefinition {
  return defineWriteScopeAvailabilityOperation(
    createWriteScopeAvailabilityHandler(whmcs, logger, rl)
  );
}

export function createCapabilityShellCatalog(
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): OperationCatalog {
  return new OperationCatalog(
    [
      createCapabilityMatrixDefinition(whmcs, logger, rl),
      createWriteScopeAvailabilityDefinition(whmcs, logger, rl),
    ],
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
    [
      defineCapabilityMatrixOperation(inertHandler),
      defineWriteScopeAvailabilityOperation(inertHandler),
      ...planningOperationDescriptors(),
    ],
    PLANNING_CATALOG_VERSION,
    globalMaxPageSize
  ).machineView();
}
