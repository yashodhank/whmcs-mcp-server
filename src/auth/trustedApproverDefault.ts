/**
 * Trusted stdio default APPROVER consumer token.
 *
 * Mirrors `trustedStdioDefault.ts` but resolves a DISTINCT approver token
 * so that an AI agent calling `approve_write_intent` over trusted stdio
 * (without an explicit `auth_token`) can satisfy the separation-of-duties
 * requirement (approver_consumer_id !== drafter consumer_id) without
 * reading token files on disk.
 *
 * The token is sourced from:
 *   1. `MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN` env var (raw bearer), or
 *   2. `MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN_FILE` env var (path to a
 *      file containing the raw token, owner-only permissions required).
 *
 * Safety invariants:
 *  - NEVER auto-applied for HTTP/remote transports.
 *  - The raw token is NEVER logged, committed, or placed in any result.
 *  - If neither env var is set, the module is inert (returns undefined).
 *  - The approver token MUST resolve to a DIFFERENT consumer than the
 *    executor/drafter default — enforced by the execution gate, not here.
 */

import { readFileSync, statSync } from 'node:fs';

let resolvedToken: string | undefined;
let resolved = false;

function resolveApproverToken(env: NodeJS.ProcessEnv): string | undefined {
  if (resolved) return resolvedToken;
  resolved = true;

  const inline = env.MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN;
  if (typeof inline === 'string' && inline.trim().length > 0) {
    resolvedToken = inline.trim();
    return resolvedToken;
  }

  const filePath = env.MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN_FILE;
  if (typeof filePath === 'string' && filePath.trim().length > 0) {
    try {
      const stat = statSync(filePath.trim());
      if (!stat.isFile()) return undefined;
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        process.stderr.write(
          `[trustedApproverDefault] MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN_FILE (${filePath}) is ` +
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
 * Return the default approver auth token for a trusted stdio tool call,
 * or `undefined` if not configured or the transport is not trusted stdio.
 *
 * @param transport - The active MCP transport type ('stdio' | 'http').
 * @param callerToken - The `auth_token` value from the tool call params.
 *   When the caller already provided a token, the default is NOT injected.
 */
export function resolveStdioApproverToken(
  transport: 'stdio' | 'http',
  callerToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (transport !== 'stdio') return undefined;
  if (callerToken !== undefined && callerToken.length > 0) return undefined;
  return resolveApproverToken(env);
}

/**
 * Whether a default approver token is configured. Used for posture reporting.
 */
export function hasApproverDefaultToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveApproverToken(env) !== undefined;
}

/** Reset module cache. Test-only. */
export function _resetApproverDefaultTokenForTests(): void {
  resolvedToken = undefined;
  resolved = false;
}
