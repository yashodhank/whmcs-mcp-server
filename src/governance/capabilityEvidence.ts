import { createHash } from 'node:crypto';
import type { CapabilityStatusValue } from './types.js';

export interface CapabilityEvidenceTarget {
  /** Opaque installation fingerprint. Never store the WHMCS URL or credentials here. */
  readonly installationId: string;
  /** Opaque fingerprint of policy/configuration that affects availability. */
  readonly configFingerprint: string;
  readonly catalogVersion: number;
}

export type CapabilityEvidenceSource = 'read_probe' | 'operator_external' | 'policy';
export type CapabilityFailureClass =
  | 'none'
  | 'access_denied'
  | 'unsupported_action'
  | 'transport_or_other'
  | 'policy_denied';

export interface CapabilityEvidence {
  readonly installationId: string;
  readonly configFingerprint: string;
  readonly catalogVersion: number;
  readonly action: string;
  readonly probeShapeHash: string;
  readonly status: CapabilityStatusValue;
  readonly source: CapabilityEvidenceSource;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly failureClass: CapabilityFailureClass;
  readonly note?: string;
}

export interface RecordCapabilityEvidenceInput {
  readonly target: CapabilityEvidenceTarget;
  readonly action: string;
  readonly probeParams?: Readonly<Record<string, unknown>>;
  readonly status: CapabilityStatusValue;
  readonly source: CapabilityEvidenceSource;
  readonly observedAtMs: number;
  readonly ttlMs: number;
  readonly failureClass: CapabilityFailureClass;
  readonly note?: string;
}

export const DEFAULT_CAPABILITY_EVIDENCE_TARGET: CapabilityEvidenceTarget = Object.freeze({
  installationId: 'compatibility-process',
  configFingerprint: 'compatibility-default',
  catalogVersion: 2,
});

export function fingerprintCapabilityEvidenceTarget(input: {
  readonly installationIdentity: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly catalogVersion: number;
}): CapabilityEvidenceTarget {
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  return Object.freeze({
    installationId: digest(input.installationIdentity.trim()),
    configFingerprint: digest(JSON.stringify(stable(input.configuration))),
    catalogVersion: input.catalogVersion,
  });
}

const evidenceStore = new Map<string, CapabilityEvidence>();

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

export function capabilityProbeShapeHash(
  params: Readonly<Record<string, unknown>> = { limitnum: 1 }
): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(params)))
    .digest('hex');
}

function keyFor(
  target: CapabilityEvidenceTarget,
  action: string,
  probeParams?: Readonly<Record<string, unknown>>
): string {
  return [
    target.installationId,
    target.configFingerprint,
    String(target.catalogVersion),
    action,
    capabilityProbeShapeHash(probeParams),
  ].join('\u0000');
}

function validateTarget(target: CapabilityEvidenceTarget): void {
  if (target.installationId.trim().length === 0 || target.configFingerprint.trim().length === 0) {
    throw new Error('Capability evidence target fingerprints must not be empty');
  }
  if (!Number.isInteger(target.catalogVersion) || target.catalogVersion < 1) {
    throw new Error('Capability evidence catalogVersion must be a positive integer');
  }
}

export function recordCapabilityEvidence(input: RecordCapabilityEvidenceInput): CapabilityEvidence {
  validateTarget(input.target);
  if (input.action.trim().length === 0) throw new Error('Capability evidence action is required');
  if (!Number.isFinite(input.observedAtMs) || input.observedAtMs < 0) {
    throw new Error('Capability evidence observedAtMs must be a valid timestamp');
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error('Capability evidence ttlMs must be positive');
  }
  const evidence: CapabilityEvidence = Object.freeze({
    installationId: input.target.installationId,
    configFingerprint: input.target.configFingerprint,
    catalogVersion: input.target.catalogVersion,
    action: input.action,
    probeShapeHash: capabilityProbeShapeHash(input.probeParams),
    status: input.status,
    source: input.source,
    observedAt: new Date(input.observedAtMs).toISOString(),
    expiresAt: new Date(input.observedAtMs + input.ttlMs).toISOString(),
    failureClass: input.failureClass,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  evidenceStore.set(keyFor(input.target, input.action, input.probeParams), evidence);
  return evidence;
}

export function getCapabilityEvidence(
  target: CapabilityEvidenceTarget,
  action: string,
  nowMs = Date.now(),
  probeParams?: Readonly<Record<string, unknown>>
): CapabilityEvidence | undefined {
  validateTarget(target);
  const key = keyFor(target, action, probeParams);
  const evidence = evidenceStore.get(key);
  if (evidence === undefined) return undefined;
  if (Date.parse(evidence.expiresAt) <= nowMs) {
    evidenceStore.delete(key);
    return undefined;
  }
  return evidence;
}

export function listCapabilityEvidence(
  target: CapabilityEvidenceTarget,
  nowMs = Date.now()
): readonly CapabilityEvidence[] {
  validateTarget(target);
  const evidence: CapabilityEvidence[] = [];
  for (const [key, item] of evidenceStore) {
    if (Date.parse(item.expiresAt) <= nowMs) {
      evidenceStore.delete(key);
      continue;
    }
    if (
      item.installationId === target.installationId &&
      item.configFingerprint === target.configFingerprint &&
      item.catalogVersion === target.catalogVersion
    ) {
      evidence.push(item);
    }
  }
  return evidence.sort((left, right) =>
    `${left.action}:${left.probeShapeHash}`.localeCompare(`${right.action}:${right.probeShapeHash}`)
  );
}

export function __resetCapabilityEvidenceForTests(): void {
  evidenceStore.clear();
}
