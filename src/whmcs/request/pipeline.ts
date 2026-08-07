import type { AppConfig } from '../../config.js';
import type { Logger } from '../../logging.js';
import {
  classifyWhmcsAction,
  NOOP_WHMCS_TELEMETRY,
  type WhmcsTelemetry,
} from '../../observability/whmcsTelemetry.js';
import { attemptIpAllowlistHeal } from '../ipAllowlistHeal.js';
import { classifyWhmcsError, type ClassifiedWhmcsError } from './classifier.js';
import { decodeWhmcsResponse } from './decoder.js';
import { encodeWhmcsRequest } from './encoder.js';
import { WhmcsBusinessError, WhmcsTransportError } from './errors.js';
import {
  DEFAULT_READ_ATTEMPT_BUDGET,
  getBackoffDelay,
  shouldRetryRead,
  sleepWithSignal,
} from './retryPolicy.js';
import { AxiosWhmcsTransport } from './transport.js';
import type {
  WhmcsRequestContext,
  WhmcsRequestEffect,
  WhmcsRequestOptions,
  WhmcsTransport,
} from './types.js';

export interface WhmcsPipelineOptions extends WhmcsRequestOptions {
  normalize?: boolean;
  allowRetry?: boolean;
}

export interface WhmcsRequestPipelineDependencies {
  transport?: WhmcsTransport;
  telemetry?: WhmcsTelemetry;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  heal?: typeof attemptIpAllowlistHeal;
  now?: () => number;
}

function requestDeadline(options: WhmcsRequestOptions, now: number): number | undefined {
  const relative =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
      ? now + Math.max(0, options.timeoutMs)
      : undefined;
  if (relative === undefined) return options.deadlineAt;
  if (options.deadlineAt === undefined) return relative;
  return Math.min(relative, options.deadlineAt);
}

function scopedAbortSignal(
  source: AbortSignal | undefined,
  deadlineAt: number | undefined,
  now: () => number
): { signal?: AbortSignal; cleanup: () => void; isDeadline: () => boolean } {
  if (!source && deadlineAt === undefined) {
    return {
      signal: undefined,
      cleanup: () => undefined,
      isDeadline: () => false,
    };
  }
  const controller = new AbortController();
  let deadline = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forwardAbort = (): void => {
    controller.abort(source?.reason);
  };
  if (source?.aborted) forwardAbort();
  else source?.addEventListener('abort', forwardAbort, { once: true });
  if (deadlineAt !== undefined) {
    const remaining = deadlineAt - now();
    const expire = (): void => {
      deadline = true;
      const error = new Error('WHMCS request deadline exceeded');
      error.name = 'TimeoutError';
      controller.abort(error);
    };
    if (remaining <= 0) expire();
    else timer = setTimeout(expire, remaining);
  }
  return {
    signal: controller.signal,
    isDeadline: () => deadline,
    cleanup: () => {
      source?.removeEventListener('abort', forwardAbort);
      if (timer) clearTimeout(timer);
    },
  };
}

function asTransportError(
  classified: Readonly<ClassifiedWhmcsError>,
  action: string,
  logger: Logger,
  healNote: string | undefined
): WhmcsTransportError {
  const axiosError = classified.axiosError;
  if (axiosError?.response) {
    const status = axiosError.response.status;
    if (status >= 500) {
      // Deliberately omit response bodies: PHP errors can contain customer data
      // or echoed request material. The status and action class are sufficient.
      logger.warn('WHMCS HTTP 5xx response', { action, status });
    }
    if (status === 403) {
      const hint =
        'HTTP 403 from WHMCS — one of: (1) caller IP not in the WHMCS API allowlist ' +
        '(APIAllowedIPs); (2) an edge/WAF/proxy block on the client request/connection ' +
        '(verify by curling the same endpoint+IP — if curl works but this client gets 403, ' +
        'it is a WAF/connection block, NOT an IP or credential issue); (3) a permission/role ' +
        'ACL on the credential. ' +
        (healNote ? `Auto-heal: ${healNote}. ` : '') +
        'See docs/runbooks/api-connectivity-troubleshooting.md';
      return new WhmcsTransportError(`WHMCS HTTP error: 403 — ${hint}`, 403);
    }
    return new WhmcsTransportError(`WHMCS HTTP error: ${status}`, status);
  }
  if (axiosError?.request) {
    const isTimeout = axiosError.code === 'ECONNABORTED';
    return new WhmcsTransportError(
      isTimeout
        ? 'WHMCS request timed out after 30s — host slow or unreachable'
        : `WHMCS connection error: ${axiosError.message}`
    );
  }
  return new WhmcsTransportError(`Unexpected error calling WHMCS: ${classified.error.message}`);
}

