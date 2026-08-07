import axios, { type AxiosError } from 'axios';
import { WhmcsTransportError } from './errors.js';

export const RETRYABLE_STATUS_CODES = [500, 502, 503, 504, 429] as const;

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
      hasResponseBody: data !== undefined && data !== null && data !== '',
      cancelled: axiosError.code === 'ERR_CANCELED' || axiosError.name === 'CanceledError',
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
