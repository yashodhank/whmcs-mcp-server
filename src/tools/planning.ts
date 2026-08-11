import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, isToolAllowed, resolveWhmcsApiEndpoint } from '../config.js';
import { CAPABILITY_REGISTRY, probeCapability } from '../governance/capabilities.js';
import {
  fingerprintCapabilityEvidenceTarget,
  listCapabilityEvidence,
} from '../governance/capabilityEvidence.js';
import {
  consumerWriteCapability,
  consumerWriteScopes,
  resolveConsumer,
} from '../governance/consumers.js';
import { getConsumerRegistry, getProjectionEnv } from '../governance/pipeline.js';
import { resolveDefaultConsumerAuthToken } from '../auth/defaultConsumerToken.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { AUTH_SHAPE, ensureToolAuth } from '../security.js';
import { OperationCatalog } from '../catalog/registry.js';
import {
  PLANNING_CATALOG_VERSION,
  planningOperationDescriptors,
} from '../catalog/packs/planningOperations.js';
import type { OperationDefinition } from '../catalog/types.js';
import { compileOperationPlan, verifyCompiledPlan } from '../planning/compiler.js';
import { candidatePlanSchema, compiledPlanOutputShape, planIRSchema } from '../planning/schema.js';
import {
  DEFAULT_PLANNING_LIMITS,
  type AuthenticatedPlanningContext,
  type CandidatePlanStep,
  type CompiledPlanStep,
  type PlanIssue,
  type PlanIR,
} from '../planning/types.js';
import { fingerprintPlanningPolicy } from '../planning/policyFingerprint.js';
import { validatePlanValueSafety } from '../planning/validator.js';
import { draftWorkflowIntent } from './writeFlow.js';
import { WRITE_SCOPES, type WriteScope } from '../write/types.js';
import type { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { validateDraftParams } from '../write/validation.js';

const PREFLIGHT_OPERATION_ALLOWLIST = new Set([
  'capabilities.matrix.read',
  'billing.ar_aging.read',
]);

function out(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function fail(error: string, details: Record<string, unknown> = {}) {
  return { ...out({ isError: true, error, ...details }), isError: true };
}

function planningContext(
  authToken: string | undefined,
  catalog: OperationCatalog
): { ok: true; context: AuthenticatedPlanningContext } | { ok: false; reason: string } {
  const effectiveAuthToken = authToken ?? resolveDefaultConsumerAuthToken();
  const resolution = resolveConsumer(effectiveAuthToken, getProjectionEnv(), getConsumerRegistry(), {
    allowAnon: false,
  });
  if (!resolution.ok) return { ok: false, reason: `consumer denied: ${resolution.reason}` };
  const profile = resolution.profile;
  const allowedCapabilityIds = new Set(profile.allowedActions);
  const allowedWriteScopes = new Set(consumerWriteScopes(profile));
  const allowedContracts = new Set(profile.allowedContracts);
  const allowedClientIds =
    config.MCP_ACCESS_MODE === 'client' ? new Set(config.MCP_ALLOWED_CLIENT_IDS) : null;
  const writeCapability = consumerWriteCapability(profile);
  return {
    ok: true,
    context: {
      evidenceTarget: fingerprintCapabilityEvidenceTarget({
        installationIdentity: resolveWhmcsApiEndpoint(config.WHMCS_API_URL),
        configuration: {
          identifier: config.WHMCS_IDENTIFIER,
          accessMode: config.MCP_ACCESS_MODE,
          governanceEnabled: config.MCP_GOVERNANCE_ENABLED,
          toolAllowlist: [...config.MCP_TOOL_ALLOWLIST].sort(),
        },
        catalogVersion: catalog.version,
      }),
      policyFingerprint: fingerprintPlanningPolicy({
        consumerId: profile.id,
        allowedCapabilityIds,
        allowedWriteScopes,
        allowedContracts,
        allowedClientIds,
        writeCapability,
      }),
      allowedCapabilityIds,
      allowedWriteScopes,
      allowedContracts,
      allowedClientIds,
      writeCapability,
    },
  };
}

function operationVisible(
  definition: OperationDefinition,
  context: AuthenticatedPlanningContext
): boolean {
  if (!isToolAllowed(definition.publicName)) return false;
  if (
    (definition.effects === 'draft' || definition.effects === 'write') &&
    (definition.governance.scope === null ||
      !context.allowedWriteScopes.has(definition.governance.scope))
  ) {
    return false;
  }
  if (!definition.auth.consumerFiltered) return true;
  return definition.whmcsActions.every((action) => {
    if (!Object.hasOwn(CAPABILITY_REGISTRY, action)) return false;
    return context.allowedCapabilityIds.has(CAPABILITY_REGISTRY[action].capability);
  });
}

function materializeInputs(
  inputs: PlanIR['steps'][number]['inputs']
): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};
  for (const [key, input] of Object.entries(inputs)) {
    if (input.kind === 'slot') return null;
    values[key] = input.value;
  }
  return values;
}

