/**
 * WHMCS API Client
 * 
 * Provides a type-safe wrapper around the WHMCS External API.
 * Handles authentication, error handling, response normalization, and mode enforcement.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { AppConfig, McpMode, getWhmcsApiEndpoint } from '../config.js';
import { Logger } from '../logging.js';
import { normalizeWhmcsResponse, boolToWhmcs } from './normalizers.js';
import { assertReadAction } from './actionPolicy.js';
import { ReadCache } from './readCache.js';

/**
 * WHMCS business-level error
 * Thrown when WHMCS API returns result='error'
 */
export class WhmcsBusinessError extends Error {
  code?: string | number;
  details?: unknown;

  constructor(message: string, code?: string | number, details?: unknown) {
    super(message);
    this.name = 'WhmcsBusinessError';
    this.code = code;
    this.details = details;
  }
}

/**
 * WHMCS protocol/transport error
 * Thrown when HTTP request fails or returns non-200
 */
export class WhmcsTransportError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'WhmcsTransportError';
    this.statusCode = statusCode;
  }
}

/**
 * Common WHMCS API response structure
 */
interface WhmcsResponse {
  result: 'success' | 'error';
  message?: string;
  [key: string]: unknown;
}

/**
 * Options for WHMCS API calls
 */
export interface WhmcsCallOptions {
  /** Whether this is a mutating operation */
  isMutating?: boolean;
  /** Enable response normalization for this action */
  normalize?: boolean;
  /** Simulated response for simulate mode */
  simulatedResponse?: unknown;
  /** Allow retries for this call (defaults to true for reads, false for mutates) */
  allowRetry?: boolean;
}

/**
 * Retry configuration constants
 */
const RETRY_CONFIG = {
  /** Maximum number of retry attempts */
  MAX_RETRIES: 3,
  /** Base delay in ms for exponential backoff */
  BASE_DELAY_MS: 1000,
  /** Maximum delay cap in ms */
  MAX_DELAY_MS: 10000,
  /** HTTP status codes that are retryable */
  RETRYABLE_STATUS_CODES: [500, 502, 503, 504, 429] as readonly number[],
};

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function getBackoffDelay(attempt: number): number {
  const exponentialDelay = RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RETRY_CONFIG.BASE_DELAY_MS;
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.MAX_DELAY_MS);
}

/**
 * WHMCS API Client
 */
export class WhmcsClient {
  private readonly axios: AxiosInstance;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly mode: McpMode;
  /**
   * F1: per-instance short-TTL read cache. Disabled by default (TTL 0). Caches
   * only idempotent, allowlisted reference reads on the read() path.
   */
  private readonly readCache: ReadCache;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.mode = config.MCP_MODE;
    this.readCache = new ReadCache({
      ttlMs: config.MCP_READ_CACHE_TTL_MS,
      cacheableActions: config.MCP_READ_CACHE_ACTIONS,
    });

    this.axios = axios.create({
      baseURL: getWhmcsApiEndpoint(),
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  }

  /**
   * Get the current operation mode
   */
  getMode(): McpMode {
    return this.mode;
  }

  /**
   * Check if in read-only mode
   */
  isReadOnly(): boolean {
    return this.mode === 'read_only';
  }

  /**
   * Check if in simulate mode
   */
  isSimulate(): boolean {
    return this.mode === 'simulate';
  }

  /**
   * Transform parameters for WHMCS API
   * - Convert booleans to WHMCS format
   * - Remove undefined values
   */
  private transformParams(params: Record<string, unknown>): Record<string, unknown> {
    const transformed: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) {
        continue;
      }
      
      if (typeof value === 'boolean') {
        transformed[key] = boolToWhmcs(value);
      } else {
        transformed[key] = value;
      }
    }
    
