/**
 * Backward-compatible facade over the typed WHMCS request pipeline.
 *
 * Encoding, transport, decoding, classification, retries, repairs, deadlines,
 * scheduling, coalescing, cache policy, and telemetry live in independently
 * tested stages under `src/whmcs/request/` and adjacent coordinator modules.
 */

import { getWhmcsApiEndpoint, type AppConfig, type McpMode } from '../config.js';
import type { Logger } from '../logging.js';
import { getCurrentRequestContext } from '../mcp/requestContext.js';
import {
  classifyWhmcsAction,
  NOOP_WHMCS_TELEMETRY,
  type WhmcsTelemetry,
} from '../observability/whmcsTelemetry.js';
import { assertReadAction } from './actionPolicy.js';
import {
  buildReadCoordinationKey,
  mutationInvalidationTags,
  resolveReadCachePolicy,
} from './cachePolicy.js';
import { ReadCache } from './readCache.js';
import { ReadCoordinator } from './readCoordinator.js';
import { normalizeWhmcsParams } from './request/encoder.js';
import { WhmcsBusinessError } from './request/errors.js';
import {
  WhmcsRequestPipeline,
  type WhmcsPipelineOptions,
  type WhmcsRequestPipelineDependencies,
} from './request/pipeline.js';
import type { WhmcsRequestOptions } from './request/types.js';

export { WhmcsBusinessError, WhmcsTransportError } from './request/errors.js';
export type { WhmcsRequestOptions } from './request/types.js';

export interface WhmcsCallOptions extends WhmcsPipelineOptions {
  /** Whether this is a mutating operation. */
  isMutating?: boolean;
  /** Simulated response for simulate mode. */
  simulatedResponse?: unknown;
}

export interface WhmcsClientDependencies extends WhmcsRequestPipelineDependencies {
  telemetry?: WhmcsTelemetry;
  maxReadConcurrency?: number;
  coalescingEnabled?: boolean;
}

export interface WhmcsClientDiagnostics {
  cache: ReturnType<WhmcsClient['cacheMetricsSnapshot']>;
  coordinator: { active: number; queued: number; inflight: number };
}

function mergeSignals(explicit: AbortSignal | undefined, inherited: AbortSignal): AbortSignal {
  if (explicit === undefined || explicit === inherited) return inherited;
  return AbortSignal.any([explicit, inherited]);
}

function withCurrentRequestContext<T extends WhmcsRequestOptions>(
  options: T,
  effect: 'read' | 'write'
): T {
  const context = getCurrentRequestContext();
  if (context === undefined) return options;
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, context.deadline);
  return {
    ...options,
    signal: mergeSignals(options.signal, context.signal),
    deadlineAt,
    requestId: options.requestId ?? context.requestId,
    ...(effect === 'read'
      ? {
          consumerKey: options.consumerKey ?? context.identity.consumerId,
          rawDataScope: options.rawDataScope ?? `consumer:${context.identity.consumerId}`,
        }
      : {}),
  };
}

