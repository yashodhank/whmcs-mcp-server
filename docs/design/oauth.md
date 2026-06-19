# OAuth 2.1 Resource-Server Design (follow-up to the HTTP bearer bridge)

Status: **design / roadmap**. The Streamable HTTP transport ships first with a
**bearer bridge** (Authorization token validated against the existing consumer
registry — same tokens as stdio). This doc specifies how to evolve that into a
spec-compliant **OAuth 2.1 resource server** per MCP spec rev **2025-11-25**.

## Why
The MCP spec models an HTTP MCP server as an OAuth 2.1 **resource server** (RS):
it does NOT issue tokens — it **validates** bearer tokens issued by a separate
**authorization server** (AS), and advertises where that AS is. This unlocks
hosted, multi-client, multi-tenant deployment with standard IdPs (Auth0, Okta,
Entra, Keycloak, …) instead of hand-distributed registry tokens.

Spec only applies to **HTTP transports** — stdio keeps using env credentials.
So this is strictly additive to the stdio + bearer-bridge baseline.

## Target architecture

```
Client ──(1) discover──▶ GET /.well-known/oauth-protected-resource   (RFC 9728 PRM)
       ◀─ { authorization_servers, resource, scopes_supported }
Client ──(2) OAuth dance with the AS (PKCE; CIMD for client registration) ──▶ AS
       ◀─ access_token (audience = this RS)
Client ──(3) MCP request, Authorization: Bearer <jwt> ──▶ RS (this server)
       RS validates: signature (JWKS), iss, exp, aud==our resource (RFC 8707),
                     scopes ⊇ required-for-this-tool
       ◀─ 401 + WWW-Authenticate: Bearer resource_metadata="…" on failure
```

## Components to build

1. **Protected Resource Metadata (RFC 9728 / SEP-985)** — serve
   `GET /.well-known/oauth-protected-resource` returning `{ resource,
   authorization_servers[], scopes_supported, bearer_methods_supported }`.
   Env: `MCP_OAUTH_RESOURCE` (this RS's canonical URI), `MCP_OAUTH_AUTH_SERVERS`
   (comma list of AS issuer URLs).
2. **Token validation** — verify JWT: signature via the AS JWKS
   (`/.well-known/jwks.json`, cached + rotated), `iss` ∈ configured AS, `exp`/
   `nbf`, and **`aud` == `MCP_OAUTH_RESOURCE`** (RFC 8707 — reject tokens minted
   for a different resource; prevents token passthrough/confused-deputy). Lean on
   the SDK `server/auth` middleware + a `TokenVerifier`.
3. **`WWW-Authenticate` on 401** — include `Bearer resource_metadata="<PRM url>"`
   so clients can auto-discover the AS (spec requirement).
4. **Scopes** — define a scope vocabulary and map it onto existing governance:
   - `whmcs:read` → read tools; `whmcs:write:low|medium|high` → write tiers;
     OR finer: map **field-classes → scopes** (e.g. `pii:read`, `financial:read`)
     and **write-scopes → OAuth scopes** (`scope:billing:refund:record`).
   - Enforce required scope per tool/scope at the gate: extend
     `defaultExecutionAuthorizer` / read projection to read `extra.authInfo.scopes`.
5. **Consumer ↔ OAuth client mapping** — map the token's `client_id` (or `sub`)
   to a `ConsumerProfile` (contracts, allowedWriteScopes, writeCapability). Keep
   the field-class projection + capability registry **in-house** (no spec
   equivalent). The OAuth layer replaces only token *issuance/validation*.
6. **CIMD (SEP-991)** — prefer Client ID Metadata Documents over Dynamic Client
   Registration (DCR, now fallback-only). Accept a CIMD URL as `client_id`.
7. **Incremental authorization** (2025-11-25) — support step-up scope consent for
   high-risk write scopes (request `whmcs:write:high` only when a high-risk write
   is attempted), complementing the tiered governance + Elicitation confirm.

## Wiring into existing governance (key point)
The HTTP request's validated token populates `extra.authInfo` (SDK). Bridge:
`authInfo.clientId/scopes → ConsumerProfile` via a resolver that mirrors
`resolveConsumer`, so ALL downstream code (projection, write authorizer,
audit) is unchanged — it just receives a consumer resolved from OAuth instead of
a registry token. The bearer-bridge baseline already resolves a consumer from the
header token; this swaps the resolution source.

## Security must-haves
- `aud` validation is non-negotiable (RFC 8707) — without it a token for another
  RS could be replayed here.
- JWKS fetched over HTTPS, cached with rotation; reject `alg:none`.
- 401 bodies never leak token contents; `WWW-Authenticate` points to PRM only.
- Origin/DNS-rebinding guard stays (already in the HTTP baseline).
- Audit every auth decision via the MCP logging utility (`mcpLog`).

## Deprecations to avoid
- Old HTTP+SSE two-endpoint transport (use Streamable HTTP).
- DCR as the primary registration path (use CIMD; DCR fallback only).

## Phased rollout
1. ✅ Baseline: Streamable HTTP + consumer-registry bearer bridge (this batch).
2. PRM endpoint + JWKS token validation + `aud` check + `WWW-Authenticate`.
3. Scope vocabulary + per-tool scope enforcement at the gate.
4. CIMD + incremental consent + step-up for high-risk writes.
5. Deprecate the registry-token bridge for HTTP once OAuth is the norm (keep for
   stdio).

## SDK references
`@modelcontextprotocol/sdk` `server/auth/*` (resource-server middleware,
TokenVerifier, ProxyOAuthServerProvider), `server/streamableHttp.ts`. Spec:
modelcontextprotocol.io/specification/2025-11-25/basic/authorization.
