import { z } from 'zod';

export const planInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('slot'),
      value_type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

function rejectOversizedInputRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  let count = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key) && ++count > 100) return null;
  }
  return value;
}

const boundedStepInputsSchema = z
  .preprocess(rejectOversizedInputRecord, z.record(z.string(), planInputSchema))
  .nonoptional();

export const candidatePlanSchema = z
  .object({
    schema_version: z.literal(1),
    catalog_version: z.number().int().positive(),
    goal: z.string().min(1).max(2_000),
    requested_outcome: z.string().min(1).max(2_000),
    assumptions: z.array(z.string().min(1).max(1_000)).max(50),
    alternatives: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
            rationale: z.string().min(1).max(2_000),
            trade_offs: z.array(z.string().min(1).max(1_000)).max(20),
          })
          .strict()
      )
      .min(1)
      .max(3),
    selected_alternative_id: z.string().min(1),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
            operation_id: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
            depends_on: z.array(z.string()).max(64),
            inputs: boundedStepInputsSchema,
            expected_effect: z.enum(['pure', 'read', 'draft', 'write']),
            expected_risk: z.enum(['none', 'low', 'medium', 'high']),
            preconditions: z.array(z.string().min(1).max(1_000)).max(30),
            postconditions: z.array(z.string().min(1).max(1_000)).max(30),
            verification_operation_id: z.string().optional(),
            data_contract: z.string().optional(),
            consumer_requirement: z.string().optional(),
            failure_mode: z.string().min(1).max(1_000),
            fallback: z.string().min(1).max(1_000),
            compensation_note: z.string().max(1_000).optional(),
          })
          .strict()
      )
      .max(100),
    execution_mode: z.enum(['analyse', 'read_only', 'draft_only']),
  })
  .strict();

export const compileOperationPlanInputShape = {
  candidate: candidatePlanSchema,
  ttl_ms: z.number().int().positive().optional(),
} as const;

export const compiledPlanOutputShape = {
  accepted: z.boolean(),
  executable: z.literal(false),
  plan: z.record(z.string(), z.unknown()).optional(),
  issues: z.array(z.record(z.string(), z.unknown())),
  plan_hash: z.string().optional(),
} as const;

const compiledPlanStepSchema = candidatePlanSchema.shape.steps.element.extend({
  effect: z.enum(['pure', 'read', 'draft', 'write']),
  risk_tier: z.enum(['none', 'low', 'medium', 'high']),
  capability_status: z.enum(['not_required', 'supported', 'blocked']),
  evidence_age_ms: z.number().nonnegative().nullable(),
  estimated_whmcs_calls: z.number().int().nonnegative(),
  expected_latency_class: z.enum(['instant', 'low', 'moderate', 'high']),
});

export const planIRSchema = z
  .object({
    planir_version: z.literal('1.0'),
    goal: z.string(),
    requested_outcome: z.string(),
    assumptions: z.array(z.string()),
    alternatives: candidatePlanSchema.shape.alternatives,
    selected_alternative_id: z.string(),
    steps: z.array(compiledPlanStepSchema),
    execution_mode: z.enum(['analyse', 'read_only', 'draft_only']),
    executable: z.literal(false),
    estimated_whmcs_calls: z.number().int().nonnegative(),
    expected_latency_class: z.enum(['instant', 'low', 'moderate', 'high']),
    catalog_version: z.number().int().positive(),
    expires_at: z.iso.datetime(),
    provenance: z
      .object({
        compiler: z.literal('whmcs-mcp-plan-compiler'),
        compiled_at: z.iso.datetime(),
        installation_id: z.string().min(1),
        configuration_fingerprint: z.string().min(1),
        policy_fingerprint: z.string().regex(/^sha256-[a-f0-9]{64}$/),
      })
      .strict(),
    plan_hash: z.string().regex(/^sha256-[a-f0-9]{64}$/),
  })
  .strict();
