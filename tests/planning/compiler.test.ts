import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OperationCatalog } from '../../src/catalog/registry.js';
import type { OperationDefinition } from '../../src/catalog/types.js';
import {
  canonicalPlanHash,
  compileOperationPlan,
  verifyCompiledPlan,
} from '../../src/planning/compiler.js';
import {
  DEFAULT_PLANNING_LIMITS,
  type AuthenticatedPlanningContext,
  type CandidatePlan,
} from '../../src/planning/types.js';
import type { CapabilityEvidence } from '../../src/governance/capabilityEvidence.js';
import { fingerprintPlanningPolicy } from '../../src/planning/policyFingerprint.js';

const inert = (() => ({ content: [] })) as OperationDefinition['handler'];

function definition(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'capabilities.matrix.read',
    publicName: 'get_capability_matrix',
    domain: 'capabilities',
    description: 'safe catalog read',
    inputSchema: {},
    outputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
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
    handler: inert,
    version: 1,
    ...overrides,
  };
}

const catalog = new OperationCatalog(
  [
    definition(),
    definition({
      id: 'billing.invoices.read',
      publicName: 'list_invoices',
      domain: 'billing',
      inputSchema: { clientid: z.number().int().positive() },
      effects: 'read',
      riskTier: 'low',
      whmcsActions: ['GetInvoices'],
      capability: { mode: 'all', probe: 'read_safe' },
      cost: { kind: 'bounded_fanout', maxWhmcsCalls: 2, maxItems: 100, maxConcurrency: 2 },
      auth: { toolAuthRequired: true, consumerFiltered: true },
    }),
    definition({
      id: 'services.suspend.draft',
      publicName: 'draft_service_suspend',
      domain: 'services',
      inputSchema: {
        natural_key: z.string(),
        projected_effect: z.string(),
        params: z.record(z.string(), z.unknown()),
      },
      effects: 'draft',
      riskTier: 'medium',
      whmcsActions: [],
      capability: { mode: 'none', probe: 'none' },
      governance: { scope: 'service:suspend', output: 'sanitized', rawWhmcsOutput: false },
      annotations: { readOnlyHint: false, destructiveHint: true },
      cost: { kind: 'constant', maxWhmcsCalls: 0, maxItems: 1 },
      handler: undefined,
    }),
  ],
  7,
  100
);

const context: AuthenticatedPlanningContext = {
  policyFingerprint: `sha256-${'1'.repeat(64)}`,
  evidenceTarget: {
    installationId: 'installation-hash',
    configFingerprint: 'config-hash',
    catalogVersion: 7,
  },
  allowedCapabilityIds: new Set(['list_invoices']),
  allowedWriteScopes: new Set(['service:suspend']),
  allowedContracts: new Set(['llm_safe_summary']),
  allowedClientIds: null,
  writeCapability: 'draft_only',
};

function candidate(
  step: CandidatePlan['steps'][number],
  mode: CandidatePlan['execution_mode']
): CandidatePlan {
  return {
    schema_version: 1,
    catalog_version: 7,
    goal: 'Review one account',
    requested_outcome: 'Explain the safe next step',
    assumptions: ['No raw customer data is embedded'],
    alternatives: [
      { id: 'observe', rationale: 'Gather minimum evidence', trade_offs: ['No immediate change'] },
    ],
    selected_alternative_id: 'observe',
    steps: [step],
    execution_mode: mode,
  };
}

function step(operationId = 'capabilities.matrix.read'): CandidatePlan['steps'][number] {
  return {
    id: 'inspect',
    operation_id: operationId,
    depends_on: [],
    inputs: {},
    expected_effect: operationId === 'capabilities.matrix.read' ? 'pure' : 'read',
    expected_risk: operationId === 'capabilities.matrix.read' ? 'none' : 'low',
    preconditions: [],
    postconditions: ['Evidence is reported'],
    failure_mode: 'Capability unavailable',
    fallback: 'Stop and report the blocker',
  };
}

function evidence(expiresAt = '2026-08-07T01:10:00.000Z'): CapabilityEvidence {
  return {
    installationId: 'installation-hash',
    configFingerprint: 'config-hash',
    catalogVersion: 7,
    action: 'GetInvoices',
    probeShapeHash: 'shape',
    status: 'supported',
    source: 'read_probe',
    observedAt: '2026-08-07T01:00:00.000Z',
    expiresAt,
    failureClass: 'none',
  };
}

