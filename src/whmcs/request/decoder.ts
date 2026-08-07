import { normalizeWhmcsResponse } from '../normalizers.js';
import { WhmcsBusinessError, WhmcsTransportError } from './errors.js';

interface WhmcsResponse {
  result: 'success' | 'error';
  message?: string;
  [key: string]: unknown;
}

export function decodeWhmcsResponse(
  status: number,
  raw: unknown,
  action: string,
  normalize: boolean,
  endpoint: string
): unknown {
  if (status !== 200) {
    throw new WhmcsTransportError(`WHMCS returned HTTP ${status}`, status);
  }

  const data = raw as WhmcsResponse;
  if (data.result === 'error') {
    let message = data.message || 'Unknown WHMCS error';
    if (/an admin user is required/i.test(message)) {
      message +=
        ` — the API request could not establish an admin context. Check, in order: ` +
        `(1) WHMCS_API_URL is the base origin, NOT the full /includes/api.php endpoint ` +
        `(resolved endpoint: ${endpoint}); ` +
        `(2) the credential's linked admin is active with sufficient role permissions; ` +
        `(3) the caller IP is in the WHMCS API allowlist. ` +
        `See docs/runbooks/api-connectivity-troubleshooting.md`;
    }
    throw new WhmcsBusinessError(message, undefined, data);
  }

  let result: unknown = data;
  if (normalize && typeof result === 'object' && result !== null) {
    result = normalizeWhmcsResponse(result as Record<string, unknown>, action);
  }
  return result;
}
