import { createHash } from 'node:crypto';

export interface PlanningPolicyFingerprintInput {
  readonly consumerId: string;
  readonly allowedCapabilityIds: Iterable<string>;
  readonly allowedWriteScopes: Iterable<string>;
  readonly allowedContracts: Iterable<string>;
  readonly allowedClientIds: Iterable<number> | null;
  readonly writeCapability: string;
}

/**
 * Bind a plan to the effective transport-authenticated grant set without
 * persisting a consumer id, bearer token, or raw policy document in PlanIR.
 */
export function fingerprintPlanningPolicy(input: PlanningPolicyFingerprintInput): string {
  const sortedStrings = (items: Iterable<string>) => [...new Set(items)].sort();
  const payload = {
    consumer_id: input.consumerId,
    allowed_capability_ids: sortedStrings(input.allowedCapabilityIds),
    allowed_write_scopes: sortedStrings(input.allowedWriteScopes),
    allowed_contracts: sortedStrings(input.allowedContracts),
    allowed_client_ids:
      input.allowedClientIds === null
        ? null
        : [...new Set(input.allowedClientIds)].sort((left, right) => left - right),
    write_capability: input.writeCapability,
  };
  return `sha256-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
