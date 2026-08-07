import type { OperationDefinition } from '../catalog/types.js';
import type { PlanningLatencyClass } from './types.js';

export function operationCallCost(operation: OperationDefinition): number {
  return operation.cost.maxWhmcsCalls;
}

export function latencyClassForCalls(calls: number): PlanningLatencyClass {
  if (calls === 0) return 'instant';
  if (calls === 1) return 'low';
  if (calls <= 4) return 'moderate';
  return 'high';
}
