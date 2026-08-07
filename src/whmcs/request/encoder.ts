import { boolToWhmcs } from '../normalizers.js';
import type { WhmcsCredentials } from './types.js';

export function normalizeWhmcsParams(
  params: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    normalized[key] = typeof value === 'boolean' ? boolToWhmcs(value) : value;
  }
  return normalized;
}

/**
 * Credentials enter the pipeline only at the final encoding boundary. The
 * returned URLSearchParams must never be logged or attached to telemetry.
 */
export function encodeWhmcsRequest(
  action: string,
  params: Readonly<Record<string, unknown>>,
  credentials: Readonly<WhmcsCredentials>
): URLSearchParams {
  return new URLSearchParams({
    action,
    identifier: credentials.identifier,
    secret: credentials.secret,
    ...(credentials.accessKey ? { accesskey: credentials.accessKey } : {}),
    responsetype: 'json',
    ...params,
  } as Record<string, string>);
}
