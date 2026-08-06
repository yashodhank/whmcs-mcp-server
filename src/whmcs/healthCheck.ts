/**
 * Boot-time WHMCS connectivity + auth self-check.
 *
 * Issues a single cheap authenticated read (`GetAdminDetails`) at startup so a
 * misconfiguration surfaces immediately — with an actionable, classified hint —
 * instead of failing on the first real tool call (which historically cost hours;
 * see docs/runbooks/api-connectivity-troubleshooting.md).
 *
 * Non-throwing: returns a result and lets the caller decide policy
 * (`warn` = log & continue, `strict` = log & exit). The failure classifier is
 * pure and unit-tested.
 */
import type { WhmcsClient } from './WhmcsClient.js';
import { getWhmcsApiEndpoint } from '../config.js';

export interface ConnectivityResult {
  ok: boolean;
  /** Stable machine reason when !ok. */
  reason?: ConnectivityFailureReason;
  /** Human-actionable, operator-facing hint when !ok. */
  hint?: string;
}

export type ConnectivityFailureReason =
  | 'admin-context-unresolved'
  | 'auth-failed'
  | 'dns'
  | 'unreachable'
  | 'forbidden'
  | 'unknown';

/**
 * Classify a startup-probe failure into a stable reason + an actionable hint.
 * Pure (endpoint passed in) so it is fully unit-testable.
 */
export function classifyConnectivityError(
  error: unknown,
  endpoint: string
): { reason: ConnectivityFailureReason; hint: string } {
  const msg = error instanceof Error ? error.message : String(error);

  // The single most expensive historical failure: WHMCS 200 + this message,
  // classically from a doubled /includes/api.php path (full-URL WHMCS_API_URL).
  if (/an admin user is required/i.test(msg)) {
    return {
      reason: 'admin-context-unresolved',
      hint:
        `WHMCS could not establish an admin context. Check, in order: ` +
        `(1) WHMCS_API_URL is the base origin, NOT the full /includes/api.php endpoint ` +
        `(resolved endpoint: ${endpoint}); ` +
        `(2) the credential's linked admin is active with sufficient role permissions; ` +
        `(3) the caller IP is in the WHMCS API allowlist. ` +
        `See docs/runbooks/api-connectivity-troubleshooting.md`,
    };
  }
  if (/authentication failed/i.test(msg)) {
    return {
      reason: 'auth-failed',
      hint: 'WHMCS rejected the API credentials. Verify WHMCS_IDENTIFIER / WHMCS_SECRET match an active API credential.',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return {
      reason: 'dns',
      hint: `Host did not resolve (endpoint: ${endpoint}). Check the WHMCS_API_URL hostname / DNS.`,
    };
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ECONNABORTED|socket hang up|timeout/i.test(msg)) {
    return {
      reason: 'unreachable',
      hint: `Could not reach WHMCS (endpoint: ${endpoint}). Check network/firewall and that the host is up.`,
    };
  }
  if (/\b403\b|status code 403|HTTP 403/i.test(msg)) {
    return {
      reason: 'forbidden',
      hint: 'WHMCS returned 403 — usually the caller IP is not in the WHMCS API allowlist (APIAllowedIPs). The auto-IP-heal addon manages this on 403s.',
    };
  }
  return {
    reason: 'unknown',
    hint: `Unexpected WHMCS error during the startup probe: ${msg}`,
  };
}

/**
 * Run the connectivity probe. Returns a result; never throws.
 */
export async function checkWhmcsConnectivity(client: WhmcsClient): Promise<ConnectivityResult> {
  const endpoint = (() => {
    try {
      return getWhmcsApiEndpoint();
    } catch {
      return '(unresolved)';
    }
  })();
  try {
    await client.read('GetAdminDetails');
    return { ok: true };
  } catch (error) {
    const { reason, hint } = classifyConnectivityError(error, endpoint);
    return { ok: false, reason, hint };
  }
}
