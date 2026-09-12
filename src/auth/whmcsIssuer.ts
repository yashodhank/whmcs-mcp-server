/**
 * WHMCS OIDC issuer helpers (ADR-0002).
 *
 * WHMCS tokens are minted for the WHMCS System URL, not MCP_OAUTH_RESOURCE.
 * The MCP resource server must treat the WHMCS origin as a forbidden issuer
 * for Bearer access tokens.
 */

/** Normalize an issuer URL for equality (trim, no trailing slash, lowercase). */
export function normalizeIssuerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/** WHMCS origin from an API URL (base or full `/includes/api.php`). */
export function originFromApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '');
  if (/\/includes\/api\.php$/i.test(trimmed)) {
    return trimmed.replace(/\/includes\/api\.php$/i, '');
  }
  return trimmed;
}

/** Issuers that must never be accepted as MCP-audience token issuers. */
export function collectForbiddenWhmcsIssuers(input: {
  apiUrl?: string;
  oidcIssuer?: string;
}): string[] {
  const out: string[] = [];
  const oidc = input.oidcIssuer?.trim();
  if (oidc !== undefined && oidc !== '') out.push(oidc);
  const api = input.apiUrl?.trim();
  if (api !== undefined && api !== '') out.push(originFromApiUrl(api));
  return out;
}

/** True when any configured AS issuer is the WHMCS origin (misconfiguration). */
export function oauthIssuersIncludeWhmcs(
  issuers: readonly string[],
  forbidden: readonly string[]
): boolean {
  const blocked = new Set(forbidden.map(normalizeIssuerUrl).filter((s) => s.length > 0));
  if (blocked.size === 0) return false;
  return issuers.some((iss) => blocked.has(normalizeIssuerUrl(iss)));
}

export function issuerIsForbidden(
  candidate: string,
  forbidden: readonly string[] | undefined
): boolean {
  if (forbidden === undefined || forbidden.length === 0) return false;
  const n = normalizeIssuerUrl(candidate);
  if (n === '') return false;
  return forbidden.some((iss) => normalizeIssuerUrl(iss) === n);
}
