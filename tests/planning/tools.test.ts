import { beforeEach, describe, expect, it, vi } from 'vitest';

const { consumerState, draftWorkflowIntent } = vi.hoisted(() => ({
  consumerState: {
    consumerId: 'transport-consumer',
    allowedActions: ['list_invoices'],
    allowedWriteScopes: ['service:suspend'],
    writeCapability: 'draft_only' as 'draft_only' | 'disabled',
  },
  draftWorkflowIntent: vi.fn(() => ({
    ok: true as const,
    intent_id: 'intent-draft-only',
    scope: 'service:suspend' as const,
    risk: 'medium' as const,
  })),
}));

vi.mock('../../src/tools/writeFlow.js', () => ({ draftWorkflowIntent }));
vi.mock('../../src/governance/pipeline.js', () => ({
  getProjectionEnv: () => 'local',
  getConsumerRegistry: () => [],
}));
vi.mock('../../src/governance/consumers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/governance/consumers.js')>();
  return {
    ...actual,
    resolveConsumer: () => ({
      ok: true as const,
      profile: {
        id: consumerState.consumerId,
        allowedScopes: [],
        defaultContract: 'llm_safe_summary' as const,
        allowedContracts: ['llm_safe_summary'] as const,
        allowedActions: [...consumerState.allowedActions],
        writeCapability: consumerState.writeCapability,
        envRestrictions: [],
        anonymous: false,
        allowedWriteScopes: [...consumerState.allowedWriteScopes],
      },
    }),
    consumerWriteScopes: (profile: { allowedWriteScopes: readonly string[] }) =>
      profile.allowedWriteScopes,
    consumerWriteCapability: (profile: { writeCapability: 'draft_only' | 'disabled' }) =>
      profile.writeCapability,
  };
});

import { OperationCatalog } from '../../src/catalog/registry.js';
import type { OperationDefinition } from '../../src/catalog/types.js';
import { registerPlanningTools } from '../../src/tools/planning.js';
import { __resetCapabilityEvidenceForTests } from '../../src/governance/capabilityEvidence.js';
import { canonicalPlanHash } from '../../src/planning/compiler.js';
import type { PlanIR } from '../../src/planning/types.js';

type Handler = (
  params: Record<string, unknown>,
  extra: { signal: AbortSignal }
) =>
  | Promise<{ structuredContent: Record<string, unknown> }>
  | {
      structuredContent: Record<string, unknown>;
    };

const callbacks = new Map<string, Handler>();
const server = {
  registerTool(name: string, _config: unknown, callback: Handler) {
    callbacks.set(name, callback);
  },
};
const logger = { error: vi.fn() };
const limiter = { tryConsume: () => true };

const pureHandler = vi.fn(() => ({
  content: [{ type: 'text', text: '{}' }],
  structuredContent: {},
}));
const whmcsRead = vi.fn(async () => ({ result: 'success', invoices: { invoice: [] } }));
const baseDefinition: OperationDefinition = {
  id: 'capabilities.matrix.read',
  publicName: 'get_capability_matrix',
  domain: 'capabilities',
  description: 'safe pure operation',
  inputSchema: {},
  outputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
  effects: 'pure',
  riskTier: 'none',
  whmcsActions: [],
  capability: { mode: 'none', probe: 'none' },
  governance: { scope: null, output: 'sanitized', rawWhmcsOutput: false },
  cache: { mode: 'none' },
  cost: { kind: 'constant', maxWhmcsCalls: 0, maxItems: 1 },
  auth: { toolAuthRequired: true, consumerFiltered: false },
  pagination: null,
  prerequisites: [],
  fallbacks: [],
  protocolFeatures: ['tools'],
  handler: pureHandler as never,
  version: 1,
};

