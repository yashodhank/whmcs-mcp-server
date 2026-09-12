/**
 * Trusted stdio default consumer token.
 *
 * When the MCP transport is trusted local stdio (the spawning process IS the
 * trust boundary) and a tool call omits `auth_token`, auto-inject a
 * pre-configured default consumer token so the governance pipeline resolves a
 * consumer profile instead of denying with `no_token`.
 *
 * The token is sourced from:
 *   1. `MCP_DEFAULT_CONSUMER_AUTH_TOKEN` env var (raw bearer token), or
 *   2. `MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE` env var (path to a file
 *      containing the raw token, owner-only permissions required).
 *
 * Safety invariants:
 *  - NEVER auto-applied for HTTP/remote transports.
 *  - The raw token is NEVER logged, committed, or placed in any result.
 *  - If neither env var is set, the module is inert (returns undefined).
 */

import { readFileSync, statSync } from 'node:fs';

let resolvedToken: string | undefined;
let resolved = false;

/**
 * Resolve the default consumer token from env. Cached after first call.
 * Returns `undefined` when not configured or the file is inaccessible.
 */
function resolveDefaultToken(env: NodeJS.ProcessEnv): string | undefined {
  if (resolved) return resolvedToken;
  resolved = true;

  const inline = env.MCP_DEFAULT_CONSUMER_AUTH_TOKEN;
  if (typeof inline === 'string' && inline.trim().length > 0) {
    resolvedToken = inline.trim();
    return resolvedToken;
  }

  const filePath = env.MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE;
  if (typeof filePath === 'string' && filePath.trim().length > 0) {
    try {
      const stat = statSync(filePath.trim());
      if (!stat.isFile()) return undefined;
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        process.stderr.write(
          `[trustedStdioDefault] MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE (${filePath}) is ` +
            `group/other-accessible — refusing to read (chmod 600).\n`
        );
        return undefined;
      }
      const raw = readFileSync(filePath.trim(), 'utf8').trim();
      if (raw.length > 0) {
        resolvedToken = raw;
      }
    } catch {
      /* file unreadable — inert */
    }
    return resolvedToken;
  }

  return undefined;
}

/**
 * Return the default consumer auth token for a trusted stdio tool call,
 * or `undefined` if the default is not configured or the transport is not
 * trusted stdio.
 *
 * @param transport - The active MCP transport type ('stdio' | 'http').
 * @param callerToken - The `auth_token` value from the tool call params.
 *   When the caller already provided a token, the default is NOT injected.
 */
export function resolveStdioDefaultToken(
  transport: 'stdio' | 'http',
  callerToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (transport !== 'stdio') return undefined;
  if (callerToken !== undefined && callerToken.length > 0) return undefined;
  return resolveDefaultToken(env);
}

/**
 * Whether a default consumer token is configured. Used at boot to log a
 * one-time informational message (without revealing the token value).
 */
export function hasStdioDefaultToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDefaultToken(env) !== undefined;
}

/** Reset module cache. Test-only. */
export function _resetStdioDefaultTokenForTests(): void {
  resolvedToken = undefined;
  resolved = false;
}
