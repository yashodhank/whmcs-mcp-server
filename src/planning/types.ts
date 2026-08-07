import type { OperationEffect, OperationRiskTier } from '../catalog/types.js';
import type {
  CapabilityEvidence,
  CapabilityEvidenceTarget,
} from '../governance/capabilityEvidence.js';
import type { OperationCatalog } from '../catalog/registry.js';

export const PLAN_IR_VERSION = '1.0' as const;
export type PlanningExecutionMode = 'analyse' | 'read_only' | 'draft_only';
export type PlanningLatencyClass = 'instant' | 'low' | 'moderate' | 'high';

export type PlanInput =
  | { readonly kind: 'value'; readonly value: unknown }
  | {
      readonly kind: 'slot';
      readonly value_type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      readonly reason: string;
    };

export interface CandidateAlternative {
  readonly id: string;
  readonly rationale: string;
  readonly trade_offs: readonly string[];
}

export interface CandidatePlanStep {
  readonly id: string;
  readonly operation_id: string;
  readonly depends_on: readonly string[];
  readonly inputs: Readonly<Record<string, PlanInput>>;
  readonly expected_effect: OperationEffect;
  readonly expected_risk: OperationRiskTier;
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
  readonly verification_operation_id?: string;
  readonly data_contract?: string;
  readonly consumer_requirement?: string;
  readonly failure_mode: string;
  readonly fallback: string;
  readonly compensation_note?: string;
}

export interface CandidatePlan {
  readonly schema_version: 1;
  readonly catalog_version: number;
  readonly goal: string;
  readonly requested_outcome: string;
  readonly assumptions: readonly string[];
  readonly alternatives: readonly CandidateAlternative[];
  readonly selected_alternative_id: string;
  readonly steps: readonly CandidatePlanStep[];
  readonly execution_mode: PlanningExecutionMode;
}

export interface PlanIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly reason: string;
  readonly safe_repair: string;
}

export interface PlanningLimits {
  readonly maxSteps: number;
  readonly maxWhmcsCalls: number;
  readonly maxFanOut: number;
  readonly maxPageSize: number;
  readonly maxTtlMs: number;
}

export interface AuthenticatedPlanningContext {
  readonly evidenceTarget: CapabilityEvidenceTarget;
  readonly allowedCapabilityIds: ReadonlySet<string>;
  readonly allowedWriteScopes: ReadonlySet<string>;
  readonly allowedContracts: ReadonlySet<string>;
  /** Null for admin scope; otherwise the process-level client allowlist. */
  readonly allowedClientIds: ReadonlySet<number> | null;
  readonly writeCapability:
    | 'false'
    | 'draft_only'
    | 'approval_required'
    | 'disabled'
    | 'execution_allowed';
}

export interface CompiledPlanStep extends CandidatePlanStep {
  readonly effect: OperationEffect;
  readonly risk_tier: OperationRiskTier;
  readonly capability_status: 'not_required' | 'supported' | 'blocked';
  readonly evidence_age_ms: number | null;
  readonly estimated_whmcs_calls: number;
  readonly expected_latency_class: PlanningLatencyClass;
}

export interface PlanIR {
  readonly planir_version: typeof PLAN_IR_VERSION;
  readonly goal: string;
  readonly requested_outcome: string;
  readonly assumptions: readonly string[];
  readonly alternatives: readonly CandidateAlternative[];
  readonly selected_alternative_id: string;
  readonly steps: readonly CompiledPlanStep[];
  readonly execution_mode: PlanningExecutionMode;
  readonly executable: false;
  readonly estimated_whmcs_calls: number;
  readonly expected_latency_class: PlanningLatencyClass;
  readonly catalog_version: number;
  readonly expires_at: string;
  readonly provenance: {
    readonly compiler: 'whmcs-mcp-plan-compiler';
    readonly compiled_at: string;
    readonly installation_id: string;
    readonly configuration_fingerprint: string;
  };
  readonly plan_hash: string;
}

export type CompilePlanResult =
  | { readonly accepted: true; readonly plan: PlanIR; readonly issues: readonly PlanIssue[] }
  | { readonly accepted: false; readonly issues: readonly PlanIssue[] };

export interface CompilePlanInput {
  readonly candidate: CandidatePlan;
  readonly context: AuthenticatedPlanningContext;
  readonly catalog: OperationCatalog;
  readonly evidence: readonly CapabilityEvidence[];
  readonly limits: PlanningLimits;
  readonly nowMs: number;
  readonly ttlMs: number;
}

export const DEFAULT_PLANNING_LIMITS: PlanningLimits = Object.freeze({
  maxSteps: 24,
  maxWhmcsCalls: 40,
  maxFanOut: 8,
  maxPageSize: 100,
  maxTtlMs: 5 * 60_000,
});
