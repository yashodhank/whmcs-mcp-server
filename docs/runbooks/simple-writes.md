# Simple writes (default operator model)

Governance is **optional**. The default path for production writes does not require `MCP_GOVERNANCE_ENABLED`, consumer registries, or multi-step approval ceremonies.

## Defaults

```bash
MCP_GOVERNANCE_ENABLED=false
MCP_MODE=read_only          # set full for writes
```

## Enabling writes

1. Set `MCP_MODE=full`.
2. Point `MCP_PROD_WRITE_AUTHORIZED_FILE` at a JSON allowlist (owner-only).
3. Set `MCP_WRITE_AUDIT_PATH` when the prod allowlist is non-empty (fail-closed).

Low/medium scopes are **audit-gated** once the consumer can execute. High-risk money scopes still require allowlist + human approval + caps unless explicitly configured.

## Destructive scopes (typed confirmation only)

Destructive delete/remove scopes (`service:terminate`, `client:contact:delete`, …) are sealed by default. To enable one:

```bash
MCP_WRITE_DESTRUCTIVE_CONFIRM_PHRASE='YOUR-EXACT-PHRASE'
MCP_WRITE_ALLOW_DESTRUCTIVE_SCOPES='client:contact:delete'
```

The intent must include `confirmation` **exactly equal** to the phrase. No distinct approver, caps, or allowlist is required for destructive scopes once unblocked — phrase only.

The confirmation value is never logged.

## WHMCS version

Version family (`8.13` / `8.x` / `9.x`) is probed lazily via `WhmcsDetails` (15-minute cache). WHMCS 9 billing advisories apply only on 9.x installs; `billing:invoice:update` is blocked for non-draft invoices on 9.x.

## Optional governance

Set `MCP_GOVERNANCE_ENABLED=true` and configure `MCP_CONSUMER_REGISTRY` for consumer projection. See [production-governed-writes.md](./production-governed-writes.md).

## Related

- [production-governed-writes.md](./production-governed-writes.md) — full ceremony (optional)
- [api-connectivity-troubleshooting.md](./api-connectivity-troubleshooting.md) — 403 / IP heal
- [write-capability-probe.md](./write-capability-probe.md) — scope promotion evidence
