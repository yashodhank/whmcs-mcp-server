import type { OperationEffect, OperationRiskTier } from '../catalog/types.js';
import type { PlanningExecutionMode } from './types.js';

const RISK_ORDER: Readonly<Record<OperationRiskTier, number>> = Object.freeze({
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
});

export function compareRisk(left: OperationRiskTier, right: OperationRiskTier): number {
  return RISK_ORDER[left] - RISK_ORDER[right];
}

export function modeAllowsEffect(mode: PlanningExecutionMode, effect: OperationEffect): boolean {
  if (mode === 'analyse') return effect === 'pure';
  if (mode === 'read_only') return effect === 'pure' || effect === 'read';
  return true;
}
