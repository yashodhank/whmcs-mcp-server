# Testing Read-Only in Cursor

Short runbook for manually verifying that the WHMCS MCP server’s read-only tools and resources work against a real WHMCS instance from Cursor.

## Prerequisites

1. **Build**: Run `npm run build` so `dist/index.js` exists (MCP config points at it).
2. **MCP config**: Cursor must use this project’s MCP server. Copy [cursor-mcp-config.json](../cursor-mcp-config.json) into **Cursor Settings → MCP → Edit config**, or ensure the workspace’s config is the one Cursor loads.
3. **WHMCS access**: If WHMCS has an API IP allowlist, the machine running Cursor must be allowed.

## Read-Only Tools to Try

| Tool                        | Example ask / params                                      |
| --------------------------- | --------------------------------------------------------- |
| `list_products`             | “List WHMCS products” or call with `limit: 10`            |
| `get_ticket_departments`    | “List support departments” (no params)                    |
| `check_domain_availability` | “Check if example.com is available” / `domain: "example.com"` |
| `search_clients`            | “Search clients” / `search: "test"`, `limit: 5` (admin-only; skip in client mode) |
| `get_client_details`        | “Get client details for client 1” / `clientid: 1` (use a real ID from prod) |
| `get_invoice`               | “Get invoice 1” / `invoiceid: 1` (use a real ID)          |
| `get_service_details`       | “Get service details for service 1” / `serviceid: 1` (use a real ID) |

## Resources to Try

- **`whmcs://docs/ops-playbook`** — no path params.
- **`whmcs://clients/{id}/summary`** — replace `{id}` with a real client ID.
- **`whmcs://system/activity`** — admin-only; in client mode it should return an error.

## What Success Looks Like

- **Tools**: Responses are JSON with expected shape (e.g. `clients`, `products`, `invoiceid`, or `error`) and no stack traces.
- **Resources**: Markdown or JSON; URIs in responses do **not** contain `?token=...` (SEC-002).
- **Read-only mode**: Write tools (e.g. `mark_invoice_paid`) return a clear “not available in read_only mode” style error.

## If You Get 403 or Auth Errors

- WHMCS API is likely IP-restricted or credentials differ for the environment.
- Document that the WHMCS API IP allowlist must include the machine running Cursor.
- A successful `search_clients` call does not prove invoice/service actions are authorized. Verify at least one tool per domain (`get_invoice`, `get_service_details`, `get_ticket_departments`) before declaring the environment healthy.
- Integration tests are written to skip (not fail) when the API returns 403 or is unreachable; see [tests/integration.test.ts](../tests/integration.test.ts) and the README section on integration tests.

## Related

- [README – Verifying read-only in Cursor](../README.md#verifying-read-only-in-cursor)
- [README – Integration tests and 403 / unreachable API](../README.md#integration-tests-and-403--unreachable-api)
- [docs/ai-agent-local-runbook.md](ai-agent-local-runbook.md)
- [docs/cursor-skills.md](cursor-skills.md)