function candidate(operationId: string, mode: 'analyse' | 'read_only' | 'draft_only') {
  const draft = operationId === 'services.suspend.draft';
  return {
    schema_version: 1 as const,
    catalog_version: 4,
    goal: 'Safe operation proposal',
    requested_outcome: 'A reviewed non-executing plan',
    assumptions: [],
    alternatives: [{ id: 'safe', rationale: 'least privilege', trade_offs: ['requires review'] }],
    selected_alternative_id: 'safe',
    steps: [
      {
        id: 'one',
        operation_id: operationId,
        depends_on: [],
        inputs: draft
          ? {
              natural_key: { kind: 'value' as const, value: 'service:42' },
              projected_effect: { kind: 'value' as const, value: 'Suspend service 42' },
              params: {
                kind: 'value' as const,
                value: { serviceid: 42, reason: 'policy threshold' },
              },
            }
          : {},
        expected_effect: draft ? ('draft' as const) : ('pure' as const),
        expected_risk: draft ? ('medium' as const) : ('none' as const),
        preconditions: [],
        postconditions: [],
        failure_mode: 'blocked',
        fallback: 'stop',
      },
    ],
    execution_mode: mode,
  };
}

async function call(
  name: string,
  params: Record<string, unknown>,
  signal = new AbortController().signal
) {
  const callback = callbacks.get(name);
  if (callback === undefined) throw new Error(`missing callback ${name}`);
  return callback(params, { signal });
}

