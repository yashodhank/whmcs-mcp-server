import { beforeEach, describe, expect, it, vi } from 'vitest';

const { draftWorkflowIntent } = vi.hoisted(() => ({
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
  const profile = {
    id: 'transport-consumer',
    allowedScopes: [],
    defaultContract: 'llm_safe_summary' as const,
    allowedContracts: ['llm_safe_summary'] as const,
    allowedActions: ['list_invoices'],
    writeCapability: 'draft_only' as const,
    envRestrictions: [],
    anonymous: false,
    allowedWriteScopes: ['service:suspend'],
  };
  return {
    ...actual,
    resolveConsumer: () => ({ ok: true as const, profile }),
    consumerWriteScopes: () => profile.allowedWriteScopes,
    consumerWriteCapability: () => profile.writeCapability,
  };
});

import { OperationCatalog } from '../../src/catalog/registry.js';
import type { OperationDefinition } from '../../src/catalog/types.js';
import { registerPlanningTools } from '../../src/tools/planning.js';
import { __resetCapabilityEvidenceForTests } from '../../src/governance/capabilityEvidence.js';

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
    catalog_version: 7,
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

async function call(name: string, params: Record<string, unknown>) {
  const callback = callbacks.get(name);
  if (callback === undefined) throw new Error(`missing callback ${name}`);
  return callback(params, { signal: new AbortController().signal });
}

describe('planning tools', () => {
  beforeEach(() => {
    callbacks.clear();
    draftWorkflowIntent.mockClear();
    pureHandler.mockClear();
    whmcsRead.mockClear();
    __resetCapabilityEvidenceForTests();
    const base = new OperationCatalog([baseDefinition], 7, 100);
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
    expect(pureHandler).toHaveBeenCalledOnce();
    expect(response.structuredContent).toMatchObject({ executable: false, blockers: [] });
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
    expect(whmcsRead).toHaveBeenCalledWith('GetInvoices', { clientid: 42, limitnum: 1 });
    expect(response.structuredContent).toMatchObject({
      executable: false,
      blockers: [],
      plan: expect.objectContaining({ executable: false }),
    });
    expect(response.structuredContent.checks).toEqual([
      expect.objectContaining({ action: 'GetInvoices', status: 'supported' }),
    ]);
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
});
