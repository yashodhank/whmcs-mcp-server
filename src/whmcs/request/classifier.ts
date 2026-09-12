import axios, { type AxiosError } from 'axios';
import { WhmcsTransportError } from './errors.js';

export const RETRYABLE_STATUS_CODES = [500, 502, 503, 504, 429] as const;

/**
 * Discriminated 403 sub-classification. Lets callers choose the right repair
 * strategy without re-parsing the WHMCS body:
 *  - `invalid_ip`          — "Invalid IP x.x.x.x" → IP allowlist heal may fix
 *  - `invalid_permissions` — "Invalid Permissions: …" → API credential role ACL;
 *                            heal cannot fix, needs admin allowlisting the action
 *  - `waf_or_empty`        — 403 with no WHMCS body → edge/WAF/proxy block
 *  - `unknown`             — 403 with a body that doesn't match known patterns
 */
export type ForbiddenKind = 'invalid_ip' | 'invalid_permissions' | 'waf_or_empty' | 'unknown';

export interface ClassifiedWhmcsError {
  original: unknown;
  error: Error;
  statusCode?: number;
  retryable: boolean;
  axiosError?: AxiosError;
  whmcsMessage?: string;
  reportedIp?: string;
  hasResponseBody: boolean;
  cancelled: boolean;
  /** Present only when `statusCode === 403`. */
  forbiddenKind?: ForbiddenKind;
}

function extractWhmcsMessage(error: AxiosError): { whmcsMessage?: string; reportedIp?: string } {
  const data = error.response?.data as { message?: string } | string | undefined;
  const message =
    typeof data === 'string'
      ? data || undefined
      : data && typeof data === 'object' && typeof data.message === 'string'
        ? data.message
        : undefined;
  if (!message) return {};
  const match = /invalid\s+ip\s+([0-9a-fA-F:.]+)/i.exec(message);
  return { whmcsMessage: message, reportedIp: match?.[1] };
}

/** Classify a 403 into a repair-relevant sub-kind. */
function classifyForbidden(
  whmcsMessage: string | undefined,
  hasResponseBody: boolean
): ForbiddenKind {
  if (!hasResponseBody) return 'waf_or_empty';
  if (!whmcsMessage) return 'unknown';
  if (/invalid\s+ip/i.test(whmcsMessage)) return 'invalid_ip';
  if (/invalid\s+permissions/i.test(whmcsMessage)) return 'invalid_permissions';
  return 'unknown';
}

export function classifyWhmcsError(error: unknown): ClassifiedWhmcsError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (error instanceof WhmcsTransportError) {
    return {
      original: error,
      error: normalized,
      statusCode: error.statusCode,
      retryable:
        error.statusCode !== undefined &&
        RETRYABLE_STATUS_CODES.includes(error.statusCode as never),
      hasResponseBody: false,
      cancelled: false,
    };
  }
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const statusCode = axiosError.response?.status;
    const extracted = extractWhmcsMessage(axiosError);
    const data = axiosError.response?.data;
    const hasBody = data !== undefined && data !== null && data !== '';
    const forbiddenKind =
      statusCode === 403 ? classifyForbidden(extracted.whmcsMessage, hasBody) : undefined;
    return {
      original: error,
      error: normalized,
      statusCode,
      retryable:
        (statusCode !== undefined && RETRYABLE_STATUS_CODES.includes(statusCode as never)) ||
        axiosError.code === 'ECONNRESET' ||
        axiosError.code === 'ETIMEDOUT' ||
        axiosError.code === 'ECONNABORTED',
      axiosError,
      ...extracted,
      hasResponseBody: hasBody,
      cancelled: axiosError.code === 'ERR_CANCELED' || axiosError.name === 'CanceledError',
      forbiddenKind,
    };
  }
  return {
    original: error,
    error: normalized,
    retryable: false,
    hasResponseBody: false,
    cancelled: normalized.name === 'AbortError',
  };
}
