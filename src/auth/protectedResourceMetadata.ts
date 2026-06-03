/**
 * OAuth 2.1 Protected Resource Metadata (RFC 9728 / SEP-985) — component 1 of
 * the OAuth resource-server design (see docs/OAUTH_DESIGN.md).
 *
 * This server is an OAuth 2.1 *resource server*: it does not issue tokens, it
 * validates bearer tokens and advertises where the *authorization server* (AS)
 * lives. Per RFC 9728 a client discovers that by fetching
 * `GET /.well-known/oauth-protected-resource`, which returns this metadata
 * document. On a 401 the RS also emits a `WWW-Authenticate` header pointing back
 * at that metadata URL so the client can auto-discover the AS (component 3).
 *
 * Everything here is PURE: no I/O, no env reads, no logging. The HTTP layer
 * (httpServer.ts) wires config → these builders → the route/header response.
 */

/** Well-known path for the Protected Resource Metadata document (RFC 9728 §3). */
export const PRM_PATH = '/.well-known/oauth-protected-resource';

/**
 * Inputs needed to build the PRM document. Mirrors the env surface described in
 * the design doc (`MCP_OAUTH_RESOURCE`, `MCP_OAUTH_AUTH_SERVERS`) but stays pure
 * — the caller resolves those into this shape.
 */
export interface PrmConfig {
  /** This RS's canonical resource URI (the token audience, RFC 8707). */
  readonly resource: string;
  /** Issuer URLs of the authorization server(s) trusted to mint tokens. */
  readonly authorizationServers: string[];
  /** OAuth scopes this resource recognises (e.g. `whmcs:read`). */
  readonly scopesSupported: string[];
}

/**
 * Build the RFC 9728 Protected Resource Metadata document.
 *
 * Always present: `resource`, `bearer_methods_supported: ['header']` (we accept
 * the bearer token only in the `Authorization` header — never query/body, per
 * the design's security must-haves). Optional arrays (`authorization_servers`,
 * `scopes_supported`) are OMITTED when empty rather than serialised as `[]`, so
 * the document never advertises an empty/ambiguous capability.
 */
export function buildProtectedResourceMetadata(cfg: PrmConfig): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    resource: cfg.resource,
    bearer_methods_supported: ['header'],
  };
  if (cfg.authorizationServers.length > 0) {
    metadata.authorization_servers = [...cfg.authorizationServers];
  }
  if (cfg.scopesSupported.length > 0) {
    metadata.scopes_supported = [...cfg.scopesSupported];
  }
  return metadata;
}

/**
 * Build the `WWW-Authenticate` header value for a 401 response (RFC 9728 §5.1,
 * MCP spec requirement). Always includes `resource_metadata="<url>"` so the
 * client can discover the AS; appends `error="<error>"` (e.g. `invalid_token`)
 * when an error code is supplied. The value never leaks token contents.
 *
 * @example
 *   wwwAuthenticateValue('https://rs/.well-known/oauth-protected-resource')
 *   // => 'Bearer resource_metadata="https://rs/.well-known/oauth-protected-resource"'
 *   wwwAuthenticateValue(url, 'invalid_token')
 *   // => 'Bearer resource_metadata="<url>", error="invalid_token"'
 */
export function wwwAuthenticateValue(resourceMetadataUrl: string, error?: string): string {
  const params = [`resource_metadata="${resourceMetadataUrl}"`];
  if (error !== undefined && error !== '') {
    params.push(`error="${error}"`);
  }
  return `Bearer ${params.join(', ')}`;
}
