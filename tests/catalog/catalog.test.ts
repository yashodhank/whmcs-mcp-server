import { readFileSync } from 'node:fs';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerCatalogOperation } from '../../src/catalog/adapter.js';
import { DECLARED_WHMCS_CAPABILITIES } from '../../src/catalog/declaredCapabilities.js';
import { buildCapabilityDiscovery } from '../../src/catalog/discovery.js';
import { capabilityShellCatalogMachineView } from '../../src/catalog/packs/capabilityShell.js';
import { CatalogValidationError, OperationCatalog } from '../../src/catalog/registry.js';
import type { OperationDefinition } from '../../src/catalog/types.js';
import {
  __resetCapabilityEvidenceForTests,
  fingerprintCapabilityEvidenceTarget,
  getCapabilityEvidence,
  recordCapabilityEvidence,
} from '../../src/governance/capabilityEvidence.js';
import {
  __resetCapabilityCacheForTests,
  getCapability,
  probeCapability,
} from '../../src/governance/capabilities.js';
import { READ_ALLOWLIST } from '../../src/whmcs/actionPolicy.js';

const handler = vi.fn() as unknown as ToolCallback<z.ZodRawShape>;

function definition(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'system.health.read',
    publicName: 'get_system_health',
    domain: 'system',
    description: 'Synthetic catalog definition.',
    inputSchema: {},
    outputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    effects: 'pure',
    riskTier: 'none',
    whmcsActions: [],
    capability: { mode: 'none', probe: 'none' },
    governance: { scope: null, output: 'none', rawWhmcsOutput: false },
    cache: { mode: 'none' },
    cost: { kind: 'constant', maxWhmcsCalls: 0, maxItems: 1 },
    auth: { toolAuthRequired: true, consumerFiltered: false },
    pagination: null,
    prerequisites: [],
    fallbacks: [],
    protocolFeatures: ['tools'],
    handler,
    version: 1,
    ...overrides,
  };
}

describe('OperationCatalog invariants', () => {
  it('is deterministic, immutable, and rejects duplicate identities', () => {
    const one = definition();
    const two = definition({ id: 'system.health.other', publicName: 'get_other_health' });
    const catalog = new OperationCatalog([two, one], 2, 100);
    expect(catalog.machineView().operations.map(({ id }) => id)).toEqual([
      'system.health.other',
      'system.health.read',
    ]);
    expect(Object.isFrozen(catalog.definitions()[0])).toBe(true);
    expect(() => new OperationCatalog([one, { ...one }], 2, 100)).toThrow(/duplicate operation id/);
    expect(
      () => new OperationCatalog([one, { ...two, publicName: one.publicName }], 2, 100)
    ).toThrow(/duplicate public operation name/);
  });

  const invalid: readonly [string, OperationDefinition][] = [
    ['read annotations', definition({ annotations: { readOnlyHint: false } })],
    [
      'write scope',
      definition({
        effects: 'write',
        riskTier: 'high',
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    ],
    [
      'write risk',
      definition({
        effects: 'write',
        riskTier: 'low',
        annotations: { readOnlyHint: false, destructiveHint: true },
        governance: { scope: 'client:update', output: 'canonical', rawWhmcsOutput: false },
      }),
    ],
    [
      'write destructive declaration',
      definition({
        effects: 'write',
        riskTier: 'medium',
        annotations: { readOnlyHint: false },
        governance: { scope: 'client:update', output: 'canonical', rawWhmcsOutput: false },
      }),
    ],
    ['read capability', definition({ effects: 'read', riskTier: 'low' })],
    [
      'unknown read action',
      definition({
        effects: 'read',
        riskTier: 'low',
        whmcsActions: ['ImaginaryReadAction'],
        capability: { mode: 'all', probe: 'read_safe' },
      }),
    ],
    [
      'probe cache',
      definition({
        effects: 'read',
        riskTier: 'low',
        whmcsActions: ['GetClients'],
        capability: { mode: 'all', probe: 'read_safe' },
        cache: { mode: 'ttl', ttlMs: 1_000 },
      }),
    ],
    [
      'raw output governance',
      definition({ governance: { scope: null, output: 'none', rawWhmcsOutput: true } }),
    ],
    [
      'fanout bounds',
      definition({
        cost: { kind: 'bounded_fanout', maxWhmcsCalls: 0, maxItems: 10, maxConcurrency: 0 },
      }),
    ],
    ['pagination cap', definition({ pagination: { defaultLimit: 25, maxLimit: 101 } })],
    [
      'pagination schema maximum',
      definition({
        inputSchema: { limit: z.number().int().max(500).default(25) },
        pagination: { defaultLimit: 25, maxLimit: 100 },
      }),
    ],
    [
      'pagination schema default',
      definition({
        inputSchema: { limit: z.number().int().max(100).default(50) },
        pagination: { defaultLimit: 25, maxLimit: 100 },
      }),
    ],
  ];

  it.each(invalid)('rejects invalid %s metadata', (_label, candidate) => {
    expect(() => new OperationCatalog([candidate], 2, 100)).toThrow(CatalogValidationError);
  });

  it('accepts an explicitly non-destructive governed write', () => {
    const candidate = definition({
      id: 'client.note.create',
      publicName: 'create_client_note_catalog_test',
      effects: 'write',
      riskTier: 'medium',
      annotations: { readOnlyHint: false, destructiveHint: false },
      governance: { scope: 'client:note:create', output: 'canonical', rawWhmcsOutput: false },
    });
    expect(new OperationCatalog([candidate], 2, 100).getById(candidate.id)).toMatchObject({
      effects: 'write',
      annotations: { destructiveHint: false },
    });
  });
});

describe('catalog adapter and machine contract', () => {
  it('maps the definition to registerTool without altering the public contract', () => {
    const candidate = definition();
    const registerTool = vi.fn();
    registerCatalogOperation({ registerTool } as never, candidate);
    expect(registerTool).toHaveBeenCalledWith(
      candidate.publicName,
      {
        description: candidate.description,
        inputSchema: candidate.inputSchema,
        outputSchema: candidate.outputSchema,
        annotations: candidate.annotations,
      },
      candidate.handler
    );
  });

  it('matches the deterministic committed capability catalog fixture', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../fixtures/catalog/capability-catalog-v2.json', import.meta.url),
        'utf8'
      )
    ) as unknown;
    expect(capabilityShellCatalogMachineView(100)).toEqual(fixture);
  });

  it('governs every allowlisted WHMCS action as a legacy operation or internal probe', () => {
    const actions = DECLARED_WHMCS_CAPABILITIES.map(({ action }) => action);
    expect(new Set(actions).size).toBe(actions.length);
    expect([...READ_ALLOWLIST].filter((action) => !actions.includes(action))).toEqual([]);
    for (const declaration of DECLARED_WHMCS_CAPABILITIES) {
      expect(declaration.domain).not.toBe('');
      expect(['legacy_registrar', 'internal_probe']).toContain(declaration.migration);
      expect(['read_safe', 'external_only']).toContain(declaration.probe);
    }
  });
});