function planningIssue(path: string, reason: string, safeRepair: string): PlanIssue {
  return { severity: 'error', path, reason, safe_repair: safeRepair };
}

function requestCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function referencedClientIds(args: Readonly<Record<string, unknown>>): readonly number[] {
  const sources = [args];
  if (args.params !== null && typeof args.params === 'object' && !Array.isArray(args.params)) {
    sources.push(args.params as Record<string, unknown>);
  }
  const ids: number[] = [];
  for (const source of sources) {
    for (const key of ['clientid', 'userid', 'source_clientid', 'dest_clientid']) {
      const value = source[key];
      if (typeof value === 'number' && Number.isSafeInteger(value)) ids.push(value);
      else if (typeof value === 'string' && /^\d+$/.test(value)) ids.push(Number(value));
    }
  }
  return ids;
}

function currentPlanContextIssues(
  plan: PlanIR,
  catalog: OperationCatalog,
  context: AuthenticatedPlanningContext
): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const step of plan.steps) {
    const definition = catalog.getById(step.operation_id);
    if (definition === undefined || !operationVisible(definition, context)) {
      issues.push(
        planningIssue(
          `${step.id}.operation_id`,
          'Operation is no longer visible to the current transport-authenticated consumer.',
          'Refresh the filtered catalog and recompile.'
        )
      );
      continue;
    }
    if (step.effect !== definition.effects || step.risk_tier !== definition.riskTier) {
      issues.push(
        planningIssue(
          `${step.id}.effect`,
          'Compiled effect/risk no longer matches server-owned catalog metadata.',
          'Recompile through compile_operation_plan.'
        )
      );
    }
    for (const action of definition.whmcsActions) {
      if (!Object.hasOwn(CAPABILITY_REGISTRY, action)) {
        issues.push(
          planningIssue(
            `${step.id}.operation_id`,
            `Catalog action '${action}' is not declared in the capability registry.`,
            'Repair the server-owned descriptor before using this operation.'
          )
        );
      }
    }
    if (step.data_contract !== undefined && !context.allowedContracts.has(step.data_contract)) {
      issues.push(
        planningIssue(
          `${step.id}.data_contract`,
          'The current consumer no longer permits this data contract.',
          'Recompile in the current transport-authenticated context.'
        )
      );
    }
    if (
      step.consumer_requirement !== undefined &&
      !context.allowedCapabilityIds.has(step.consumer_requirement) &&
      !context.allowedWriteScopes.has(step.consumer_requirement)
    ) {
      issues.push(
        planningIssue(
          `${step.id}.consumer_requirement`,
          'The current consumer no longer satisfies this requirement.',
          'Recompile in the current transport-authenticated context.'
        )
      );
    }
    const args = materializeInputs(step.inputs);
    if (
      args !== null &&
      context.allowedClientIds !== null &&
      referencedClientIds(args).some((clientId) => !context.allowedClientIds?.has(clientId))
    ) {
      issues.push(
        planningIssue(
          `${step.id}.inputs`,
          'Plan references a client outside the current process allowlist.',
          'Use an allowed client target and recompile.'
        )
      );
    }
  }
  return issues;
}

