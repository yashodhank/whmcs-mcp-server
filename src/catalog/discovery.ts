import { createHash } from 'node:crypto';
import { CAPABILITY_REGISTRY, getCapability } from '../governance/capabilities.js';
import {
  listCapabilityEvidence,
  type CapabilityEvidenceTarget,
} from '../governance/capabilityEvidence.js';
import type { OperationCatalog } from './registry.js';

export interface CapabilityDiscoveryOptions {
  readonly operationAllowed: (publicName: string) => boolean;
  /** Omit for conservative discovery when no request-bound consumer exists. */
  readonly allowedCapabilityIds?: ReadonlySet<string>;
  readonly evidenceTarget?: CapabilityEvidenceTarget;
  readonly nowMs?: number;
  readonly availableProtocolFeatures: readonly string[];
}

interface DiscoveryPayloadWithoutEtag {
  readonly schema_version: 2;
  readonly catalog_version: number;
  readonly protocol_features: {
    readonly available: readonly string[];
    readonly modern_cache_hints: false;
  };
  readonly operations: readonly Record<string, unknown>[];
}

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

export function buildCapabilityDiscovery(
  catalog: OperationCatalog,
  options: CapabilityDiscoveryOptions
): DiscoveryPayloadWithoutEtag & { readonly etag: string } {
  const nowMs = options.nowMs ?? Date.now();
  const evidence =
    options.evidenceTarget === undefined
      ? []
      : listCapabilityEvidence(options.evidenceTarget, nowMs);

  const operations = catalog
    .definitions()
    .filter((definition) => options.operationAllowed(definition.publicName))
    .filter((definition) => {
      if (!definition.auth.consumerFiltered || definition.whmcsActions.length === 0) return true;
      if (options.allowedCapabilityIds === undefined) return false;
      const allowedCapabilityIds = options.allowedCapabilityIds;
      return definition.whmcsActions.every((action) => {
        if (!Object.hasOwn(CAPABILITY_REGISTRY, action)) return false;
        return allowedCapabilityIds.has(CAPABILITY_REGISTRY[action].capability);
      });
    })
    .map((definition) => {
      const actionStatuses = definition.whmcsActions.map((action) =>
        getCapability(action, options.evidenceTarget, nowMs)
      );
      const operationEvidence = evidence
        .filter((item) => definition.whmcsActions.includes(item.action))
        .map((item) => ({
          action: item.action,
          status: item.status,
          source: item.source,
          observed_at: item.observedAt,
          expires_at: item.expiresAt,
          failure_class: item.failureClass,
        }));
      return {
        id: definition.id,
        name: definition.publicName,
        domain: definition.domain,
        effects: definition.effects,
        risk_tier: definition.riskTier,
        cost: definition.cost,
        pagination: definition.pagination,
        prerequisites: definition.prerequisites,
        fallbacks: definition.fallbacks,
        protocol_features: definition.protocolFeatures,
        capability: {
          declared: true,
          configured: true,
          observed: definition.whmcsActions.length === 0 ? 'not_required' : operationEvidence,
          effective:
            definition.whmcsActions.length === 0 ||
            actionStatuses.every((status) => status.status === 'supported'),
        },
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const payload: DiscoveryPayloadWithoutEtag = {
    schema_version: 2,
    catalog_version: catalog.version,
    protocol_features: {
      available: [...options.availableProtocolFeatures].sort(),
      modern_cache_hints: false,
    },
    operations,
  };
  const etag = `sha256-${createHash('sha256')
    .update(JSON.stringify(stable(payload)))
    .digest('hex')}`;
  return { ...payload, etag };
}