export class WhmcsClient {
  private readonly mode: McpMode;
  private readonly readCache: ReadCache;
  private readonly cacheableActions: ReadonlySet<string>;
  private readonly coordinator: ReadCoordinator;
  private readonly pipeline: WhmcsRequestPipeline;
  private readonly telemetry: WhmcsTelemetry;
  private readonly endpoint: string;
  private readonly coalescingEnabled: boolean;
  private cacheEpoch = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    dependencies: WhmcsClientDependencies = {}
  ) {
    this.mode = config.MCP_MODE;
    this.endpoint = getWhmcsApiEndpoint();
    this.telemetry = dependencies.telemetry ?? NOOP_WHMCS_TELEMETRY;
    const cacheActions = Reflect.get(config, 'MCP_READ_CACHE_ACTIONS') as string[] | undefined;
    const cacheTtl = Reflect.get(config, 'MCP_READ_CACHE_TTL_MS') as number | undefined;
    const coalescingEnabled = Reflect.get(config, 'MCP_READ_COALESCE_ENABLED') as
      | boolean
      | undefined;
    const maxReadConcurrency = Reflect.get(config, 'MCP_READ_MAX_CONCURRENCY') as
      | number
      | undefined;
    this.cacheableActions = new Set(cacheActions ?? []);
    this.readCache = new ReadCache({
      ttlMs: cacheTtl ?? 0,
      cacheableActions: [...this.cacheableActions],
    });
    this.coalescingEnabled = dependencies.coalescingEnabled ?? coalescingEnabled ?? false;
    this.coordinator = new ReadCoordinator({
      maxConcurrency: dependencies.maxReadConcurrency ?? maxReadConcurrency ?? 8,
      telemetry: this.telemetry,
    });
    this.pipeline = new WhmcsRequestPipeline(config, logger, this.endpoint, dependencies);
  }

  getMode(): McpMode {
    return this.mode;
  }

  isReadOnly(): boolean {
    return this.mode === 'read_only';
  }

  isSimulate(): boolean {
    return this.mode === 'simulate';
  }

  async call<T>(
    action: string,
    params: Record<string, unknown> = {},
    options: WhmcsCallOptions = {}
  ): Promise<T> {
    const { isMutating = false, simulatedResponse, ...callerOptions } = options;
    const pipelineOptions = withCurrentRequestContext(callerOptions, isMutating ? 'write' : 'read');
    if (this.mode === 'simulate' && isMutating) {
      this.logger.logWhmcsCall(action, params, true);
      this.logger.info('Simulated WHMCS call (not executed)', {
        action,
        params,
        mode: 'simulate',
      });
      if (simulatedResponse !== undefined) return simulatedResponse as T;
      return { result: 'success', message: `Simulated ${action} call` } as T;
    }
    return this.pipeline.execute<T>(
      action,
      normalizeWhmcsParams(params),
      isMutating ? 'write' : 'read',
      pipelineOptions
    );
  }

  async read<T>(
    action: string,
    params: Record<string, unknown> = {},
    options: WhmcsRequestOptions = {}
  ): Promise<T> {
    const effectiveOptions = withCurrentRequestContext(options, 'read');
    // The policy guard must precede every acceleration layer.
    assertReadAction(action);
    const normalizedParams = normalizeWhmcsParams(params);
    const policy = resolveReadCachePolicy(
      action,
      normalizedParams,
      this.cacheableActions,
      (Reflect.get(this.config, 'MCP_READ_CACHE_TTL_MS') as number | undefined) ?? 0
    );
    const actionClass = classifyWhmcsAction(action);
    const cacheEpoch = this.cacheEpoch;

    if (!effectiveOptions.bypassCache && policy.cacheable) {
      const cached = this.readCache.get(action, normalizedParams);
      this.telemetry.record({
        phase: 'cache',
        outcome: cached === undefined ? 'miss' : 'hit',
        effect: 'read',
        actionClass,
      });
      if (cached !== undefined) return cached as T;
    }

    const deadlineAt =
      effectiveOptions.timeoutMs !== undefined
        ? Math.min(
            effectiveOptions.deadlineAt ?? Infinity,
            Date.now() + Math.max(0, effectiveOptions.timeoutMs)
          )
        : effectiveOptions.deadlineAt;
    const key = buildReadCoordinationKey(
      this.endpoint,
      action,
      normalizedParams,
      policy.version,
      effectiveOptions.rawDataScope ?? 'process'
    );
    const result = await this.coordinator.run<T>(
      (signal) =>
        this.pipeline.execute<T>(action, normalizedParams, 'read', {
          ...effectiveOptions,
          timeoutMs: undefined,
          deadlineAt: undefined,
          signal,
        }),
      {
        key,
        actionClass,
        consumerKey: effectiveOptions.consumerKey,
        signal: effectiveOptions.signal,
        deadlineAt,
        coalesce:
          this.coalescingEnabled && policy.coalescible && !effectiveOptions.bypassCoalescing,
      }
    );
    if (!effectiveOptions.bypassCache && policy.cacheable && cacheEpoch === this.cacheEpoch) {
      this.readCache.set(action, normalizedParams, result, policy.tags);
    }
    return result;
  }

  clearReadCache(): void {
    this.cacheEpoch += 1;
    this.readCache.clear();
  }

  async mutate<T>(
    action: string,
    params: Record<string, unknown> = {},
    simulatedResponse?: T,
    options: WhmcsRequestOptions = {}
  ): Promise<T> {
    if (this.mode === 'read_only') {
      throw new WhmcsBusinessError('Operation not allowed in read_only mode', 'MODE_RESTRICTED');
    }
    const result = await this.call<T>(action, params, {
      ...options,
      isMutating: true,
      allowRetry: false,
      simulatedResponse,
    });
    // A successful write invalidates proven entity tags. Unknown mutations
    // conservatively clear only this process-local read cache.
    const tags = mutationInvalidationTags(action, normalizeWhmcsParams(params));
    this.cacheEpoch += 1;
    if (tags) this.readCache.invalidateTags(tags);
    else this.readCache.clear();
    return result;
  }

  private cacheMetricsSnapshot() {
    return this.readCache.metrics;
  }

  getDiagnostics(): WhmcsClientDiagnostics {
    return {
      cache: this.cacheMetricsSnapshot(),
      coordinator: {
        active: this.coordinator.activeCount,
        queued: this.coordinator.queued,
        inflight: this.coordinator.inflightCount,
      },
    };
  }
}