async function runSafePreflightStep(
  step: CandidatePlanStep | CompiledPlanStep,
  catalog: OperationCatalog,
  context: AuthenticatedPlanningContext,
  whmcs: WhmcsClient | undefined,
  signal: AbortSignal,
  nowMs: number
): Promise<{ checks: readonly Record<string, unknown>[]; blockers: readonly PlanIssue[] }> {
  if (requestCancelled(signal)) {
    return {
      checks: [],
      blockers: [planningIssue(step.id, 'Preflight was cancelled.', 'Retry if still needed.')],
    };
  }
  if (!PREFLIGHT_OPERATION_ALLOWLIST.has(step.operation_id)) {
    return {
      checks: [],
      blockers: [
        planningIssue(
          step.id,
          'Operation is not eligible for planner preflight.',
          'Use an explicitly allowlisted pure or bounded safe-read preflight operation.'
        ),
      ],
    };
  }
  const definition = catalog.getById(step.operation_id);
  const args = materializeInputs(step.inputs);
  if (definition === undefined || args === null || !operationVisible(definition, context)) {
    return {
      checks: [],
      blockers: [
        planningIssue(
          step.id,
          'Preflight operation is unresolved or no longer granted.',
          'Resolve slots, refresh the filtered catalog, and recompile.'
        ),
      ],
    };
  }
  if (step.operation_id === 'capabilities.matrix.read') {
    return {
      checks: [
        { step_id: step.id, operation_id: step.operation_id, status: 'available', source: 'local' },
      ],
      blockers: [],
    };
  }
  if (definition.effects !== 'read' || whmcs === undefined) {
    return {
      checks: [],
      blockers: [
        planningIssue(
          step.id,
          'Bounded safe-read preflight is unavailable.',
          'Retry with the WHMCS read boundary available.'
        ),
      ],
    };
  }
  const safeParams: Record<string, unknown> = {};
  if (typeof args.clientid === 'number') safeParams.clientid = args.clientid;
  const checks: Record<string, unknown>[] = [];
  const blockers: PlanIssue[] = [];
  for (const action of definition.whmcsActions) {
    if (!Object.hasOwn(CAPABILITY_REGISTRY, action)) {
      blockers.push(
        planningIssue(
          step.id,
          `Catalog action '${action}' is not declared in the capability registry.`,
          'Repair the server-owned descriptor before preflight.'
        )
      );
      continue;
    }
    if (requestCancelled(signal)) {
      blockers.push(planningIssue(step.id, 'Preflight was cancelled.', 'Retry if still needed.'));
      break;
    }
    let status: Awaited<ReturnType<typeof probeCapability>>;
    try {
      status = await probeCapability(
        action,
        {
          read: async (safeAction, safeProbeParams) => {
            if (requestCancelled(signal))
              throw signal.reason ?? new Error('Planner preflight request cancelled');
            return whmcs.read(safeAction, safeProbeParams, { signal });
          },
          isAllowlisted: (safeAction) => Object.hasOwn(CAPABILITY_REGISTRY, safeAction),
          target: context.evidenceTarget,
          now: () => nowMs,
          signal,
        },
        safeParams
      );
    } catch (error) {
      if (!requestCancelled(signal)) throw error;
      blockers.push(planningIssue(step.id, 'Preflight was cancelled.', 'Retry if still needed.'));
      break;
    }
    if (requestCancelled(signal)) {
      blockers.push(planningIssue(step.id, 'Preflight was cancelled.', 'Retry if still needed.'));
      break;
    }
    checks.push({
      step_id: step.id,
      operation_id: step.operation_id,
      action,
      status: status.status,
    });
  }
  return { checks, blockers };
}

