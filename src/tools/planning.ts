import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, isToolAllowed, resolveWhmcsApiEndpoint } from '../config.js';
import { CAPABILITY_REGISTRY } from '../governance/capabilities.js';
import { probeCapability } from '../governance/capabilities.js';
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
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { AUTH_SHAPE, ensureToolAuth } from '../security.js';
import { OperationCatalog } from '../catalog/registry.js';
import { planningOperationDescriptors } from '../catalog/packs/planningOperations.js';
import type { OperationDefinition } from '../catalog/types.js';
import { compileOperationPlan, verifyCompiledPlan } from '../planning/compiler.js';
import { candidatePlanSchema, compiledPlanOutputShape, planIRSchema } from '../planning/schema.js';
import {
  DEFAULT_PLANNING_LIMITS,
  type AuthenticatedPlanningContext,
  type PlanIR,
} from '../planning/types.js';
import { draftWorkflowIntent } from './writeFlow.js';
import { WRITE_SCOPES, type WriteScope } from '../write/types.js';
import type { WhmcsClient } from '../whmcs/WhmcsClient.js';

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
  const resolution = resolveConsumer(authToken, getProjectionEnv(), getConsumerRegistry(), {
    allowAnon: false,
  });
  if (!resolution.ok) return { ok: false, reason: `consumer denied: ${resolution.reason}` };
  const profile = resolution.profile;
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
      allowedCapabilityIds: new Set(profile.allowedActions),
      allowedWriteScopes: new Set(consumerWriteScopes(profile)),
      allowedContracts: new Set(profile.allowedContracts),
      allowedClientIds:
        config.MCP_ACCESS_MODE === 'client' ? new Set(config.MCP_ALLOWED_CLIENT_IDS) : null,
      writeCapability: consumerWriteCapability(profile),
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
    const capability = CAPABILITY_REGISTRY[action]?.capability;
    return capability !== undefined && context.allowedCapabilityIds.has(capability);
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
    baseCatalog.version,
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
        .operations.filter((definition) =>
          operationVisible(catalog.getById(definition.id)!, resolved.context)
        )
        .filter((definition) => params.domain === undefined || definition.domain === params.domain)
        .filter(
          (definition) => params.effect === undefined || definition.effects === params.effect
        );
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
            if (extra.signal.aborted) {
              nonEvidenceBlockers.push({
                severity: 'error',
                path: step.id,
                reason: 'Preflight was cancelled.',
                safe_repair: 'Retry if still needed.',
              });
              break;
            }
            const definition = catalog.getById(step.operation_id);
            const args = materializeInputs(step.inputs);
            if (
              definition === undefined ||
              definition.effects !== 'read' ||
              !PREFLIGHT_OPERATION_ALLOWLIST.has(step.operation_id) ||
              args === null ||
              whmcs === undefined
            ) {
              continue;
            }
            const safeParams: Record<string, unknown> = {};
            if (typeof args.clientid === 'number') safeParams.clientid = args.clientid;
            for (const action of definition.whmcsActions) {
              const status = await probeCapability(
                action,
                {
                  read: (safeAction, safeProbeParams) => whmcs.read(safeAction, safeProbeParams),
                  isAllowlisted: (safeAction) => Object.hasOwn(CAPABILITY_REGISTRY, safeAction),
                  target: resolved.context.evidenceTarget,
                  now: () => nowMs,
                },
                safeParams
              );
              checks.push({
                step_id: step.id,
                operation_id: step.operation_id,
                action,
                status: status.status,
              });
            }
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
        const blockers = compiled.accepted ? nonEvidenceBlockers : compiled.issues;
        return out({
          executable: false,
          plan_hash: compiled.accepted ? compiled.plan.plan_hash : 'uncompiled',
          checks,
          blockers,
          ...(compiled.accepted ? { plan: compiled.plan } : {}),
        });
      }
      const plan = params.plan as PlanIR;
      const blockers = [...verifyCompiledPlan(plan, catalog.version, nowMs)];
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
          if (extra.signal.aborted) {
            blockers.push({
              severity: 'error',
              path: step.id,
              reason: 'Preflight was cancelled.',
              safe_repair: 'Retry if still needed.',
            });
            break;
          }
          if (step.effect !== 'pure' && step.effect !== 'read') continue;
          const definition = catalog.getById(step.operation_id);
          const args = materializeInputs(step.inputs);
          if (
            definition === undefined ||
            definition.handler === undefined ||
            !PREFLIGHT_OPERATION_ALLOWLIST.has(step.operation_id) ||
            args === null
          ) {
            blockers.push({
              severity: 'error',
              path: step.id,
              reason: 'Operation is not eligible for planner preflight.',
              safe_repair:
                'Resolve slots and use an explicitly allowlisted safe preflight operation.',
            });
            continue;
          }
          const response = await definition.handler(
            { ...args, auth_token: params.auth_token },
            extra
          );
          checks.push({
            step_id: step.id,
            operation_id: step.operation_id,
            ok: response.isError !== true,
          });
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
      plan_hash: z.string(),
      drafts: z.array(z.record(z.string(), z.unknown())),
      blockers: z.array(z.record(z.string(), z.unknown())),
    },
    ((params) => {
      const resolved = planningContext(params.auth_token as string | undefined, catalog);
      if (!resolved.ok) return fail(resolved.reason);
      const plan = params.plan as PlanIR;
      const blockers = [...verifyCompiledPlan(plan, catalog.version, Date.now())];
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
      for (const step of plan.steps) {
        if (step.effect !== 'draft' && step.effect !== 'write') continue;
        const definition = catalog.getById(step.operation_id);
        const args = materializeInputs(step.inputs);
        const scope = definition?.governance.scope;
        if (
          definition === undefined ||
          args === null ||
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
        candidates.push({ stepId: step.id, scope: scope as WriteScope, args });
      }
      if (blockers.length > 0)
        return out({
          executable: false,
          executed: false,
          plan_hash: plan.plan_hash,
          drafts: [],
          blockers,
        });
      const drafts = candidates.map(({ stepId, scope, args }) => ({
        step_id: stepId,
        ...draftWorkflowIntent({
          auth_token: params.auth_token as string | undefined,
          scope,
          params: args.params as Record<string, unknown>,
          naturalKey: args.natural_key as string,
          projected_effect: args.projected_effect as string,
          preconditions: args.preconditions as Record<string, unknown> | undefined,
        }),
      }));
      return out({
        executable: false,
        executed: false,
        plan_hash: plan.plan_hash,
        drafts,
        blockers: [],
      });
    }) as ToolCallback<z.ZodRawShape>
  );

  return catalog;
}
