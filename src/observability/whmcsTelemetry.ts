/**
 * Low-cardinality telemetry boundary for the WHMCS request pipeline.
 *
 * Implementations may bridge these events to OpenTelemetry, but this package
 * deliberately has no provider dependency. Events never contain credentials,
 * request parameters, response bodies, customer identifiers, or free-form
 * error messages.
 */

export type WhmcsActionClass = 'reference' | 'account' | 'invoice' | 'ticket' | 'probe' | 'other';

export type WhmcsTelemetryPhase =
  | 'queue'
  | 'transport'
  | 'retry'
  | 'repair'
  | 'cache'
  | 'coalesce'
  | 'complete';

export type WhmcsTelemetryOutcome =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'deadline'
  | 'hit'
  | 'miss'
  | 'joined'
  | 'started';

/**
 * UTF-8 size of a successful decoded transport payload, bucketed in KiB.
 *
 * `0` is exactly zero bytes; `1-10` is 1..10 KiB; `11-100` is
 * 10 KiB + 1 byte..100 KiB; and `101+` is greater than 100 KiB. `unknown`
 * is reserved for a value that cannot be deterministically serialized.
 */
export type WhmcsResponseSizeBucket = '0' | '1-10' | '11-100' | '101+' | 'unknown';

const TEN_KIB = 10 * 1024;
const ONE_HUNDRED_KIB = 100 * 1024;

/** Pure boundary helper; `byteLength` is measured in UTF-8 bytes. */
export function bucketWhmcsResponseSizeBytes(byteLength: number): WhmcsResponseSizeBucket {
  if (!Number.isFinite(byteLength)) return 'unknown';
  const bytes = Math.max(0, Math.floor(byteLength));
  if (bytes === 0) return '0';
  if (bytes <= TEN_KIB) return '1-10';
  if (bytes <= ONE_HUNDRED_KIB) return '11-100';
  return '101+';
}

/**
 * Measure only the successful response value. Strings retain their UTF-8 byte
 * length; other JSON values use deterministic compact JSON serialization.
 * Neither the value nor its serialization leaves this function.
 */
export function classifyWhmcsResponseSize(value: unknown): WhmcsResponseSizeBucket {
  try {
    if (value === undefined) return '0';
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return bucketWhmcsResponseSizeBytes(new TextEncoder().encode(serialized).byteLength);
  } catch {
    return 'unknown';
  }
}

export interface WhmcsTelemetryEvent {
  phase: WhmcsTelemetryPhase;
  outcome: WhmcsTelemetryOutcome;
  effect: 'read' | 'write';
  actionClass: WhmcsActionClass;
  durationMs?: number;
  queueDepth?: number;
  attempt?: number;
  sizeBucket?: WhmcsResponseSizeBucket;
}

export interface WhmcsTelemetry {
  record(event: Readonly<WhmcsTelemetryEvent>): void;
}

export const NOOP_WHMCS_TELEMETRY: WhmcsTelemetry = {
  record: () => undefined,
};

/** A test/adapter utility that keeps only the already-redacted event shape. */
export class InMemoryWhmcsTelemetry implements WhmcsTelemetry {
  readonly events: WhmcsTelemetryEvent[] = [];

  record(event: Readonly<WhmcsTelemetryEvent>): void {
    this.events.push({ ...event });
  }
}

export function classifyWhmcsAction(action: string): WhmcsActionClass {
  if (
    /^(GetProducts|GetCurrencies|GetRegistrars|GetSupportDepartments|GetTLDPricing)$/i.test(action)
  ) {
    return 'reference';
  }
  if (/invoice|transaction|credit/i.test(action)) return 'invoice';
  if (/ticket|support/i.test(action)) return 'ticket';
  if (/client|contact|service|hosting|domain|order/i.test(action)) return 'account';
  if (/admin|stats|health|version/i.test(action)) return 'probe';
  return 'other';
}