function registeredTool(
  server: McpServer,
  catalog: OperationCatalog,
  logger: Logger,
  rl: RateLimiter,
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  outputSchema: z.ZodRawShape,
  handler: ToolCallback<z.ZodRawShape>
): void {
  if (!isToolAllowed(name)) return;
  server.registerTool(
    name,
    {
      description,
      inputSchema: { ...inputSchema, ...AUTH_SHAPE },
      outputSchema,
      annotations: {
        readOnlyHint: name !== 'draft_operation_plan',
        destructiveHint: false,
        idempotentHint: name !== 'draft_operation_plan',
        openWorldHint: true,
      },
    },
    (async (params, extra) => {
      const authError = ensureToolAuth(params);
      if (authError) return authError;
      if (!rl.tryConsume()) return fail(new RateLimitError().message);
      try {
        return await handler(params, extra);
      } catch (error) {
        logger.error('Planning tool failed', {
          tool: name,
          error: error instanceof Error ? error.message : String(error),
        });
        return fail(error instanceof Error ? error.message : String(error));
      }
    }) as ToolCallback<z.ZodRawShape>
  );
  void catalog;
}

/** Register non-executing planning tools and return the expanded effective catalog. */
export function registerPlanningTools(
  server: McpServer,
  baseCatalog: OperationCatalog,
  logger: Logger,
  rl: RateLimiter,
  whmcs?: WhmcsClient
): OperationCatalog {
  const catalog = new OperationCatalog(
    [...baseCatalog.definitions(), ...planningOperationDescriptors()],
    PLANNING_CATALOG_VERSION,
    config.MCP_MAX_PAGE_SIZE
  );

  registeredTool(
    server,
    catalog,
    logger,
    rl,
    'inspect_operation_catalog',
    'Return the transport-consumer-filtered operation catalog used by the deterministic planner.',
    {
      domain: z.string().optional(),
      effect: z.enum(['pure', 'read', 'draft', 'write']).optional(),
    },
    {
      catalog_version: z.number(),
      operations: z.array(z.record(z.string(), z.unknown())),
      executable: z.literal(false),
    },
    ((params) => {
      const resolved = planningContext(params.auth_token as string | undefined, catalog);
      if (!resolved.ok) return fail(resolved.reason);
      const operations = catalog
        .machineView()
        .operations.filter((definition) => {
          const stored = catalog.getById(definition.id);
          return stored !== undefined && operationVisible(stored, resolved.context);
        })
        .filter((definition) => params.domain === undefined || definition.domain === params.domain)
        .filter((definition) => params.effect === undefined || definition.effects === params.effect)
        .map((definition) => {
          const stored = catalog.getById(definition.id);
          if (stored === undefined) throw new Error('Immutable catalog definition disappeared');
          const { auth_token: _authToken, ...clientInputs } = stored.inputSchema;
          void _authToken;
          return {
            ...definition,
            input_schema: z.toJSONSchema(z.object(clientInputs).strict()),
          };
        });
      return out({ catalog_version: catalog.version, operations, executable: false });
    }) as ToolCallback<z.ZodRawShape>
  );

  registeredTool(
    server,
    catalog,
    logger,
    rl,
    'compile_operation_plan',
    'Deterministically validate and compile a structured candidate into non-executable PlanIR. No WHMCS calls.',
    { candidate: candidatePlanSchema, ttl_ms: z.number().int().positive().optional() },
    compiledPlanOutputShape,
    ((params) => {
      const resolved = planningContext(params.auth_token as string | undefined, catalog);
      if (!resolved.ok) return fail(resolved.reason);
      const result = compileOperationPlan({
        candidate: params.candidate,
        context: resolved.context,
        catalog,
        evidence: listCapabilityEvidence(resolved.context.evidenceTarget),
        limits: DEFAULT_PLANNING_LIMITS,
        nowMs: Date.now(),
        ttlMs: typeof params.ttl_ms === 'number' ? params.ttl_ms : 120_000,
      });
      return out({
        ...result,
        executable: false,
        ...(result.accepted ? { plan_hash: result.plan.plan_hash } : {}),
      });
    }) as ToolCallback<z.ZodRawShape>
  );

  registeredTool(
    server,
    catalog,
    logger,
    rl,
    'preflight_operation_plan',
    'Run only explicitly allowlisted pure/safe-read checks from an unexpired compiled PlanIR. Never writes.',
    { plan: planIRSchema.optional(), candidate: candidatePlanSchema.optional() },
    {
      executable: z.literal(false),
      plan_hash: z.string(),
      checks: z.array(z.record(z.string(), z.unknown())),
      blockers: z.array(z.record(z.string(), z.unknown())),
      plan: z.record(z.string(), z.unknown()).optional(),
    },
    (async (params, extra) => {
      const resolved = planningContext(params.auth_token as string | undefined, catalog);
      if (!resolved.ok) return fail(resolved.reason);
      const nowMs = Date.now();
      if ((params.plan === undefined) === (params.candidate === undefined)) {
        return fail('Provide exactly one of plan or candidate.');
      }
      if (params.candidate !== undefined) {
        const initial = compileOperationPlan({
          candidate: params.candidate,
          context: resolved.context,
          catalog,
          evidence: listCapabilityEvidence(resolved.context.evidenceTarget, nowMs),
          limits: DEFAULT_PLANNING_LIMITS,
          nowMs,
          ttlMs: 120_000,
        });
        const nonEvidenceBlockers = initial.issues.filter(
          (item) =>
            item.severity === 'error' &&
            !item.reason.startsWith('Fresh supported capability evidence is required')
        );
        const checks: Record<string, unknown>[] = [];
        if (nonEvidenceBlockers.length === 0) {
          const candidate = candidatePlanSchema.parse(params.candidate);
          for (const step of candidate.steps) {
            const definition = catalog.getById(step.operation_id);
            if (
              (definition?.effects !== 'read' && definition?.effects !== 'pure') ||
              !PREFLIGHT_OPERATION_ALLOWLIST.has(step.operation_id)
            ) {
              continue;
            }
            const result = await runSafePreflightStep(
              step,
              catalog,
              resolved.context,
              whmcs,
              extra.signal,
              nowMs
            );
            checks.push(...result.checks);
            nonEvidenceBlockers.push(...result.blockers);
            if (extra.signal.aborted) break;
          }
        }
        const compiled = compileOperationPlan({
          candidate: params.candidate,
          context: resolved.context,
          catalog,
          evidence: listCapabilityEvidence(resolved.context.evidenceTarget, nowMs),
          limits: DEFAULT_PLANNING_LIMITS,
          nowMs,
          ttlMs: 120_000,
        });
        const blockers = compiled.accepted
          ? nonEvidenceBlockers
          : [...nonEvidenceBlockers, ...compiled.issues];
        return out({
          executable: false,
          plan_hash: compiled.accepted ? compiled.plan.plan_hash : 'uncompiled',
          checks,
          blockers,
          ...(compiled.accepted ? { plan: compiled.plan } : {}),
        });
      }
      const plan = params.plan as PlanIR;
      const blockers = [
        ...verifyCompiledPlan(plan, catalog.version, nowMs, resolved.context.policyFingerprint),
        ...currentPlanContextIssues(plan, catalog, resolved.context),
        ...validatePlanValueSafety(plan, 'plan'),
      ];
      if (
        plan.provenance.installation_id !== resolved.context.evidenceTarget.installationId ||
        plan.provenance.configuration_fingerprint !==
          resolved.context.evidenceTarget.configFingerprint
      ) {
        blockers.push({
          severity: 'error',
          path: 'provenance',
          reason: 'Plan target/configuration does not match this request.',
          safe_repair: 'Compile again in the current authenticated transport context.',
        });
      }
      const checks: Record<string, unknown>[] = [];
      if (blockers.length === 0) {
        for (const step of plan.steps) {
          if (step.effect !== 'pure' && step.effect !== 'read') continue;
          const result = await runSafePreflightStep(
            step,
            catalog,
            resolved.context,
            whmcs,
            extra.signal,
            nowMs
          );
          checks.push(...result.checks);
          blockers.push(...result.blockers);
          if (extra.signal.aborted) break;
        }
      }
      return out({ executable: false, plan_hash: plan.plan_hash, checks, blockers });
    }) as ToolCallback<z.ZodRawShape>
  );

  registeredTool(
    server,
    catalog,
    logger,
    rl,
    'draft_operation_plan',
    'Convert eligible draft/write steps in unexpired PlanIR into existing governed draft intents only. Never validates, approves, executes, or mutates.',
    { plan: planIRSchema },
    {
      executable: z.literal(false),
      executed: z.literal(false),
      partial: z.boolean(),
      plan_hash: z.string(),
      drafts: z.array(z.record(z.string(), z.unknown())),
      blockers: z.array(z.record(z.string(), z.unknown())),
    },
    ((params, extra) => {
      const resolved = planningContext(params.auth_token as string | undefined, catalog);
      if (!resolved.ok) return fail(resolved.reason);
      const plan = params.plan as PlanIR;
      const blockers = [
        ...verifyCompiledPlan(
          plan,
          catalog.version,
          Date.now(),
          resolved.context.policyFingerprint
        ),
        ...currentPlanContextIssues(plan, catalog, resolved.context),
        ...validatePlanValueSafety(plan, 'plan'),
      ];
      if (plan.execution_mode !== 'draft_only') {
        blockers.push({
          severity: 'error',
          path: 'execution_mode',
          reason: 'Drafting requires draft_only mode.',
          safe_repair: 'Recompile explicitly in draft_only mode.',
        });
      }
      if (
        plan.provenance.installation_id !== resolved.context.evidenceTarget.installationId ||
        plan.provenance.configuration_fingerprint !==
          resolved.context.evidenceTarget.configFingerprint
      ) {
        blockers.push({
          severity: 'error',
          path: 'provenance',
          reason: 'Plan target/configuration does not match this request.',
          safe_repair: 'Recompile in the current authenticated context.',
        });
      }
      const candidates: { stepId: string; scope: WriteScope; args: Record<string, unknown> }[] = [];
      if (
        resolved.context.writeCapability === 'false' ||
        resolved.context.writeCapability === 'disabled'
      ) {
        blockers.push({
          severity: 'error',
          path: 'consumer',
          reason: 'Current transport-authenticated consumer cannot create drafts.',
          safe_repair: 'Use analysis/read-only mode or obtain a draft-capable consumer grant.',
        });
      }
      if (extra.signal.aborted) {
        blockers.push(
          planningIssue(
            'request',
            'Draft creation was cancelled before dispatch.',
            'Retry explicitly if governed draft creation is still desired.'
          )
        );
      }
      for (const step of plan.steps) {
        if (step.effect !== 'draft' && step.effect !== 'write') continue;
        const definition = catalog.getById(step.operation_id);
        const materializedArgs = materializeInputs(step.inputs);
        const scope = definition?.governance.scope;
        if (
          definition === undefined ||
          materializedArgs === null ||
          scope === null ||
          scope === undefined ||
          !WRITE_SCOPES.includes(scope as WriteScope)
        ) {
          blockers.push({
            severity: 'error',
            path: step.id,
            reason: 'Draft step is unresolved or has no known governed scope.',
            safe_repair: 'Use a catalog draft operation with resolved inputs.',
          });
          continue;
        }
        const schemaResult = z.object(definition.inputSchema).strict().safeParse(materializedArgs);
        if (!schemaResult.success) {
          blockers.push({
            severity: 'error',
            path: `${step.id}.inputs`,
            reason: 'Draft inputs no longer satisfy the strict server-owned catalog schema.',
            safe_repair: 'Recompile from a schema-valid candidate.',
          });
          continue;
        }
        const args = schemaResult.data;
        if (!resolved.context.allowedWriteScopes.has(scope)) {
          blockers.push({
            severity: 'error',
            path: step.id,
            reason: 'Write scope denied by the current transport-authenticated consumer.',
            safe_repair: 'Remove the write or obtain an explicit grant.',
          });
          continue;
        }
        if (
          step.data_contract !== undefined &&
          !resolved.context.allowedContracts.has(step.data_contract)
        ) {
          blockers.push({
            severity: 'error',
            path: `${step.id}.data_contract`,
            reason: 'The current consumer no longer permits this data contract.',
            safe_repair: 'Recompile in the current transport-authenticated context.',
          });
          continue;
        }
        if (
          step.consumer_requirement !== undefined &&
          !resolved.context.allowedCapabilityIds.has(step.consumer_requirement) &&
          !resolved.context.allowedWriteScopes.has(step.consumer_requirement)
        ) {
          blockers.push({
            severity: 'error',
            path: `${step.id}.consumer_requirement`,
            reason: 'The current consumer no longer satisfies this requirement.',
            safe_repair: 'Recompile in the current transport-authenticated context.',
          });
          continue;
        }
        if (
          typeof args.natural_key !== 'string' ||
          typeof args.projected_effect !== 'string' ||
          args.params === null ||
          typeof args.params !== 'object' ||
          Array.isArray(args.params)
        ) {
          blockers.push({
            severity: 'error',
            path: `${step.id}.inputs`,
            reason: 'Draft inputs are malformed.',
            safe_repair: 'Provide natural_key, projected_effect, and object params.',
          });
          continue;
        }
        const paramValidation = validateDraftParams(
          scope as WriteScope,
          args.params as Record<string, unknown>,
          args.preconditions !== null &&
            typeof args.preconditions === 'object' &&
            !Array.isArray(args.preconditions)
            ? (args.preconditions as Record<string, unknown>)
            : {}
        );
        const paramErrors = paramValidation.issues.filter((item) => item.severity === 'error');
        if (paramErrors.length > 0) {
          blockers.push({
            severity: 'error',
            path: `${step.id}.inputs.params`,
            reason: 'Draft params no longer satisfy the controlled-write validator.',
            safe_repair: paramErrors.map((item) => item.message).join('; '),
          });
          continue;
        }
        if (resolved.context.allowedClientIds !== null) {
          const clientRefs = ['clientid', 'userid', 'source_clientid', 'dest_clientid']
            .map((key) => (args.params as Record<string, unknown>)[key])
            .filter((value): value is number => typeof value === 'number');
          if (clientRefs.some((clientId) => !resolved.context.allowedClientIds?.has(clientId))) {
            blockers.push({
              severity: 'error',
              path: `${step.id}.inputs.params`,
              reason: 'Draft params reference a client outside the process allowlist.',
              safe_repair: 'Use an allowed client target and recompile.',
            });
            continue;
          }
        }
        candidates.push({ stepId: step.id, scope: scope as WriteScope, args });
      }
      if (blockers.length > 0)
        return out({
          executable: false,
          executed: false,
          partial: false,
          plan_hash: plan.plan_hash,
          drafts: [],
          blockers,
        });
      const drafts: Record<string, unknown>[] = [];
      for (const { stepId, scope, args } of candidates) {
        if (extra.signal.aborted) {
          blockers.push(
            planningIssue(
              stepId,
              'Draft creation was cancelled; no later plan steps were dispatched.',
              'Review any earlier draft ids, then retry remaining steps explicitly if needed.'
            )
          );
          break;
        }
        let result: ReturnType<typeof draftWorkflowIntent>;
        try {
          result = draftWorkflowIntent({
            auth_token: params.auth_token as string | undefined,
            scope,
            params: args.params as Record<string, unknown>,
            naturalKey: args.natural_key as string,
            projected_effect: args.projected_effect as string,
            preconditions: args.preconditions as Record<string, unknown> | undefined,
          });
        } catch {
          result = { ok: false, reason: 'draft creation failed' };
        }
        drafts.push({ step_id: stepId, ...result });
        if (!result.ok) {
          blockers.push(
            planningIssue(
              stepId,
              `Governed draft creation was denied: ${result.reason}`,
              'Review the current consumer/scope grant; already-created drafts remain drafts only.'
            )
          );
          break;
        }
      }
      const successfulDrafts = drafts.filter((item) => item.ok === true).length;
      return out({
        executable: false,
        executed: false,
        partial: blockers.length > 0 && successfulDrafts > 0,
        plan_hash: plan.plan_hash,
        drafts,
        blockers,
      });
    }) as ToolCallback<z.ZodRawShape>
  );

  return catalog;
}
