/**
 * Security helpers for MCP access control
 * - Optional shared-secret auth for TOOL CALLS (auth_token param). This server
 *   is stdio-only; MCP resources are NOT authenticated via a URI-query token
 *   (the SDK's $-anchored URI matching makes that unworkable, and on stdio the
 *   spawning process is the trust boundary). Resources are gated by
 *   MCP_ACCESS_MODE / client-scope only.
 * - Access mode (admin vs client) gating
 * - Client scope enforcement
 * - Constant-time token comparison (SEC-001)
 * - No auth params in response URIs (SEC-002, SEC-004) — defensive hygiene
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';

/** Auth query param names that must never appear in response URIs */
const AUTH_PARAM_NAMES = ['token', 'auth_token'];

/**
 * Compare two strings in constant time to prevent timing attacks (SEC-001).
 * Uses SHA-256 hashing so length of secrets is not leaked.
 */
function safeCompareTokens(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  if (hashA.length !== hashB.length) return false;
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Return URI string with auth query params stripped (SEC-002, SEC-004).
 * Use this for any URI returned to the client so the auth token is never leaked.
 */
export function stripAuthFromUri(uri: URL): string {
  const next = new URL(uri.href);
  AUTH_PARAM_NAMES.forEach((name) => {
    next.searchParams.delete(name);
  });
  return next.href;
}

export type AccessMode = 'admin' | 'client';
export type AccessLevel = 'admin' | 'client' | 'shared';

interface McpToolResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export const AUTH_SHAPE = {
  auth_token: z.string().optional().describe('MCP auth token'),
};

function toolError(message: string, extra?: Record<string, unknown>): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          isError: true,
          error: message,
          ...(extra ? extra : {}),
        }),
      },
    ],
    isError: true,
  };
}

export function getAccessMode(): AccessMode {
  return config.MCP_ACCESS_MODE;
}

export function isClientMode(): boolean {
  return config.MCP_ACCESS_MODE === 'client';
}

export function isAccessAllowed(level: AccessLevel): boolean {
  if (config.MCP_ACCESS_MODE === 'admin') {
    return true;
  }
  // client mode
  return level !== 'admin';
}

export function ensureToolAuth(params: Record<string, unknown>): McpToolResponse | null {
  const required = config.MCP_AUTH_TOKEN;
  if (!required) {
    if (Object.prototype.hasOwnProperty.call(params, 'auth_token')) {
      delete params.auth_token;
    }
    return null;
  }

  const token = typeof params.auth_token === 'string' ? params.auth_token : undefined;
  if (!token || !safeCompareTokens(token, required)) {
    return toolError('Unauthorized: missing or invalid auth_token.');
  }

  delete params.auth_token;
  return null;
}

export function clientModeDenied(toolName: string): McpToolResponse {
  return toolError(`Tool '${toolName}' is not available in client access mode.`);
}

export function ensureClientAllowed(clientId: number): McpToolResponse | null {
  if (!isClientMode()) {
    return null;
  }
  const allowed = config.MCP_ALLOWED_CLIENT_IDS;
  if (allowed.length === 0) {
    return toolError('Client access mode requires MCP_ALLOWED_CLIENT_IDS to be configured.');
  }
  if (!allowed.includes(clientId)) {
    return toolError('Access denied: client scope mismatch.', {
      clientid: clientId,
    });
  }
  return null;
}

export function resolveClientIdParam(
  params: Record<string, unknown>,
  fieldNames: string[] = ['clientid', 'userid']
): { ok: true; clientId: number; usedDefault: boolean } | { ok: false; response: McpToolResponse } {
  for (const field of fieldNames) {
    const value = params[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { ok: true, clientId: value, usedDefault: false };
    }
  }

  // If only one allowed client id exists, use it as default
  const allowed = config.MCP_ALLOWED_CLIENT_IDS;
  if (allowed.length === 1) {
    const clientId = allowed[0];
    // inject for downstream calls
    params.clientid = clientId;
    return { ok: true, clientId, usedDefault: true };
  }

  return {
    ok: false,
    response: toolError(
      'clientid is required for client access mode when multiple clients are allowed.'
    ),
  };
}

export function ensureClientOwnership(
  actualClientId: number,
  params?: Record<string, unknown>
): McpToolResponse | null {
  const scopeError = ensureClientAllowed(actualClientId);
  if (scopeError) {
    return scopeError;
  }

  if (params) {
    const hinted =
      typeof params.clientid === 'number'
        ? params.clientid
        : typeof params.userid === 'number'
          ? params.userid
          : undefined;
    if (hinted !== undefined && hinted !== actualClientId) {
      return toolError('Access denied: requested clientid does not match resource owner.', {
        requested: hinted,
        owner: actualClientId,
      });
    }
  }

  return null;
}

export function requireClientModeClientId(params: Record<string, unknown>): McpToolResponse | null {
  if (!isClientMode()) {
    return null;
  }
  const resolved = resolveClientIdParam(params, ['clientid']);
  if (!resolved.ok) {
    return resolved.response;
  }
  const scopeError = ensureClientAllowed(resolved.clientId);
  if (scopeError) {
    return scopeError;
  }
  return null;
}