/** Typed orchestration of encoding, transport, decoding, retry, and repair stages. */
export class WhmcsRequestPipeline {
  private readonly transport: WhmcsTransport;
  private readonly telemetry: WhmcsTelemetry;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly heal: typeof attemptIpAllowlistHeal;
  private readonly now: () => number;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly endpoint: string,
    dependencies: WhmcsRequestPipelineDependencies = {}
  ) {
    this.transport = dependencies.transport ?? new AxiosWhmcsTransport(endpoint);
    this.telemetry = dependencies.telemetry ?? NOOP_WHMCS_TELEMETRY;
    this.random = dependencies.random ?? Math.random;
    this.sleep = dependencies.sleep ?? sleepWithSignal;
    this.heal = dependencies.heal ?? attemptIpAllowlistHeal;
    this.now = dependencies.now ?? Date.now;
  }

  async execute<T>(
    action: string,
    normalizedParams: Readonly<Record<string, unknown>>,
    effect: WhmcsRequestEffect,
    options: WhmcsPipelineOptions = {}
  ): Promise<T> {
    const startedAt = this.now();
    const deadlineAt = requestDeadline(options, startedAt);
    const scoped = scopedAbortSignal(options.signal, deadlineAt, this.now);
    const actionClass = classifyWhmcsAction(action);
    const context: WhmcsRequestContext = {
      action,
      normalizedParams,
      effect,
      requestId: options.requestId ?? `local-${startedAt}`,
      deadlineAt,
      signal: scoped.signal,
      attemptBudget: effect === 'read' ? DEFAULT_READ_ATTEMPT_BUDGET : 1,
      telemetry: { actionClass, effect },
    };
    const body = encodeWhmcsRequest(action, normalizedParams, {
      identifier: this.config.WHMCS_IDENTIFIER,
      secret: this.config.WHMCS_SECRET,
      accessKey: this.config.WHMCS_ACCESS_KEY,
    });
    const retryEnabled = effect === 'read' && (options.allowRetry ?? true);
    let transportAttempt = 0;
    let ordinaryAttempt = 1;
    let repairAttempts = 0;
    let mutationDispatched = false;
    let healAttempted = false;
    let connectionResetAttempted = false;
    let healNote: string | undefined;
    let completionOutcome: 'success' | 'failure' | 'cancelled' | 'deadline' = 'failure';

    try {
      // Match the legacy call-level log cardinality: one record for one logical
      // pipeline execution, regardless of retries. Cache hits and coalesced
      // joiners never enter this boundary.
      this.logger.logWhmcsCall(
        action,
        normalizedParams as Record<string, unknown>,
        effect === 'write'
      );
      for (;;) {
        if (context.signal?.aborted) {
          throw context.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        transportAttempt += 1;
        const transportStarted = this.now();
        try {
          if (effect === 'write') mutationDispatched = true;
          const response = await this.transport.post(body, context.signal);
          this.telemetry.record({
            phase: 'transport',
            outcome: 'success',
            effect,
            actionClass,
            attempt: transportAttempt,
            durationMs: this.now() - transportStarted,
          });
          const decoded = decodeWhmcsResponse(
            response.status,
            response.data,
            action,
            options.normalize ?? true,
            this.endpoint
          );
          completionOutcome = 'success';
          return decoded as T;
        } catch (error) {
          if (error instanceof WhmcsBusinessError) throw error;
          const classified = classifyWhmcsError(error);
          this.telemetry.record({
            phase: 'transport',
            outcome: context.signal?.aborted || classified.cancelled ? 'cancelled' : 'failure',
            effect,
            actionClass,
            attempt: transportAttempt,
            durationMs: this.now() - transportStarted,
          });

          if (context.signal?.aborted || classified.cancelled) {
            const message = scoped.isDeadline()
              ? 'WHMCS request deadline exceeded'
              : effect === 'write' && mutationDispatched
                ? 'WHMCS mutation outcome may be unknown: request was cancelled after dispatch'
                : 'WHMCS request cancelled';
            throw new WhmcsTransportError(
              message,
              undefined,
              effect === 'write' && mutationDispatched
            );
          }

          // Repair may add one immediate read attempt, but never resets or
          // replenishes the independent 429/5xx/network retry budget.
          if (effect === 'read' && classified.statusCode === 403) {
            const isInvalidIp = Boolean(classified.whmcsMessage?.match(/invalid\s+ip/i));
            if (this.config.WHMCS_AUTO_IP_HEAL && !healAttempted && isInvalidIp) {
              healAttempted = true;
              const healed = await this.heal(this.config, this.logger, classified.reportedIp);
              if (healed) {
                repairAttempts += 1;
                this.telemetry.record({
                  phase: 'repair',
                  outcome: 'success',
                  effect,
                  actionClass,
                  attempt: repairAttempts,
                });
                this.logger.warn('WHMCS 403 (Invalid IP): allowlist updated, retrying call once', {
                  action,
                  reportedIp: classified.reportedIp,
                });
                continue;
              }
              healNote =
                'auto-heal ran but did not resolve the allowlist (check SSH identity / updater logs)';
            } else if (isInvalidIp && !this.config.WHMCS_AUTO_IP_HEAL) {
              healNote = 'looks like an IP-allowlist rejection but WHMCS_AUTO_IP_HEAL is off';
            } else if (!classified.hasResponseBody && !connectionResetAttempted) {
              connectionResetAttempted = true;
              repairAttempts += 1;
              healNote =
                'edge/WAF 403 (no WHMCS body): reset the keep-alive connection and retried once';
              this.logger.warn(
                'WHMCS 403 with no body (edge/WAF): resetting connection and retrying once',
                { action }
              );
              this.transport.resetConnections();
              continue;
            } else if (classified.whmcsMessage) {
              healNote =
                'not an IP-allowlist rejection (permission/auth) — auto-heal not applicable';
              this.logger.warn('WHMCS 403 not auto-healed', {
                action,
                message: classified.whmcsMessage,
                healNote,
              });
            } else {
              healNote =
                'edge/WAF 403 persisted after a fresh-connection retry — likely a real WAF/fingerprint block or rate limit (verify: curl the same endpoint+IP; if curl works, it is a WAF/fingerprint block)';
              this.logger.warn('WHMCS 403 persisted after connection reset', { action });
            }
          }

          if (
            !shouldRetryRead(
              classified,
              effect,
              ordinaryAttempt,
              context.attemptBudget,
              retryEnabled
            )
          ) {
            throw asTransportError(classified, action, this.logger, healNote);
          }

          // A repair transport is an extra attempt. A retryable failure on that
          // extra attempt starts/resumes the independent ordinary retry state;
          // it neither consumes nor replenishes that budget.
          const completedOrdinaryAttempt = ordinaryAttempt;
          ordinaryAttempt += 1;
          const delay = getBackoffDelay(completedOrdinaryAttempt, this.random);
          this.telemetry.record({
            phase: 'retry',
            outcome: 'started',
            effect,
            actionClass,
            attempt: ordinaryAttempt,
            durationMs: delay,
          });
          this.logger.warn('WHMCS call failed, retrying...', {
            action,
            attempt: completedOrdinaryAttempt,
            maxAttempts: context.attemptBudget,
            statusCode: classified.statusCode,
            delayMs: Math.round(delay),
            error: classified.error.message,
          });
          await this.sleep(delay, context.signal);
        }
      }
    } catch (error) {
      completionOutcome = scoped.isDeadline()
        ? 'deadline'
        : context.signal?.aborted
          ? 'cancelled'
          : 'failure';
      if (
        context.signal?.aborted &&
        !(error instanceof WhmcsTransportError) &&
        !(error instanceof WhmcsBusinessError)
      ) {
        const message = scoped.isDeadline()
          ? 'WHMCS request deadline exceeded'
          : effect === 'write' && mutationDispatched
            ? 'WHMCS mutation outcome may be unknown: request was cancelled after dispatch'
            : 'WHMCS request cancelled';
        throw new WhmcsTransportError(message, undefined, effect === 'write' && mutationDispatched);
      }
      throw error;
    } finally {
      scoped.cleanup();
      this.telemetry.record({
        phase: 'complete',
        outcome: completionOutcome,
        effect,
        actionClass,
        durationMs: this.now() - startedAt,
        attempt: transportAttempt,
      });
    }
  }
}
