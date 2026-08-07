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

export interface WhmcsTelemetryEvent {
  phase: WhmcsTelemetryPhase;
  outcome: WhmcsTelemetryOutcome;
  effect: 'read' | 'write';
  actionClass: WhmcsActionClass;
  durationMs?: number;
  queueDepth?: number;
  attempt?: number;
  sizeBucket?: '0' | '1-10' | '11-100' | '101+';
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
