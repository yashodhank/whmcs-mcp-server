import type { WhmcsActionClass } from '../../observability/whmcsTelemetry.js';

export type WhmcsRequestEffect = 'read' | 'write';

export interface WhmcsRequestOptions {
  /** Caller-owned abort signal. Cancellation is never interpreted as rollback. */
  signal?: AbortSignal;
  /** Relative deadline measured from call entry. */
  timeoutMs?: number;
  /** Absolute deadline. When both are supplied, the earlier one wins. */
  deadlineAt?: number;
  /** Safe opaque identifier used only for local correlation. */
  requestId?: string;
  /** Separates in-flight work whose raw-data governance boundary differs. */
  rawDataScope?: string;
  /** Optional fairness lane. It is never emitted as telemetry. */
  consumerKey?: string;
  /** Explicitly bypass cache for a freshness-sensitive read. */
  bypassCache?: boolean;
  /** Explicitly bypass in-flight coalescing for a freshness-sensitive read. */
  bypassCoalescing?: boolean;
}

export interface WhmcsRequestContext {
  action: string;
  normalizedParams: Readonly<Record<string, unknown>>;
  effect: WhmcsRequestEffect;
  requestId: string;
  deadlineAt?: number;
  signal?: AbortSignal;
  attemptBudget: number;
  telemetry: Readonly<{
    actionClass: WhmcsActionClass;
    effect: WhmcsRequestEffect;
  }>;
}

export interface WhmcsTransportResponse {
  status: number;
  data: unknown;
}

export type WhmcsRequestResult<T> =
  | { ok: true; value: T; attempts: number }
  | {
      ok: false;
      kind: 'business' | 'http' | 'network' | 'cancelled' | 'deadline' | 'outcome_unknown';
      error: Error;
      attempts: number;
    };

export interface WhmcsTransport {
  post(body: URLSearchParams, signal?: AbortSignal): Promise<WhmcsTransportResponse>;
  resetConnections(): void;
}

export interface WhmcsCredentials {
  identifier: string;
  secret: string;
  accessKey?: string;
}
