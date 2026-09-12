# WhatsApp bind lives outside this MCP

Status: operational rule (ADR-0002.7)

This repository is an MCP **resource server** plus a stdio local escape hatch.
It does **not** implement WhatsApp transport, phone-number identity, or OAuth
refresh storage for Grok / Business WhatsApp.

## What happens where

| Step | Where |
|---|---|
| Human proves they are a WHMCS user | Browser: WHMCS OIDC authorization code + PKCE (`openid profile email`) |
| Federation AS mints MCP-audience token | Operator-run AS (`aud` = `MCP_OAUTH_RESOURCE`) — not WHMCS `api.php` |
| Refresh / bind store | Grok / xAI secret store (outside this repo) |
| Each MCP call | Short-lived MCP-aud Bearer on HTTP |
| Unlinked WhatsApp chat | Link prompt or staff handoff only — never a billing card |

## Rules

- WhatsApp number is **not** a WHMCS client id.
- Do not send `ValidateLogin` or passwords in chat.
- Do not present a WHMCS access or ID token as the MCP Bearer.
- Do not add WhatsApp webhooks, Cloud API clients, or bind tables here.

See [grokbot-stdio-access.md](grokbot-stdio-access.md) for the **local** stdio
escape hatch (not production Grok identity).
