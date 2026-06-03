/**
 * MCP logging bridge (spec 2025-11-25 logging utility)
 *
 * Surfaces structured, level-filtered server->client logs via the MCP
 * `notifications/message` channel, which the client subscribes to / tunes with
 * `logging/setLevel`.
 *
 * Design notes / how this sits on the SDK:
 * - The SDK's `Server` class ALREADY auto-handles `logging/setLevel` (it
 *   installs a `SetLevelRequestSchema` handler in its constructor, but ONLY
 *   when the `logging` server capability is declared) and stores the requested
 *   level per session in a private `_loggingLevels` map.
 * - `server.server.sendLoggingMessage(params)` is the emit path. It is already
 *   a no-op when the server `logging` capability is absent, and it already
 *   drops messages below the client-requested level via the SDK's internal
 *   RFC-5424 severity comparison (`isMessageIgnored`).
 * - Because the SDK only filters once the client has sent `setLevel` (before
 *   that the spec says the server MAY decide what to emit), this bridge keeps
 *   its OWN default minimum level (`'info'`) and applies it as a pre-filter so
 *   behaviour is sane and deterministic from the very first message.
 * - This bridge additionally feature-detects the *client's* advertised logging
 *   capability (the SDK's own guard only checks the *server's* capability) and
 *   no-ops if the client did not advertise it. It NEVER throws.
 *
 * SECURITY: never pass secrets / PII / PAN here. `data` must be structured and
 * safe — ids, action names, decision codes, counts only.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * RFC-5424 ordered log levels, lowest severity first. Index = severity rank.
 * Mirrors the SDK's `LoggingLevelSchema.options` order so our pre-filter and
 * the SDK's internal filter agree.
 */
export const MCP_LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const;

export type McpLogLevel = (typeof MCP_LOG_LEVELS)[number];

const SEVERITY: ReadonlyMap<McpLogLevel, number> = new Map(
  MCP_LOG_LEVELS.map((level, index) => [level, index]),
);

/** Default minimum level emitted before the client sends `logging/setLevel`. */
const DEFAULT_MIN_LEVEL: McpLogLevel = 'info';

/** Logger name attached to every emitted notification. */
const LOGGER_NAME = 'whmcs-mcp';

/**
 * Minimal structural view of the underlying SDK `Server` we rely on. Kept as a
 * loose shape (mirroring the feature-detect pattern in tools/writeFlow.ts) so
 * we never hard-depend on SDK internals and can no-op safely.
 */
interface LoggingCapableServer {
  getClientCapabilities?: () => { logging?: unknown } | undefined;
  sendLoggingMessage?: (params: {
    level: McpLogLevel;
    logger?: string;
    data?: unknown;
  }) => Promise<void> | void;
}

/**
 * The logging bridge. Construct once with the McpServer, then call `mcpLog`.
 * Safe to construct/use whether or not a client is connected or logging-capable.
 */
export class McpLoggingBridge {
  private minLevel: McpLogLevel = DEFAULT_MIN_LEVEL;
  private readonly core: LoggingCapableServer | undefined;

  constructor(server: Pick<McpServer, 'server'> | undefined) {
    // Reach the underlying SDK Server defensively; tolerate any shape.
    const core = (server as unknown as { server?: LoggingCapableServer } | undefined)?.server;
    this.core = core && typeof core === 'object' ? core : undefined;
  }

  /**
   * Current bridge minimum level (the default-decision before a client setLevel,
   * and a convenient mirror of the level a client requested).
   */
  getMinLevel(): McpLogLevel {
    return this.minLevel;
  }

  /**
   * Update the bridge's minimum level. The SDK independently tracks the
   * client's `setLevel` per session; this mirror lets callers/tests reason
   * about the threshold and governs the pre-filter applied to every message.
   * Invalid levels are ignored (never throws).
   */
  setLevel(level: string): void {
    if (SEVERITY.has(level as McpLogLevel)) {
      this.minLevel = level as McpLogLevel;
    }
  }

  /** True only when both server emit-path and client capability are present. */
  private isActive(): boolean {
    if (!this.core || typeof this.core.sendLoggingMessage !== 'function') {
      return false;
    }
    // Feature-detect the CLIENT's advertised logging capability. The SDK's own
    // sendLoggingMessage guard only checks the SERVER capability, so we add the
    // client-side check here. If capabilities are unknown (e.g. not yet
    // initialized), treat as inactive — never emit blindly.
    if (typeof this.core.getClientCapabilities !== 'function') {
      return false;
    }
    const caps = this.core.getClientCapabilities();
    return caps?.logging !== undefined;
  }

  /**
   * Emit a structured log to the client IFF:
   *  - level >= the bridge minimum level (RFC-5424 ordering), AND
   *  - the client advertised the logging capability.
   * Otherwise a no-op. Never throws (a failed notification must not break a
   * tool call). The SDK additionally applies the client's `setLevel` filter.
   */
  mcpLog(level: McpLogLevel, message: string, data?: Record<string, unknown>): void {
    try {
      const rank = SEVERITY.get(level);
      if (rank === undefined) {
        return; // unknown level — ignore rather than throw
      }
      if (rank < (SEVERITY.get(this.minLevel) ?? 0)) {
        return; // below threshold
      }
      const core = this.core;
      if (!this.isActive() || !core?.sendLoggingMessage) {
        return; // no logging-capable client connected
      }
      // Structured, safe payload only. `message` is carried inside `data` so
      // the whole thing is one structured object (the spec `data` is free-form).
      const payload: Record<string, unknown> = { message };
      if (data) {
        for (const [k, v] of Object.entries(data)) {
          payload[k] = v;
        }
      }
      // Fire-and-forget; swallow async rejection so it can never surface.
      const result = core.sendLoggingMessage({
        level,
        logger: LOGGER_NAME,
        data: payload,
      });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          /* never throw from logging */
        });
      }
    } catch {
      /* logging must never break the caller */
    }
  }
}

/**
 * Module-level singleton bridge. Defaults to an inert no-op bridge so any
 * call site importing `mcpLog` is safe even before `initMcpLogging` runs.
 */
let activeBridge = new McpLoggingBridge(undefined);

/**
 * Wire the bridge to the live McpServer. Call once during server setup, AFTER
 * the server is created and the `logging` capability declared. Returns the
 * bridge for direct use/inspection.
 */
export function initMcpLogging(server: Pick<McpServer, 'server'>): McpLoggingBridge {
  activeBridge = new McpLoggingBridge(server);
  return activeBridge;
}

/**
 * Convenience free function for new call sites. Routes through the active
 * bridge; no-op until `initMcpLogging` has run and a logging-capable client is
 * connected. Never throws.
 */
export function mcpLog(
  level: McpLogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  activeBridge.mcpLog(level, message, data);
}

/** Update the active bridge's minimum level (mirrors client `setLevel`). */
export function setMcpLogLevel(level: string): void {
  activeBridge.setLevel(level);
}

/** Test/introspection helper: the current active bridge. */
export function getActiveMcpLoggingBridge(): McpLoggingBridge {
  return activeBridge;
}
