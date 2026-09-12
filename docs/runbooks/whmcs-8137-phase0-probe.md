# Phase 0 probe — production WHMCS 8.13.7

Read-only evidence collection. No credential rotation. No production writes
except a throwaway OpenID app if an operator explicitly creates one.

## What this environment already recorded (2026-09-12)

Public HTTPS only (no Admin API identifier/secret in the agent environment):

| Check | Result |
|---|---|
| `{origin}/oauth/openid-configuration.php` | **200** — issuer `https://my.securiace.com`; authorize/token/userinfo/jwks present; `scopes_supported` = `openid`, `email`, `profile`; `id_token_signing_alg_values_supported` = `RS256`; `claims_supported` = `iss`, `aud`, `exp`, `sub`; `response_types_supported` = `[]` |
| `/.well-known/openid-configuration` | **404** — rewrite not installed |
| `{origin}/oauth/certs.php` | **200** body `{ "keys": [] }` — JWKS empty |
| Auth-code + PKCE | **PENDING** — needs a throwaway OpenID app + human login |
| Userinfo with access token | **PENDING** — depends on the code exchange |
| `tbloauthserver_scopes` | **PENDING** — admin/DB |
| User access token vs admin `api.php` | **PENDING** — go/no-go for the customer door |
| `GetConfigurationValue(Version)` / `GetAdminDetails.whmcs` | **PENDING** — last recorded `8.13.6-release.1` (2026-09-02); operator baseline **8.13.7** |
| `WhmcsDetails` | Last recorded HTTP 403 `invalid_permissions` |
| `GetUsers` | Last recorded `not_authorized` for the production API role |
| Buy Flow REST | **Not probed** — absent on 8.13.7 |
| `UpdateInvoice` / `MergeTicket` | **Not executed** on production |

## Script (when credentials exist)

```bash
# read-only; never prints identifier/secret
node scripts/mcp-whmcs-8137-phase0-probe.mjs
```

Requires `WHMCS_API_URL`, `WHMCS_IDENTIFIER`, `WHMCS_SECRET`. Records version,
`GetUsers` role outcome, OIDC discovery, and JWKS key count. Does not perform
authorization-code login and does not call write actions.

Copy facts into [OPERATIONS-HANDOFF.md](../OPERATIONS-HANDOFF.md). Unknowns stay
`PENDING` with an owner — do not guess token shape (JWT vs opaque access
token is still **PENDING**). Federation is the chosen MCP-audience pattern
([ADR-0002](../design/adr/0002-mcp-rs-whmcs-oidc.md)); do not accept a raw
WHMCS Bearer on the MCP HTTP resource server.
