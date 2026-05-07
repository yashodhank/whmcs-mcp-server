/**
 * Rate Limiter and Idempotency module for WHMCS MCP Server
 * 
 * Provides:
 * - Token bucket rate limiting for WHMCS API calls
 * - Idempotency cache for high-risk operations
 */

import { config } from './config.js';
import { Logger } from './logging.js';

/**
 * Configuration constants for rate limiting and idempotency
 */
const DEFAULT_IDEMPOTENCY_WINDOW_MS = 60 * 1000; // 60 seconds
const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds
const MAX_CACHE_SIZE = 1000; // Maximum number of cached idempotency results

/**
 * Cached result for idempotency
 */
interface CachedResult<T = unknown> {
  key: string;
  result: T;
  timestamp: number;
}

/**
 * High-risk tools that require idempotency protection
 * Using Set for O(1) lookup performance
 */
const HIGH_RISK_TOOLS = new Set([
  'capture_payment',
  'record_refund',
  'mark_invoice_paid',
  'add_credit',
  'accept_order',
  'terminate_service',
]);

/**
 * Rate limiter using token bucket algorithm
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly idempotencyCache: Map<string, CachedResult>;
  private readonly idempotencyWindowMs: number; // Cache window in milliseconds
  private readonly logger: Logger;
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  constructor(logger: Logger) {
    this.maxTokens = config.MCP_RATE_LIMIT;
    this.refillRate = config.MCP_RATE_LIMIT;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this.idempotencyCache = new Map();
    this.idempotencyWindowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS;
    this.logger = logger;

    // Periodically clean up old cache entries (store interval ID for cleanup)
    this.cleanupIntervalId = setInterval(() => this.cleanupCache(), DEFAULT_CLEANUP_INTERVAL_MS);
  }

  /**
   * Cleanup resources on shutdown
   * Call this method when shutting down the server to prevent memory leaks
   */
  cleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
      this.logger.debug('Rate limiter cleanup completed');
    }
    this.idempotencyCache.clear();
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const newTokens = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Attempt to consume a token for an API call
   * @returns true if allowed, false if rate limited
   */
  tryConsume(): boolean {
    this.refill();
    
    if (this.tokens < 1) {
      this.logger.warn('Rate limit exceeded', {
        availableTokens: this.tokens,
        maxTokens: this.maxTokens,
      });
      return false;
    }
    
    this.tokens -= 1;
    return true;
  }

  /**
   * Check if rate limit would be exceeded without consuming
   */
  wouldExceed(): boolean {
    this.refill();
    return this.tokens < 1;
  }

  /**
   * Get current available tokens
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Check if a tool requires idempotency protection
   */
  isHighRiskTool(toolName: string): boolean {
    return HIGH_RISK_TOOLS.has(toolName);
  }

  /**
   * Generate an idempotency key for a tool call
   * Key is based on: tool_name + primary_id + time_bucket
   */
  generateIdempotencyKey(
    toolName: string,
    primaryId: string | number
  ): string {
    // Time bucket: floor to nearest window
    const timeBucket = Math.floor(Date.now() / this.idempotencyWindowMs);
    return `${toolName}:${primaryId}:${timeBucket}`;
  }

  /**
   * Get cached result for an idempotency key
   * @returns cached result if found and within window, undefined otherwise
   */
  getCachedResult<T>(key: string): T | undefined {
    const cached = this.idempotencyCache.get(key);
    
    if (!cached) {
      return undefined;
    }
    
    // Check if cache is still valid
    const age = Date.now() - cached.timestamp;
    if (age > this.idempotencyWindowMs) {
      this.idempotencyCache.delete(key);
      return undefined;
    }
    
    this.logger.info('Returning cached result (idempotency)', { key });
    return cached.result as T;
  }

  /**
   * Cache a result for idempotency
   * Enforces maximum cache size to prevent unbounded memory growth
   */
  cacheResult<T>(key: string, result: T): void {
    // Enforce maximum cache size by removing oldest entries if needed
    if (this.idempotencyCache.size >= MAX_CACHE_SIZE) {
      // Remove oldest entries (first 10%)
      const entriesToRemove = Math.ceil(MAX_CACHE_SIZE * 0.1);
      const iterator = this.idempotencyCache.keys();
      for (let i = 0; i < entriesToRemove; i++) {
        const key = iterator.next().value;
        if (key) {
          this.idempotencyCache.delete(key);
        }
      }
      this.logger.warn('Idempotency cache size limit reached, evicted oldest entries', {
        evicted: entriesToRemove,
        maxSize: MAX_CACHE_SIZE,
      });
    }
    
    this.idempotencyCache.set(key, {
      key,
      result,
      timestamp: Date.now(),
    });
    
    this.logger.debug('Cached result for idempotency', { key });
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, cached] of this.idempotencyCache) {
      if (now - cached.timestamp > this.idempotencyWindowMs) {
        this.idempotencyCache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.logger.debug('Cleaned up idempotency cache', { entriesRemoved: cleaned });
    }
  }

  /**
   * Get cache statistics for debugging
   */
  getCacheStats(): { size: number; oldestEntryAgeMs: number | null } {
    if (this.idempotencyCache.size === 0) {
      return { size: 0, oldestEntryAgeMs: null };
    }
    
    let oldest = Date.now();
    for (const cached of this.idempotencyCache.values()) {
      if (cached.timestamp < oldest) {
        oldest = cached.timestamp;
      }
    }
    
    return {
      size: this.idempotencyCache.size,
      oldestEntryAgeMs: Date.now() - oldest,
    };
  }
}

/**
 * Rate limit error to be caught and converted to tool error
 */
export class RateLimitError extends Error {
  constructor() {
    super('Rate limit exceeded. Please wait a moment before retrying.');
    this.name = 'RateLimitError';
  }
}