    return transformed;
  }

  /**
   * Make a call to the WHMCS API
   * 
   * @param action - WHMCS API action name
   * @param params - Parameters for the action
   * @param options - Call options
   * @returns Typed response from WHMCS
   * @throws WhmcsBusinessError for API-level errors
   * @throws WhmcsTransportError for network/HTTP errors
   */
  async call<T>(
    action: string,
    params: Record<string, unknown> = {},
    options: WhmcsCallOptions = {}
  ): Promise<T> {
    const { isMutating = false, normalize = true, simulatedResponse } = options;

    // Log the API call
    this.logger.logWhmcsCall(action, params, isMutating);

    // Handle simulate mode for mutating operations
    if (this.mode === 'simulate' && isMutating) {
      this.logger.info('Simulated WHMCS call (not executed)', {
        action,
        params,
        mode: 'simulate',
      });
      
      if (simulatedResponse) {
        return simulatedResponse as T;
      }
      
      // Return a generic success response
      return {
        result: 'success',
        message: `Simulated ${action} call`,
      } as unknown as T;
    }

    // Build request body
    const body = new URLSearchParams({
      action,
      identifier: this.config.WHMCS_IDENTIFIER,
      secret: this.config.WHMCS_SECRET,
      ...(this.config.WHMCS_ACCESS_KEY ? { accesskey: this.config.WHMCS_ACCESS_KEY } : {}),
      responsetype: 'json',
      ...this.transformParams(params),
    } as Record<string, string>);

    // Determine if retries are allowed
    // Default: retries allowed for reads, not for mutating operations (safety)
    const canRetry = options.allowRetry ?? !isMutating;
    const maxAttempts = canRetry ? RETRY_CONFIG.MAX_RETRIES : 1;
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.axios.post<WhmcsResponse>('', body);
      
      // Check HTTP status
      if (response.status !== 200) {
        throw new WhmcsTransportError(
          `WHMCS returned HTTP ${response.status}`,
          response.status
        );
      }

      const data = response.data;

      // Check for WHMCS business error
      if (data.result === 'error') {
        throw new WhmcsBusinessError(
          data.message || 'Unknown WHMCS error',
          undefined,
          data
        );
      }

        // Normalize response if enabled
        let result = data as unknown as T;
        if (normalize && typeof result === 'object' && result !== null) {
          result = normalizeWhmcsResponse(
            result as Record<string, unknown>,
            action
          ) as T;
        }

        return result;

      } catch (error) {
        // Re-throw our custom errors that shouldn't be retried
        if (error instanceof WhmcsBusinessError) {
          throw error;
        }
        
        // Store the error for potential re-throw after all retries
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if this error is retryable
        let isRetryable = false;
        let statusCode: number | undefined;
        
        if (error instanceof WhmcsTransportError) {
          statusCode = error.statusCode;
          isRetryable = statusCode !== undefined && 
            RETRY_CONFIG.RETRYABLE_STATUS_CODES.includes(statusCode);
        } else if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
          statusCode = axiosError.response?.status;
          
          // Retry on 5xx errors, network errors, or timeouts
          isRetryable = (
            (statusCode !== undefined && RETRY_CONFIG.RETRYABLE_STATUS_CODES.includes(statusCode)) ||
            axiosError.code === 'ECONNRESET' ||
            axiosError.code === 'ETIMEDOUT' ||
            axiosError.code === 'ECONNABORTED'
          );
        }
        
        // If not retryable or last attempt, convert to proper error and throw
        if (!isRetryable || attempt >= maxAttempts - 1) {
          if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError;
            
            if (axiosError.response) {
              const status = axiosError.response.status;
              const body = axiosError.response.data;
              // Log 5xx response body for debugging (no secrets in typical PHP error output)
              if (status >= 500 && body !== undefined && body !== null) {
                this.logger.warn('WHMCS HTTP 5xx response body', {
                  action,
                  status,
                  responseBody:
                    typeof body === 'string'
                      ? body.substring(0, 2000)
                      : typeof body === 'object'
                        ? JSON.stringify(body).substring(0, 2000)
                        : typeof body === 'number' || typeof body === 'boolean'
                          ? String(body)
                          : '[unserializable]',
                });
              }
              throw new WhmcsTransportError(
                `WHMCS HTTP error: ${status}`,
                status
              );
            }
            
            if (axiosError.request) {
              throw new WhmcsTransportError(
                `WHMCS connection error: ${axiosError.message}`
              );
            }
          }
          
          throw new WhmcsTransportError(
            `Unexpected error calling WHMCS: ${lastError.message}`
          );
        }
        
        // Calculate backoff delay and wait
        const delay = getBackoffDelay(attempt);
        this.logger.warn('WHMCS call failed, retrying...', {
          action,
          attempt: attempt + 1,
          maxAttempts,
          statusCode,
          delayMs: Math.round(delay),
          error: lastError.message,
        });
        
        await sleep(delay);
      }
    }
    
    // Should never reach here, but TypeScript needs it
    throw lastError ?? new WhmcsTransportError('Unknown error after retries');
  }

  /**
   * Make a read-only API call
   * Convenience method that enforces non-mutating behavior
   */
  async read<T>(
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    // Policy guard stays BEFORE the cache so a denied action is never cached
    // and a deny is never satisfied from cache.
    assertReadAction(action);

    // Key the cache on the SAME params shape sent to WHMCS (transformParams
    // drops `undefined` and normalizes booleans) so the key-space matches the
    // request-space — otherwise `{x: undefined}` and `{}` would be distinct
    // cache slots for an identical API call.
    const cacheParams = this.transformParams(params);

    // F1 cache: returns undefined when disabled (TTL 0), not allowlisted, or miss.
    const cached = this.readCache.get(action, cacheParams);
    if (cached !== undefined) {
      return cached as T;
    }

    const result = await this.call<T>(action, params, { isMutating: false });
    // Only successful reads reach here (call() throws on error). set() is a
    // no-op when caching is disabled or the action is not allowlisted.
    this.readCache.set(action, cacheParams, result);
    return result;
  }

  /**
   * Clear the per-instance read cache. Exposed for tests / explicit bypass.
   */
  clearReadCache(): void {
    this.readCache.clear();
  }

  /**
   * Make a mutating API call
   * Checks mode restrictions before executing
   * 
   * @throws Error if in read_only mode
   */
  async mutate<T>(
    action: string,
    params: Record<string, unknown> = {},
    simulatedResponse?: T
  ): Promise<T> {
    // Block in read_only mode
    if (this.mode === 'read_only') {
      throw new WhmcsBusinessError(
        'Operation not allowed in read_only mode',
        'MODE_RESTRICTED'
      );
    }

    return this.call<T>(action, params, {
      isMutating: true,
      simulatedResponse,
    });
  }
}