function compile(candidateInput: CandidatePlan, evidenceInput: readonly CapabilityEvidence[] = []) {
  return compileOperationPlan({
    candidate: candidateInput,
    context,
    catalog,
    evidence: evidenceInput,
    limits: DEFAULT_PLANNING_LIMITS,
    nowMs: Date.parse('2026-08-07T01:05:00.000Z'),
    ttlMs: 120_000,
  });
}

describe('PlanIR compiler', () => {
  it('fingerprints effective grants deterministically without exposing consumer identity', () => {
    const first = fingerprintPlanningPolicy({
      consumerId: 'private-consumer-id',
      allowedCapabilityIds: ['b', 'a'],
      allowedWriteScopes: ['service:suspend'],
      allowedContracts: ['llm_safe_summary'],
      allowedClientIds: [42, 7],
      writeCapability: 'draft_only',
    });
    const reordered = fingerprintPlanningPolicy({
      consumerId: 'private-consumer-id',
      allowedCapabilityIds: ['a', 'b'],
      allowedWriteScopes: ['service:suspend'],
      allowedContracts: ['llm_safe_summary'],
      allowedClientIds: [7, 42],
      writeCapability: 'draft_only',
    });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(first).not.toContain('private-consumer-id');
  });

  it('compiles a normalized, expiring, permanently non-executable plan', () => {
    const result = compile(candidate(step(), 'analyse'));
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.plan).toMatchObject({
      planir_version: '1.0',
      executable: false,
      catalog_version: 7,
      expected_latency_class: 'instant',
      expires_at: '2026-08-07T01:07:00.000Z',
    });
    const { plan_hash, ...unhashed } = result.plan;
    expect(plan_hash).toBe(canonicalPlanHash(unhashed));
  });

  it('requires fresh target/config/catalog-bound evidence for reads', () => {
    const read = step('billing.invoices.read');
    read.inputs = { clientid: { kind: 'value', value: 42 } };
    expect(compile(candidate(read, 'read_only')).accepted).toBe(false);
    expect(
      compile(candidate(read, 'read_only'), [evidence('2026-08-07T01:04:00.000Z')]).accepted
    ).toBe(false);
    expect(compile(candidate(read, 'read_only'), [evidence()]).accepted).toBe(true);
    expect(
      compile(candidate(read, 'read_only'), [
        evidence(),
        { ...evidence(), status: 'not_authorized', probeShapeHash: 'other-shape' },
      ]).accepted
    ).toBe(false);
  });

  it('never outlives the capability evidence used to compile it', () => {
    const read = step('billing.invoices.read');
    read.inputs = { clientid: { kind: 'value', value: 42 } };
    const result = compile(candidate(read, 'read_only'), [evidence('2026-08-07T01:06:00.000Z')]);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.plan.expires_at).toBe('2026-08-07T01:06:00.000Z');
  });

  it.each([
    ['invented id', { ...step(), operation_id: 'invented.operation' }],
    ['effect laundering', { ...step(), expected_effect: 'read' as const }],
  ])('blocks %s', (_name, invalidStep) => {
    const result = compile(candidate(invalidStep, 'analyse'));
    expect(result.accepted).toBe(false);
  });

  it('blocks write-like steps in analyse/read-only and permits governed draft-only compilation', () => {
    const draft = {
      ...step('services.suspend.draft'),
      expected_effect: 'draft' as const,
      expected_risk: 'medium' as const,
      inputs: {
        natural_key: { kind: 'value' as const, value: 'service:42' },
        projected_effect: { kind: 'value' as const, value: 'Suspend service 42' },
        params: { kind: 'value' as const, value: { serviceid: 42, reason: 'policy threshold' } },
      },
    };
    expect(compile(candidate(draft, 'analyse')).accepted).toBe(false);
    expect(compile(candidate(draft, 'read_only')).accepted).toBe(false);
    expect(compile(candidate(draft, 'draft_only')).accepted).toBe(true);
  });

  it('keeps unknown identifiers as typed slots and reports an actionable warning', () => {
    const read = step('billing.invoices.read');
    read.inputs = {
      clientid: { kind: 'slot', value_type: 'number', reason: 'Operator must select client id' },
    };
    const result = compile(candidate(read, 'read_only'), [evidence()]);
    expect(result.accepted).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', path: 'steps[0].inputs' })
    );
  });

  it('rejects credentials and raw email-like PII anywhere in the candidate', () => {
    const withSecret = candidate(step(), 'analyse') as CandidatePlan & { auth_token?: string };
    withSecret.auth_token = 'not-a-real-token';
    expect(compile(withSecret).accepted).toBe(false);
    const withPii = candidate(step(), 'analyse');
    withPii.goal = 'Review person@example.invalid';
    expect(compile(withPii).accepted).toBe(false);
  });

  it('rejects PII-shaped fields and pathologically nested values before hashing', () => {
    const draft = {
      ...step('services.suspend.draft'),
      expected_effect: 'draft' as const,
      expected_risk: 'medium' as const,
      inputs: {
        natural_key: { kind: 'value' as const, value: 'service:42' },
        projected_effect: { kind: 'value' as const, value: 'Review suspension' },
        params: {
          kind: 'value' as const,
          value: { serviceid: 42, firstname: 'Sensitive', reason: 'policy threshold' },
        },
      },
    };
    const pii = compile(candidate(draft, 'draft_only'));
    expect(pii.accepted).toBe(false);
    expect(JSON.stringify(pii)).not.toContain('Sensitive');

    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    const deeplyNested = candidate(step(), 'analyse');
    deeplyNested.steps[0].inputs = { extra: { kind: 'value', value: nested } };
    const bounded = compile(deeplyNested);
    expect(bounded.accepted).toBe(false);
    expect(bounded.issues).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining('nesting depth') })
    );
  });

  it('fails closed with a structured issue for an undeclared catalog action', () => {
    const badDefinition = definition({
      id: 'bad.read',
      publicName: 'bad_read',
      effects: 'read',
      riskTier: 'low',
      whmcsActions: ['UndeclaredReadAction'],
      capability: { mode: 'all', probe: 'read_safe' },
      auth: { toolAuthRequired: true, consumerFiltered: true },
    });
    const badCatalog = {
      version: 7,
      getById: (id: string) => (id === 'bad.read' ? badDefinition : undefined),
    } as OperationCatalog;
    const result = compileOperationPlan({
      candidate: candidate(step('bad.read'), 'read_only'),
      context,
      catalog: badCatalog,
      evidence: [],
      limits: DEFAULT_PLANNING_LIMITS,
      nowMs: Date.parse('2026-08-07T01:05:00.000Z'),
      ttlMs: 120_000,
    });
    expect(result.accepted).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining('not declared') })
    );
  });

  it('rejects forward dependencies/cycles and excessive call budgets', () => {
    const read = step('billing.invoices.read');
    read.id = 'second';
    read.inputs = { clientid: { kind: 'value', value: 42 } };
    read.depends_on = ['later'];
    const later = { ...step(), id: 'later', depends_on: ['second'] };
    const graph = candidate(read, 'read_only');
    graph.steps = [read, later];
    const result = compileOperationPlan({
      candidate: graph,
      context,
      catalog,
      evidence: [evidence()],
      limits: { ...DEFAULT_PLANNING_LIMITS, maxWhmcsCalls: 1 },
      nowMs: Date.parse('2026-08-07T01:05:00.000Z'),
      ttlMs: 120_000,
    });
    expect(result.accepted).toBe(false);
    expect(result.issues.map((item) => item.reason).join(' ')).toMatch(/not earlier|exceed/);
  });

  it('detects replay, edits, expiry and catalog drift before side effects', () => {
    const result = compile(candidate(step(), 'analyse'));
    if (!result.accepted) throw new Error('fixture did not compile');
    expect(verifyCompiledPlan(result.plan, 7, Date.parse('2026-08-07T01:06:00.000Z'))).toEqual([]);
    expect(
      verifyCompiledPlan(
        result.plan,
        7,
        Date.parse('2026-08-07T01:06:00.000Z'),
        `sha256-${'9'.repeat(64)}`
      )
    ).toContainEqual(expect.objectContaining({ path: 'provenance.policy_fingerprint' }));
    expect(
      verifyCompiledPlan(
        { ...result.plan, goal: 'tampered' },
        8,
        Date.parse('2026-08-07T01:08:00.000Z')
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'plan_hash' }),
        expect.objectContaining({ path: 'catalog_version' }),
        expect.objectContaining({ path: 'expires_at' }),
      ])
    );
  });
});
