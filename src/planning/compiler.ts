import { createHash } from 'node:crypto';
import { candidatePlanSchema } from './schema.js';
import { latencyClassForCalls, operationCallCost } from './costModel.js';
import { validateCandidatePlan } from './validator.js';
import {
  PLAN_IR_VERSION,
  type CandidatePlan,
  type CompilePlanInput,
  type CompilePlanResult,
  type PlanIR,
  type PlanIssue,
} from './types.js';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)])
    );
  }
  return value;
}

export function canonicalPlanHash(plan: Omit<PlanIR, 'plan_hash'>): string {
  return `sha256-${createHash('sha256')
    .update(JSON.stringify(stable(plan)))
    .digest('hex')}`;
}

function normalizeCandidate(candidate: CandidatePlan): CandidatePlan {
  const uniqueSorted = (items: readonly string[]) =>
    [...new Set(items.map((item) => item.trim()))].sort();
  return {
    ...candidate,
    goal: candidate.goal.trim(),
    requested_outcome: candidate.requested_outcome.trim(),
    assumptions: uniqueSorted(candidate.assumptions),
    alternatives: candidate.alternatives
      .map((alternative) => ({
        ...alternative,
        rationale: alternative.rationale.trim(),
        trade_offs: uniqueSorted(alternative.trade_offs),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    steps: candidate.steps.map((step) => ({
      ...step,
      depends_on: uniqueSorted(step.depends_on),
      preconditions: uniqueSorted(step.preconditions),
      postconditions: uniqueSorted(step.postconditions),
      inputs: Object.fromEntries(
        Object.entries(step.inputs).sort(([left], [right]) => left.localeCompare(right))
      ),
    })),
  };
}

export function compileOperationPlan(
  rawInput: Omit<CompilePlanInput, 'candidate'> & { candidate: unknown }
): CompilePlanResult {
  const parsed = candidatePlanSchema.safeParse(rawInput.candidate);
  if (!parsed.success) {
    const issues: PlanIssue[] = parsed.error.issues.map((item) => ({
      severity: 'error',
      path: item.path.join('.'),
      reason: item.message,
      safe_repair: 'Repair the candidate to match the versioned PlanIR candidate schema.',
    }));
    return { accepted: false, issues };
  }
  const candidate = normalizeCandidate(parsed.data as CandidatePlan);
  const input: CompilePlanInput = { ...rawInput, candidate };
  const issues = validateCandidatePlan(input);
  if (issues.some((item) => item.severity === 'error')) return { accepted: false, issues };

  const ttlMs = Math.min(input.ttlMs, input.limits.maxTtlMs);
  const compiledAt = new Date(input.nowMs).toISOString();
  const expiresAt = new Date(input.nowMs + ttlMs).toISOString();
  let totalCalls = 0;
  const steps = candidate.steps.map((step) => {
    const operation = input.catalog.getById(step.operation_id);
    if (operation === undefined)
      throw new Error('Validated operation disappeared from immutable catalog');
    const calls = operationCallCost(operation);
    totalCalls += calls;
    const actionEvidence = operation.whmcsActions
      .map((action) =>
        input.evidence.find(
          (item) =>
            item.action === action &&
            item.installationId === input.context.evidenceTarget.installationId &&
            item.configFingerprint === input.context.evidenceTarget.configFingerprint &&
            item.catalogVersion === input.catalog.version &&
            item.status === 'supported' &&
            Date.parse(item.expiresAt) > input.nowMs
        )
      )
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    const age =
      actionEvidence.length === 0
        ? null
        : Math.max(...actionEvidence.map((item) => input.nowMs - Date.parse(item.observedAt)));
    return {
      ...step,
      effect: operation.effects,
      risk_tier: operation.riskTier,
      capability_status:
        operation.whmcsActions.length === 0 ? ('not_required' as const) : ('supported' as const),
      evidence_age_ms: age,
      estimated_whmcs_calls: calls,
      expected_latency_class: latencyClassForCalls(calls),
    };
  });
  const unhashed: Omit<PlanIR, 'plan_hash'> = {
    planir_version: PLAN_IR_VERSION,
    goal: candidate.goal,
    requested_outcome: candidate.requested_outcome,
    assumptions: candidate.assumptions,
    alternatives: candidate.alternatives,
    selected_alternative_id: candidate.selected_alternative_id,
    steps,
    execution_mode: candidate.execution_mode,
    executable: false,
    estimated_whmcs_calls: totalCalls,
    expected_latency_class: latencyClassForCalls(totalCalls),
    catalog_version: input.catalog.version,
    expires_at: expiresAt,
    provenance: {
      compiler: 'whmcs-mcp-plan-compiler',
      compiled_at: compiledAt,
      installation_id: input.context.evidenceTarget.installationId,
      configuration_fingerprint: input.context.evidenceTarget.configFingerprint,
    },
  };
  return { accepted: true, plan: { ...unhashed, plan_hash: canonicalPlanHash(unhashed) }, issues };
}

export function verifyCompiledPlan(
  plan: PlanIR,
  catalogVersion: number,
  nowMs: number
): readonly PlanIssue[] {
  const { plan_hash: suppliedHash, ...unhashed } = plan;
  const issues: PlanIssue[] = [];
  if (suppliedHash !== canonicalPlanHash(unhashed)) {
    issues.push({
      severity: 'error',
      path: 'plan_hash',
      reason: 'Plan hash does not match the normalized plan.',
      safe_repair: 'Recompile the candidate; do not reuse or edit a compiled plan.',
    });
  }
  if (plan.catalog_version !== catalogVersion) {
    issues.push({
      severity: 'error',
      path: 'catalog_version',
      reason: 'Plan catalog version is stale.',
      safe_repair: 'Refresh the catalog and recompile.',
    });
  }
  if (Date.parse(plan.expires_at) <= nowMs) {
    issues.push({
      severity: 'error',
      path: 'expires_at',
      reason: 'Plan has expired.',
      safe_repair: 'Refresh evidence and recompile.',
    });
  }
  if (plan.executable !== false) {
    issues.push({
      severity: 'error',
      path: 'executable',
      reason: 'PlanIR is always non-executable.',
      safe_repair: 'Set executable:false by recompiling through the server.',
    });
  }
  return issues;
}
