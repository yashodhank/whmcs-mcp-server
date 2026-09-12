# ADR-0001 — MCP baseline is production WHMCS 8.13.7

Status: **accepted** (2026-09-12)

## Context

Production WHMCS is **8.13.7** (LTS, security-only vs earlier 8.13.x). WHMCS 9.x
adds invoice immutability, credit/debit notes, and Buy Flow REST. Those are not
on this install. Grok/WhatsApp identity must not be a shared stdio token.

## Decisions

1. Design jobs, OIDC, and the Admin External API for **8.13**. Do not require
   9.x credit notes, immutable invoices, or Nexus/Buy Flow REST.
2. Keep the version-family fork (`8.13` | `8.x` | `9.x`). 9.x write rules apply
   only when `getWhmcsVersionProfile().family === '9.x'`.
3. **Who:** WHMCS OIDC `sub` is a User. Map to clients with `GetClients` /
   `GetClientsDetails` (GetUsers is a real 8.0+ action but is **not** on the
   read allowlist; prod role historically `not_authorized`). Never guess
   `clientid` when more than one client matches.
4. **Staff what:** Admin API machine credential + `MCP_STAFF_CONSUMER_IDS`.
5. **Customer what:** link/handoff until a user-delegated API is proven on
   **this** 8.13.7. Official `clientarea:*` SSO destinations are not API grants.
6. A WHMCS access/ID token **MUST NOT** be accepted as an MCP Bearer unless
   `aud` names `MCP_OAUTH_RESOURCE` (RFC 8707). Federation or RFC 8693 required.
7. `ValidateLogin`, password collection, and `CreateOAuthCredential` from the
   bot are forbidden.
8. `billing:invoice:update` remains a gated 8.13 write. It is blocked for
   non-draft invoices only on 9.x.
9. Stdio `MCP_DEFAULT_CONSUMER_AUTH_TOKEN` is a **local** escape hatch, not
   production Grok identity.
10. Credit-note reads stay unverified and 9.x-only.

## Consequences

- `ops_ask` staff jobs use invoices + transactions + client credit.
- Ticket inbox does not use `GetTickets`+`clientid` alone.
- `mcp_doctor` records discovery, JWKS, API role, and staff allow-list gaps.
- Local dual-stack 9.0 remains for a future upgrade, not for current Grok jobs.
