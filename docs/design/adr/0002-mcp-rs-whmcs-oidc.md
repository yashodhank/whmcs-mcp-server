# ADR-0002 — MCP is the resource server; WHMCS is the IdP

Status: **accepted** (2026-09-12)

This freezes the standards-aligned brainstorm (MCP Authorization 2025-11-25 +
WHMCS official OpenID/OAuth). Version lock remains
[ADR-0001](0001-whmcs-8137-mcp-baseline.md).

## Context

HTTP MCP **SHOULD** be an OAuth 2.1 resource server (PRM, `WWW-Authenticate`,
RFC 8707 `aud` = this MCP's canonical URI). Stdio **SHOULD NOT** use that
profile. WHMCS is an OIDC provider: discovery at
`/oauth/openid-configuration.php`, documented scope `openid profile email`,
authorization-code + PKCE. WHMCS access/ID tokens are minted for WHMCS
(`iss` = System URL, ID token `aud` = the WHMCS OAuth client id), not for
`MCP_OAUTH_RESOURCE`. Presenting a raw WHMCS Bearer to MCP fails RFC 8707.

## Decisions

### ADR-2.1 — Two doors, one ledger

Staff vs customer. Audience is derived from the **principal** (consumer id
and/or OIDC `sub` allow-list), never from a tool argument or the model.

### ADR-2.2 — Split “who” and “what the process may touch”

- **Who:** WHMCS OIDC (ID token + userinfo). OIDC scope **SHOULD** stay
  `openid profile email` unless a later probe documents more.
- **Staff what:** Admin API identifier/secret + API role +
  `MCP_STAFF_CONSUMER_IDS` ∪ `MCP_STAFF_OIDC_SUBS` + write gate.
- **Customer what:** delegated `clientarea:*` **when proven** on this install,
  **and** `grok_channel_safe` projection. Until proven: link/handoff only.
  Never the full admin surface.

### ADR-2.3 — MCP is RS; WHMCS is AS/IdP; do not confuse tokens

**Chosen pattern: federation.** An operator-run authorization server (or hosted
IdP) uses WHMCS OIDC as the identity source and issues **MCP-audience** access
tokens (`aud` = `MCP_OAUTH_RESOURCE`). Grok/MCP clients follow PRM → that AS.
This maps to the existing `tokenVerifier`.

RFC 8693 token exchange is the documented alternate (WHMCS token in, MCP-aud
token out). It is not implemented in this repo.

**Not compliant:** Grok sends a WHMCS access or ID token to MCP HTTP as
`Authorization: Bearer` without audience mapping. The verifier **MUST** reject
tokens whose `iss` is the WHMCS origin (`MCP_WHMCS_OIDC_ISSUER` or the origin
of `WHMCS_API_URL`), even if that origin was mistakenly listed in
`MCP_OAUTH_ISSUERS`. Reason code: `whmcs_token_not_mcp_audience`.

### ADR-2.4 — Stdio default token is a local escape hatch

`MCP_DEFAULT_CONSUMER_AUTH_TOKEN` is `MCP_ENV=local` / local Cursor only.
Production Grok **MUST** use HTTP + MCP-aud tokens. Stdio docs **MUST NOT**
claim OAuth-on-stdio.

### ADR-2.5 — WHMCS `clientarea:*` is the customer scope vocabulary

Do not invent `whatsapp:invoice` scopes. Map jobs to official scopes
(`clientarea:invoices`, `clientarea:tickets`, `clientarea:profile`,
`clientarea:sso`, …). On 8.13.7 these are **SSO Client Area destinations**, not
proven External API grants. Missing or unproven scope → honest
`capability_unavailable` / `link_required`, not Admin API impersonation.

### ADR-2.6 — Multi-client users (WHMCS 8+ user model)

OIDC identifies a **user**. A user **MAY** have several clients. Customer door
**MUST** confirm client context; staff **MAY** pick a `clientid`. Never guess.
When an email (or OIDC-linked user) is present, a requested `clientid` **MUST**
be in that principal's client list.

### ADR-2.7 — WhatsApp is not the OAuth user-agent

OAuth 2.1 authorization code + PKCE in the **browser** once. Grok stores
refresh material in **its** secret store (outside this repository). Each MCP
call carries a short-lived **MCP-aud** access token. Unlinked chat: link prompt
or handoff only. WhatsApp bind/refresh **MUST NOT** live in this repo.

## Forbidden

- Production Grok identity = `MCP_DEFAULT_CONSUMER_AUTH_TOKEN`
- Bearer WHMCS token on MCP without RFC 8707 / federation
- `ValidateLogin`, password collection, or `CreateOAuthCredential` from the bot
- Auto-privileged profile from an unknown `sub`
- Shared staff/customer token
- WhatsApp transport inside this repository

## Consequences

- HTTP Grok path: PRM + 401 challenge + MCP-aud tokens + staff allow-list.
- `mcp_doctor` warns if `MCP_OAUTH_ISSUERS` includes the WHMCS origin.
- Customer `ops_ask` jobs stay link/handoff until Phase 0 proves user APIs.
- Staff jobs stay on the Admin API machine credential.