describe('consumer-safe capability discovery', () => {
  const readDefinition = definition({
    id: 'clients.list.read',
    publicName: 'list_clients_catalog_test',
    effects: 'read',
    riskTier: 'low',
    whmcsActions: ['GetClients'],
    capability: { mode: 'all', probe: 'read_safe' },
    governance: { scope: null, output: 'canonical', rawWhmcsOutput: true },
    inputSchema: { limit: z.number().int().max(100).default(25) },
    auth: { toolAuthRequired: true, consumerFiltered: true },
    cost: { kind: 'constant', maxWhmcsCalls: 1, maxItems: 100 },
    pagination: { defaultLimit: 25, maxLimit: 100 },
  });
  const catalog = new OperationCatalog([definition(), readDefinition], 2, 100);

  it('omits consumer-filtered operations when no request-bound grants exist', () => {
    const discovery = buildCapabilityDiscovery(catalog, {
      operationAllowed: () => true,
      availableProtocolFeatures: ['tools'],
      nowMs: 0,
    });
    expect(discovery.operations.map(({ name }) => name)).toEqual(['get_system_health']);
  });

  it('intersects global exposure and consumer grants without deny reasons', () => {
    const discovery = buildCapabilityDiscovery(catalog, {
      operationAllowed: (name) => name !== 'get_system_health',
      allowedCapabilityIds: new Set(['list_clients']),
      availableProtocolFeatures: ['resources', 'tools'],
      nowMs: 0,
    });
    expect(discovery.operations).toHaveLength(1);
    expect(discovery.operations[0]).toMatchObject({
      name: 'list_clients_catalog_test',
      capability: { declared: true, configured: true, effective: true },
    });
    expect(JSON.stringify(discovery)).not.toContain('denied');
    expect(discovery.etag).toMatch(/^sha256-[a-f0-9]{64}$/);
  });
});

