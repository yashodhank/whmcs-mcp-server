import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

export type OperationEffect = 'pure' | 'read' | 'draft' | 'write';
export type OperationRiskTier = 'none' | 'low' | 'medium' | 'high';

export interface CapabilityRequirement {
  readonly mode: 'none' | 'all';
  readonly probe: 'none' | 'read_safe' | 'external_only';
}

export interface GovernanceDescriptor {
  /** Canonical governed scope for writes. Null for operations with no scope. */
  readonly scope: string | null;
  /** How response data crosses the server-owned governance boundary. */
  readonly output: 'none' | 'sanitized' | 'canonical';
  /** True only when a handler can return fields obtained directly from WHMCS. */
  readonly rawWhmcsOutput: boolean;
}

export type CachePolicy =
  { readonly mode: 'none' } | { readonly mode: 'ttl'; readonly ttlMs: number };

export type CostHint =
  | {
      readonly kind: 'constant';
      readonly maxWhmcsCalls: number;
      readonly maxItems: number;
    }
  | {
      readonly kind: 'bounded_fanout';
      readonly maxWhmcsCalls: number;
      readonly maxItems: number;
      readonly maxConcurrency: number;
    };

export interface AuthDescriptor {
  readonly toolAuthRequired: boolean;
  /** Discovery must intersect the operation with consumer capability grants. */
  readonly consumerFiltered: boolean;
}

export interface PaginationDescriptor {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

export interface OperationAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface OperationDefinition {
  readonly id: string;
  readonly publicName: string;
  readonly domain: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly outputSchema: z.ZodRawShape | z.ZodType;
  readonly annotations: OperationAnnotations;
  readonly effects: OperationEffect;
  readonly riskTier: OperationRiskTier;
  readonly whmcsActions: readonly string[];
  readonly capability: CapabilityRequirement;
  readonly governance: GovernanceDescriptor;
  readonly cache: CachePolicy;
  readonly cost: CostHint;
  readonly auth: AuthDescriptor;
  readonly pagination: PaginationDescriptor | null;
  readonly prerequisites: readonly string[];
  readonly fallbacks: readonly string[];
  readonly protocolFeatures: readonly string[];
  /**
   * Runtime callback when this catalog entry is registered as an MCP tool.
   * Descriptor-only operations (for example governed write outcomes which may
   * only be drafted) deliberately omit it and can never be invoked directly.
   */
  readonly handler?: ToolCallback<z.ZodRawShape>;
  readonly version: number;
}

export interface CatalogMachineOperation {
  readonly id: string;
  readonly public_name: string;
  readonly domain: string;
  readonly description: string;
  readonly effects: OperationEffect;
  readonly risk_tier: OperationRiskTier;
  readonly whmcs_actions: readonly string[];
  readonly capability: CapabilityRequirement;
  readonly governance: GovernanceDescriptor;
  readonly cache: CachePolicy;
  readonly cost: CostHint;
  readonly auth: AuthDescriptor;
  readonly pagination: PaginationDescriptor | null;
  readonly prerequisites: readonly string[];
  readonly fallbacks: readonly string[];
  readonly protocol_features: readonly string[];
  readonly version: number;
}

export interface CatalogMachineView {
  readonly schema_version: 1;
  readonly catalog_version: number;
  readonly operations: readonly CatalogMachineOperation[];
}