describe('planning tools', () => {
  beforeEach(() => {
    callbacks.clear();
    draftWorkflowIntent.mockClear();
    pureHandler.mockClear();
    whmcsRead.mockClear();
    consumerState.consumerId = 'transport-consumer';
    consumerState.allowedActions = ['list_invoices'];
    consumerState.allowedWriteScopes = ['service:suspend'];
    consumerState.writeCapability = 'draft_only';
    __resetCapabilityEvidenceForTests();
    const base = new OperationCatalog([baseDefinition], 3, 100);
    registerPlanningTools(
      server as never,
      base,
      logger as never,
      limiter as never,
      { read: whmcsRead } as never
    );
  });

  it('registers only inspect/compile/preflight/draft and exposes filtered descriptors', async () => {
    expect([...callbacks.keys()].sort()).toEqual([
      'compile_operation_plan',
      'draft_operation_plan',
      'inspect_operation_catalog',
      'preflight_operation_plan',
    ]);
    const response = await call('inspect_operation_catalog', { auth_token: 'transport-bound' });
    expect(response.structuredContent.executable).toBe(false);
    expect(response.structuredContent.operations.map((item: { id: string }) => item.id)).toContain(
      'services.suspend.draft'
    );
    const suspend = response.structuredContent.operations.find(
      (item: { id: string }) => item.id === 'services.suspend.draft'
    ) as { input_schema: { properties: Record<string, unknown> } };
    expect(suspend.input_schema.properties).not.toHaveProperty('auth_token');
    expect(suspend.input_schema).toHaveProperty('properties.params.properties.serviceid');
  });

  it('preflights only the explicit safe allowlist and returns no raw handler data', async () => {
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: candidate('capabilities.matrix.read', 'analyse'),
    });
    const response = await call('preflight_operation_plan', {
      auth_token: 'transport-bound',
      plan: compiled.structuredContent.plan,
    });
    expect(pureHandler).not.toHaveBeenCalled();
    expect(response.structuredContent).toMatchObject({ executable: false, blockers: [] });
    expect(response.structuredContent.checks).toEqual([
      expect.objectContaining({ status: 'available', source: 'local' }),
    ]);
    expect(JSON.stringify(response.structuredContent)).not.toContain('raw');
  });

  it('can acquire bounded safe-read evidence from a candidate and return compiled PlanIR', async () => {
    const readCandidate = candidate('capabilities.matrix.read', 'analyse');
    readCandidate.execution_mode = 'read_only';
    readCandidate.steps = [
      {
        ...readCandidate.steps[0],
        operation_id: 'billing.ar_aging.read',
        expected_effect: 'read',
        expected_risk: 'low',
        inputs: { clientid: { kind: 'value', value: 42 } },
      },
    ];
    const response = await call('preflight_operation_plan', {
      auth_token: 'transport-bound',
      candidate: readCandidate,
    });
    expect(whmcsRead).toHaveBeenCalledWith(
      'GetInvoices',
      { clientid: 42, limitnum: 1 },
      { signal: expect.any(AbortSignal) }
    );
    expect(response.structuredContent).toMatchObject({
      executable: false,
      blockers: [],
      plan: expect.objectContaining({ executable: false }),
    });
    expect(response.structuredContent.checks).toEqual([
      expect.objectContaining({ action: 'GetInvoices', status: 'supported' }),
    ]);
    __resetCapabilityEvidenceForTests();
    whmcsRead.mockClear();
    const replay = await call('preflight_operation_plan', {
      auth_token: 'transport-bound',
      plan: response.structuredContent.plan,
    });
    expect(whmcsRead).toHaveBeenCalledOnce();
    expect(replay.structuredContent.checks).toEqual([
      expect.objectContaining({ action: 'GetInvoices', status: 'supported' }),
    ]);
    expect(JSON.stringify(replay.structuredContent)).not.toContain('invoices');
  });

  it('turns an eligible write outcome into a draft only and reports executed:false', async () => {
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: candidate('services.suspend.draft', 'draft_only'),
    });
    expect(compiled.structuredContent.accepted).toBe(true);
    const response = await call('draft_operation_plan', {
      auth_token: 'transport-bound',
      plan: compiled.structuredContent.plan,
    });
    expect(draftWorkflowIntent).toHaveBeenCalledOnce();
    expect(response.structuredContent).toMatchObject({
      executable: false,
      executed: false,
      partial: false,
      blockers: [],
      drafts: [expect.objectContaining({ intent_id: 'intent-draft-only' })],
    });
    expect([...callbacks.keys()]).not.toEqual(
      expect.arrayContaining(['approve_write_intent', 'execute_write_intent', 'run_plan'])
    );
  });

  it('blocks edited and expired plans before drafting', async () => {
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: candidate('services.suspend.draft', 'draft_only'),
    });
    const response = await call('draft_operation_plan', {
      auth_token: 'transport-bound',
      plan: { ...compiled.structuredContent.plan, goal: 'tampered' },
    });
    expect(draftWorkflowIntent).not.toHaveBeenCalled();
    expect(response.structuredContent.blockers).toContainEqual(
      expect.objectContaining({ path: 'plan_hash' })
    );
  });

  it('revalidates strict schema and privacy even when a caller rehashes a modified plan', async () => {
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: candidate('services.suspend.draft', 'draft_only'),
    });
    const tampered = structuredClone(compiled.structuredContent.plan) as PlanIR;
    const paramsInput = tampered.steps[0].inputs.params;
    if (paramsInput?.kind !== 'value' || paramsInput.value === null) {
      throw new Error('expected materialized params');
    }
    (paramsInput.value as Record<string, unknown>).password = 'credential-sentinel';
    const { plan_hash: _oldHash, ...unhashed } = tampered;
    void _oldHash;
    const rehashed = { ...tampered, plan_hash: canonicalPlanHash(unhashed) };
    const response = await call('draft_operation_plan', {
      auth_token: 'transport-bound',
      plan: rehashed,
    });
    expect(draftWorkflowIntent).not.toHaveBeenCalled();
    expect(response.structuredContent.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('password') }),
        expect.objectContaining({ reason: expect.stringContaining('strict server-owned') }),
      ])
    );
    expect(JSON.stringify(response.structuredContent)).not.toContain('credential-sentinel');
  });

  it('rechecks current consumer grants immediately before creating drafts', async () => {
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: candidate('services.suspend.draft', 'draft_only'),
    });
    expect(compiled.structuredContent.accepted).toBe(true);
    consumerState.allowedWriteScopes = [];
    consumerState.writeCapability = 'disabled';
    const response = await call('draft_operation_plan', {
      auth_token: 'transport-bound',
      plan: compiled.structuredContent.plan,
    });
    expect(draftWorkflowIntent).not.toHaveBeenCalled();
    expect(response.structuredContent.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'consumer' }),
        expect.objectContaining({ path: 'one' }),
      ])
    );
  });

  it('binds compiled plans to the exact transport consumer policy fingerprint', async () => {
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: candidate('services.suspend.draft', 'draft_only'),
    });
    consumerState.consumerId = 'different-consumer';
    const response = await call('draft_operation_plan', {
      auth_token: 'transport-bound',
      plan: compiled.structuredContent.plan,
    });
    expect(draftWorkflowIntent).not.toHaveBeenCalled();
    expect(response.structuredContent.blockers).toContainEqual(
      expect.objectContaining({ path: 'provenance.policy_fingerprint' })
    );
  });

  it('reports partial drafting and stops after the first draft denial', async () => {
    const multi = candidate('services.suspend.draft', 'draft_only');
    multi.steps.push({
      ...multi.steps[0],
      id: 'two',
      inputs: {
        ...multi.steps[0].inputs,
        natural_key: { kind: 'value', value: 'service:43' },
        params: { kind: 'value', value: { serviceid: 43, reason: 'policy threshold' } },
      },
    });
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: multi,
    });
    draftWorkflowIntent
      .mockReturnValueOnce({
        ok: true,
        intent_id: 'intent-first',
        scope: 'service:suspend',
        risk: 'medium',
      })
      .mockReturnValueOnce({ ok: false, reason: 'consumer denied' } as never);
    const response = await call('draft_operation_plan', {
      auth_token: 'transport-bound',
      plan: compiled.structuredContent.plan,
    });
    expect(draftWorkflowIntent).toHaveBeenCalledTimes(2);
    expect(response.structuredContent).toMatchObject({
      executed: false,
      partial: true,
      drafts: [{ ok: true }, { ok: false }],
      blockers: [expect.objectContaining({ path: 'two' })],
    });
  });

  it('preserves partial results when a later draft attempt throws', async () => {
    const multi = candidate('services.suspend.draft', 'draft_only');
    multi.steps.push({
      ...multi.steps[0],
      id: 'two',
      inputs: {
        ...multi.steps[0].inputs,
        natural_key: { kind: 'value', value: 'service:43' },
        params: { kind: 'value', value: { serviceid: 43, reason: 'policy threshold' } },
      },
    });
    const compiled = await call('compile_operation_plan', {
      auth_token: 'transport-bound',
      candidate: multi,
    });
    draftWorkflowIntent
      .mockReturnValueOnce({
        ok: true,
        intent_id: 'intent-first',
        scope: 'service:suspend',
        risk: 'medium',
      })
      .mockImplementationOnce(() => {
        throw new Error('storage unavailable');
      });
    const response = await call('draft_operation_plan', {
      auth_token: 'transport-bound',
      plan: compiled.structuredContent.plan,
    });
    expect(response.structuredContent).toMatchObject({
      executed: false,
      partial: true,
      drafts: [{ ok: true }, { ok: false, reason: 'draft creation failed' }],
      blockers: [expect.objectContaining({ path: 'two' })],
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain('storage unavailable');
  });

  it('propagates cancellation to the read boundary and starts no reads after cancellation', async () => {
    const readCandidate = candidate('capabilities.matrix.read', 'analyse');
    readCandidate.execution_mode = 'read_only';
    readCandidate.steps = [
      {
        ...readCandidate.steps[0],
        operation_id: 'billing.ar_aging.read',
        expected_effect: 'read',
        expected_risk: 'low',
        inputs: { clientid: { kind: 'value', value: 42 } },
      },
    ];
    const preCancelled = new AbortController();
    preCancelled.abort();
    const cancelled = await call(
      'preflight_operation_plan',
      { auth_token: 'transport-bound', candidate: readCandidate },
      preCancelled.signal
    );
    expect(whmcsRead).not.toHaveBeenCalled();
    expect(cancelled.structuredContent.blockers).toContainEqual(
      expect.objectContaining({ reason: 'Preflight was cancelled.' })
    );

    const inFlight = new AbortController();
    whmcsRead.mockImplementationOnce(async (_action, _params, options) => {
      expect(options).toEqual({ signal: inFlight.signal });
      inFlight.abort();
      throw new Error('aborted');
    });
    const interrupted = await call(
      'preflight_operation_plan',
      { auth_token: 'transport-bound', candidate: readCandidate },
      inFlight.signal
    );
    expect(whmcsRead).toHaveBeenCalledOnce();
    expect(interrupted.structuredContent.blockers).toContainEqual(
      expect.objectContaining({ reason: 'Preflight was cancelled.' })
    );

    whmcsRead.mockResolvedValueOnce({ result: 'success', invoices: { invoice: [] } });
    const retry = await call('preflight_operation_plan', {
      auth_token: 'transport-bound',
      candidate: readCandidate,
    });
    expect(whmcsRead).toHaveBeenCalledTimes(2);
    expect(retry.structuredContent).toMatchObject({
      blockers: [],
      plan: expect.objectContaining({ executable: false }),
    });
  });
});