describe('target-scoped capability evidence', () => {
  const evidenceReadDefinition = definition({
    id: 'clients.list.read',
    publicName: 'list_clients_catalog_test',
    effects: 'read',
    riskTier: 'low',
    whmcsActions: ['GetClients'],
    capability: { mode: 'all', probe: 'read_safe' },
    governance: { scope: null, output: 'canonical', rawWhmcsOutput: true },
    inputSchema: { limit: z.number().int().max(100).default(25) },
    auth: { toolAuthRequired: true, consumerFiltered: true },
    cost: { kind: 'constant', maxWhmcsCalls: 1, maxItems: 100 },
    pagination: { defaultLimit: 25, maxLimit: 100 },
  });
  const evidenceCatalog = new OperationCatalog([evidenceReadDefinition], 2, 100);
  const targetA = fingerprintCapabilityEvidenceTarget({
    installationIdentity: 'https://a.invalid/includes/api.php',
    configuration: { role: 'read-a' },
    catalogVersion: 2,
  });
  const targetB = fingerprintCapabilityEvidenceTarget({
    installationIdentity: 'https://b.invalid/includes/api.php',
    configuration: { role: 'read-b' },
    catalogVersion: 2,
  });

  it('isolates installation/configuration evidence and expires it fail-closed', () => {
    __resetCapabilityEvidenceForTests();
    recordCapabilityEvidence({
      target: targetA,
      action: 'GetUsers',
      status: 'supported',
      source: 'operator_external',
      observedAtMs: 1_000,
      ttlMs: 500,
      failureClass: 'none',
      note: 'Approved synthetic evidence.',
    });
    expect(getCapability('GetUsers', targetA, 1_200).status).toBe('supported');
    expect(getCapability('GetUsers', targetB, 1_200).status).toBe('unverified');
    expect(getCapabilityEvidence(targetA, 'GetUsers', 1_200)).toMatchObject({
      source: 'operator_external',
      failureClass: 'none',
      observedAt: new Date(1_000).toISOString(),
      expiresAt: new Date(1_500).toISOString(),
    });
    expect(getCapability('GetUsers', targetA, 1_500).status).toBe('unverified');
  });

  it('fails closed without probing an unknown action', async () => {
    __resetCapabilityCacheForTests();
    const read = vi.fn();
    const result = await probeCapability('UnknownWriteLikeAction', {
      read,
      isAllowlisted: () => true,
      target: targetA,
      now: () => 2_000,
    });
    expect(result.status).toBe('unsupported');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps probe results isolated by target with expiring provenance', async () => {
    __resetCapabilityCacheForTests();
    const read = vi.fn().mockResolvedValue({ result: 'success' });
    await probeCapability('GetContacts', {
      read,
      isAllowlisted: () => true,
      target: targetA,
      evidenceTtlMs: 100,
      now: () => 5_000,
    });
    expect(getCapability('GetContacts', targetA, 5_050).status).toBe('supported');
    expect(getCapability('GetContacts', targetB, 5_050).status).toBe('unverified');
    expect(getCapability('GetContacts', targetA, 5_100).status).toBe('unverified');
  });

  it('uses supported shaped evidence for aggregate status and discovery', async () => {
    __resetCapabilityCacheForTests();
    const read = vi.fn().mockResolvedValue({ result: 'success' });
    await probeCapability(
      'GetClients',
      {
        read,
        isAllowlisted: () => true,
        target: targetA,
        evidenceTtlMs: 1_000,
        now: () => 7_000,
      },
      { status: 'Active' }
    );

    expect(getCapability('GetClients', targetA, 7_100).status).toBe('supported');
    const discovery = buildCapabilityDiscovery(evidenceCatalog, {
      operationAllowed: () => true,
      allowedCapabilityIds: new Set(['list_clients']),
      evidenceTarget: targetA,
      availableProtocolFeatures: ['tools'],
      nowMs: 7_100,
    });
    expect(discovery.operations.find(({ id }) => id === evidenceReadDefinition.id)).toMatchObject({
      capability: {
        effective: true,
        observed: [{ action: 'GetClients', status: 'supported', source: 'read_probe' }],
      },
    });
  });

  it('resolves conflicting probe shapes conservatively and deterministically', () => {
    const buildConflict = (reverse: boolean) => {
      __resetCapabilityEvidenceForTests();
      const records = [
        {
          probeParams: { status: 'Active', limitnum: 1 },
          status: 'supported' as const,
          failureClass: 'none' as const,
        },
        {
          probeParams: { status: 'Closed', limitnum: 1 },
          status: 'unsupported' as const,
          failureClass: 'unsupported_action' as const,
        },
      ];
      for (const record of reverse ? records.reverse() : records) {
        recordCapabilityEvidence({
          target: targetA,
          action: 'GetClients',
          ...record,
          source: 'read_probe',
          observedAtMs: 8_000,
          ttlMs: 1_000,
        });
      }
      return buildCapabilityDiscovery(evidenceCatalog, {
        operationAllowed: () => true,
        allowedCapabilityIds: new Set(['list_clients']),
        evidenceTarget: targetA,
        availableProtocolFeatures: ['tools'],
        nowMs: 8_100,
      });
    };

    const forward = buildConflict(false);
    const reverse = buildConflict(true);
    expect(forward).toEqual(reverse);
    expect(getCapability('GetClients', targetA, 8_100).status).toBe('unsupported');
    expect(
      getCapability('GetClients', targetA, 8_100, { status: 'Active', limitnum: 1 }).status
    ).toBe('supported');
    expect(
      getCapability('GetClients', targetA, 8_100, { status: 'Closed', limitnum: 1 }).status
    ).toBe('unsupported');
    expect(forward.operations.find(({ id }) => id === evidenceReadDefinition.id)).toMatchObject({
      capability: {
        effective: false,
        observed: [
          { action: 'GetClients', status: 'unsupported' },
          { action: 'GetClients', status: 'supported' },
        ],
      },
    });
  });

  it('requires operator evidence for external-only declarations', async () => {
    __resetCapabilityCacheForTests();
    const read = vi.fn();
    const result = await probeCapability('GetUsers', {
      read,
      isAllowlisted: () => true,
      target: targetA,
      now: () => 6_000,
    });
    expect(result.status).toBe('unverified');
    expect(read).not.toHaveBeenCalled();
  });
});
