/**
 * Security helpers for MCP access control
 * - Optional shared-secret auth for tools/resources
 * - Access mode (admin vs client) gating
 * - Client scope enforcement
 */

import { z } from 'zod';
import { config } from './config.js';

export type AccessMode = 'admin' | 'client';
export type AccessLevel = 'admin' | 'client' | 'shared';

interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface ResourceResponse {
  [key: string]: unknown;
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

export const AUTH_SHAPE = {
  auth_token: z.string().optional().describe('MCP auth token'),
};

export function withAuthSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return config.MCP_AUTH_TOKEN ? schema.extend(AUTH_SHAPE) : schema;
}

function toolError(message: string, extra?: Record<string, unknown>): McpToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        isError: true,
        error: message,
        ...(extra ? extra : {}),
      }),
    }],
    isError: true,
  };
}

function resourceError(uri: string, message: string, extra?: Record<string, unknown>): ResourceResponse {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        error: message,
        ...(extra ? extra : {}),
      }),
    }],
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
      delete (params as Record<string, unknown>).auth_token;
    }
    return null;
  }

  const token = typeof params.auth_token === 'string' ? params.auth_token : undefined;
  if (!token || token !== required) {
    return toolError('Unauthorized: missing or invalid auth_token.');
  }

  delete (params as Record<string, unknown>).auth_token;
  return null;
}

export function ensureResourceAuth(uri: URL): { ok: true } | { ok: false; response: ResourceResponse } {
  const required = config.MCP_AUTH_TOKEN;
  if (!required) {
    return { ok: true };
  }

  const token = uri.searchParams.get('token') || uri.searchParams.get('auth_token');
  if (!token || token !== required) {
    return { ok: false, response: resourceError(uri.href, 'Unauthorized: missing or invalid token.') };
  }

  return { ok: true };
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

export function resolveClientIdParam(params: Record<string, unknown>, fieldNames: string[] = ['clientid', 'userid']): { ok: true; clientId: number; usedDefault: boolean } | { ok: false; response: McpToolResponse } {
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
    response: toolError('clientid is required for client access mode when multiple clients are allowed.'),
  };
}

export function ensureClientOwnership(actualClientId: number, params?: Record<string, unknown>): McpToolResponse | null {
  const scopeError = ensureClientAllowed(actualClientId);
  if (scopeError) {
    return scopeError;
  }

  if (params) {
    const hinted = typeof params.clientid === 'number' ? params.clientid
      : typeof params.userid === 'number' ? params.userid
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
