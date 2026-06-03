# WHMCS MCP Server

A production-ready **Model Context Protocol (MCP)** server that enables AI agents (via Cursor or other MCP hosts) to administrate WHMCS installations through the External API.

For agent/contributor orientation (architecture, governance, write-flow, doc map), see **[AGENTS.md](AGENTS.md)**.

## Features

- **~50 MCP tools** across several layers:
  - **Legacy WHMCS actions** — clients, billing, orders, services, domains, support (direct API wrappers; batch-friendly `get_invoice` / `get_client_details`)
  - **Governed list & reporting** — per-client lists (`list_client_*`), global `list_invoices` / `list_services`, `get_activity_log`
  - **Aggregators** — `get_account_360`, `get_billing_snapshot`, `get_support_snapshot`, `get_renewal_snapshot`
  - **Capability & probes** — `get_capability_matrix`, `get_stats`, transactions, automation log, todo items (`list_users` remains unverified — see [docs/getusers-investigation.md](docs/getusers-investigation.md))
  - **Controlled write-flow** — `draft_write_intent` → `validate_write_intent` → `approve_write_intent` → `execute_write_intent` → `get_write_intent` (production deny-by-default; scopes include e.g. `service:price_restore`, `service:domain_rename`)

- **7 MCP resources** for passive context:
  - Client summary and activity log
  - Invoice history and ticket thread
  - System activity (admin)
  - Ops playbook (`whmcs://docs/ops-playbook`)
  - WHMCS 8.13 / 9.x compatibility (`whmcs://docs/compat-9x`)

- **Opt-in governance (Phase B)** — consumer registry, data contracts, and projection boundary (`MCP_GOVERNANCE_ENABLED`). See [docs/PHASE_B_GOVERNANCE.md](docs/PHASE_B_GOVERNANCE.md).

- **Safety Features**:
  - Three operation modes: `read_only`, `simulate`, `full`
  - Rate limiting with configurable limits
  - Idempotency protection for high-risk operations
  - Tool allowlist for principle of least privilege
  - Large refund threshold warnings (configurable via `MCP_LARGE_REFUND_THRESHOLD`, default $1000)
  - Unpaid invoice warnings before service termination
  - Failed capture detection before payment retry
  - Input sanitization (HTML tags, control characters)
  - Email/domain normalization and validation (IDN support)
  - Graceful shutdown with cleanup
  - Retry policy with exponential backoff for transient errors
  - `WHMCS_API_URL` HTTPS enforcement (with explicit `WHMCS_ALLOW_HTTP` for local dev only)
  - Configurable client custom-field labels (`MCP_CLIENT_CUSTOM_FIELD_LABELS`)

## Documentation

| Topic | Doc |
|-------|-----|
| Agent / contributor guide | [AGENTS.md](AGENTS.md) |
| Local operator runbook | [docs/ai-agent-local-runbook.md](docs/ai-agent-local-runbook.md) |
| Governance & contracts | [docs/PHASE_B_GOVERNANCE.md](docs/PHASE_B_GOVERNANCE.md) |
| Controlled writes | [docs/phase-f-controlled-write-automation.md](docs/phase-f-controlled-write-automation.md) |
| Production write runbook | [docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md](docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md) |
| Capability probes | [docs/capability-probe-runbook.md](docs/capability-probe-runbook.md) |
| Read-only testing | [docs/testing-readonly.md](docs/testing-readonly.md) |
| Production test program | [docs/whmcs-mcp-production-test-program.md](docs/whmcs-mcp-production-test-program.md) |
| Local WHMCS stack | [docs/local-whmcs-testing.md](docs/local-whmcs-testing.md) |
| App examples (`structuredContent`) | [examples/README.md](examples/README.md) |
| Cursor skills | [docs/cursor-skills.md](docs/cursor-skills.md) |

## Ops + Dev Deep Dive

### System Architecture

- **Transport boundary**: MCP host (Kilo/Cursor/Claude) communicates with this server over stdio JSON-RPC.
- **Server core**: `src/index.ts` wires configuration, tool/resource registration, and runtime policy gates.
- **Policy layer**: mode (`read_only`/`simulate`/`full`), access mode (`admin`/`client`), allowlists, and capability registry checks.
- **WHMCS adapter**: `src/whmcs/WhmcsClient.ts` handles request shaping, retries, normalization, and error mapping.
- **Governance primitives**: capability matrix, read allowlist, controlled writes (intent/approval/execute), and immutable audit trail.

### Execution Flow

1. MCP host invokes a tool with validated input schema.
2. Mode and access checks run before any WHMCS API call.
3. Tool maps arguments to WHMCS action + params.
4. WHMCS response is normalized (`array|object|string` edge handling).
5. Output returns as deterministic JSON; failures return structured errors.

### Ops Use Cases

- **Production-safe read operations**: account snapshots, invoice lookups, service/domain/ticket context.
- **Governed write operations**: draft intent -> validate -> human approval -> execute with caps and audit.
- **Incident triage**: separate transport failures, auth failures, capability gate failures, and business-rule denials.
- **Upgrade compatibility**: WHMCS 9 immutable invoice behavior represented in read/write semantics.
- **Least-privilege deployments**: client-scoped mode with bounded client IDs for support/chatbot scenarios.

### Developer Use Cases

- **Tool-first integration testing**: unit + integration + production test harness (`scripts/mcp-production-test-program.mjs`).
- **Schema-first evolution**: zod-validated contracts for stable agent behavior.
- **Composable tooling**: individual API tools plus composite workflows for reconciliation and snapshots.
- **Environment profiling**: `.env` base with `MCP_ENV` overlays (`.env.local`, `.env.staging`, etc.).
- **Local reproducibility**: full dual-WHMCS disposable stack for end-to-end behavior parity.

### Connected-but-403 Troubleshooting Matrix

`Connected` in MCP only confirms stdio transport health. `403` is usually downstream authorization/policy.

| Symptom | Likely Layer | Fast Check | Fix |
|---|---|---|---|
| All tools fail immediately | MCP auth or server boot config | Verify server starts and tool list is visible | Fix MCP config/env and restart host |
| Some tools work, invoice tools 403 | WHMCS API role/action ACL | Compare `search_clients` vs `get_invoice`/`GetInvoices` | Grant missing WHMCS API actions to credential role |
| Works from one host, fails from another | IP allowlist / egress path | Compare public IPv4/IPv6 for each host | Add both IPs or route through fixed egress |
| `consumer denied` or capability unavailable payload | Governance policy | Check access mode + capability matrix | Update consumer/registry/policy instead of WHMCS |
| Resource reads work, tool calls fail | Tool auth or action gate | Confirm whether `MCP_AUTH_TOKEN` is required | Pass valid `auth_token` in tool calls |

## AI Agent Local Runbook

Use [docs/ai-agent-local-runbook.md](docs/ai-agent-local-runbook.md) for a practical operator guide that covers:

- where local MCP and WHMCS config files are typically located,
- how to diagnose 403s by layer,
- what to validate before running billing/report tasks,
- and how to keep host-specific configurations aligned.

## Installation

```bash
# Clone or copy the project
cd whmcs-mcp-server

# Install dependencies
npm install

# Build
npm run build
```

## Docker

Build and run with Docker:

```bash
# Build image
npm run docker:build

# Run with docker-compose
npm run docker:run

# Or manually
docker run -it \
  -e WHMCS_API_URL=https://billing.example.com \
  -e WHMCS_IDENTIFIER=your_identifier \
  -e WHMCS_SECRET=your_secret \
  -e WHMCS_ACCESS_KEY= \
  -e MCP_AUTH_TOKEN= \
  -e MCP_ACCESS_MODE=admin \
  -e MCP_MODE=read_only \
  whmcs-mcp-server
```

## Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

**Required Variables:**

| Variable           | Description                                               |
| ------------------ | --------------------------------------------------------- |
| `WHMCS_API_URL`    | Your WHMCS base URL (e.g., `https://billing.example.com`) |
| `WHMCS_IDENTIFIER` | API identifier from WHMCS API Credentials                 |
| `WHMCS_SECRET`     | API secret from WHMCS API Credentials                     |

**Optional Variables:**

| Variable             | Default     | Description                                     |
| -------------------- | ----------- | ----------------------------------------------- |
| `MCP_ENV`            | `production` | Env profile: `local`, `staging`, `production`. Layers `.env.<MCP_ENV>` over base `.env`. See [Local WHMCS dev/test](#local-whmcs-devtest). |
| `MCP_MODE`           | `read_only` | Operation mode: `read_only`, `simulate`, `full` |
| `MCP_ACCESS_MODE`    | `admin`     | Access mode: `admin` (full) or `client` (scoped) |
| `MCP_ALLOWED_CLIENT_IDS` | (empty) | Comma-separated client IDs allowed in `client` mode |
| `MCP_AUTH_TOKEN`     | (empty)     | Optional shared secret required on tool calls (`auth_token` param). Not used for resource reads. |
| `MCP_RATE_LIMIT`     | `10`        | Max WHMCS API calls per second                  |
| `MCP_DEBUG`          | `false`     | Enable verbose logging                          |
| `MCP_MAX_PAGE_SIZE`  | `100`       | Maximum pagination size                         |
| `MCP_TOOL_ALLOWLIST` | (empty)     | Comma-separated list of allowed tools           |
| `MCP_LARGE_REFUND_THRESHOLD` | `1000` | Refunds above this amount require `confirm_large_refund: true` |
| `MCP_CLIENT_CUSTOM_FIELD_LABELS` | (empty) | Comma-separated `fieldId:label` overrides for client custom fields |
| `MCP_GOVERNANCE_ENABLED` | `false` | Opt-in consumer-aware projection for reads (see Phase B docs) |
| `MCP_ALLOW_ANON_LLM` | `false` | Allow anonymous `llm_safe_summary` fallback when governance is on |
| `MCP_CONSUMER_REGISTRY` | (empty) | JSON consumer registry (`token_sha256` only — see consumer-registry example) |
| `MCP_PROD_WRITE_AUTHORIZED` | (empty) | Comma-separated WHMCS actions allowed for production write execution |
| `MCP_WRITE_EXECUTION_AUTHORIZED` | (empty) | Non-prod runtime write allowlist |
| `MCP_WRITE_KILL_SWITCH` | `false` | Emergency block on controlled writes |
| `MCP_WRITE_AUDIT_PATH` | (empty) | Durable audit log path (required when prod writes are allowlisted) |
| `MCP_WRITE_IDEMPOTENCY_PATH` | (empty) | Durable idempotency store path |
| `MCP_PROD_HIGH_RISK_PER_ACTION_CAP` | `0` | Per-action cap for high-risk write scopes |
| `MCP_PROD_HIGH_RISK_DAILY_CAP` | `0` | Daily aggregate cap for high-risk writes |
| `WHMCS_ACCESS_KEY`   | (empty)     | Optional WHMCS API access key (for IP restricted setups) |
| `WHMCS_ALLOW_HTTP`   | `false`     | Allow an `http://` `WHMCS_API_URL` (not recommended; credentials sent in clear). Otherwise `https` is required. |

## Usage with Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "whmcs": {
      "command": "node",
      "args": ["/path/to/whmcs-mcp-server/dist/index.js"],
      "env": {
        "WHMCS_API_URL": "https://billing.example.com",
        "WHMCS_IDENTIFIER": "your_identifier",
        "WHMCS_SECRET": "your_secret",
        "WHMCS_ACCESS_KEY": "",
        "MCP_AUTH_TOKEN": "",
        "MCP_ACCESS_MODE": "admin",
        "MCP_ALLOWED_CLIENT_IDS": "",
        "MCP_MODE": "read_only"
      }
    }
  }
}
```

## Available Tools

### Client Management

- `create_client` - Create or reuse existing client by email
- `search_clients` - Search clients by name/email/company
- `get_client_details` - Get full client details
- `update_client` - Update client details
- `get_service_details` - Get detailed service information

### Billing & Financial

- `get_invoice` - Get invoice with line items and transactions
- `mark_invoice_paid` - Mark invoice as paid
- `record_refund` - Record a refund (WHMCS only, not gateway)
- `capture_payment` - Capture payment on stored method
- `create_invoice` - Create invoice with line items
- `add_credit` - Add credit to client account
- `apply_credit` - Apply credit to an invoice

### Orders & Products

- `list_products` - List available products
- `accept_order` - Accept a pending order

### Service Lifecycle

- `suspend_service` - Suspend an active service
- `unsuspend_service` - Unsuspend a service
- `terminate_service` - Permanently terminate (requires confirm=true)

### Domains

- `check_domain_availability` - Check if domain is available
- `register_domain` - Register a domain with registrar
- `renew_domain` - Renew a domain
- `transfer_domain` - Initiate domain transfer
- `sync_domain` - Domain sync is cron-based in WHMCS (no External API endpoint)

### Support

- `create_ticket` - Create a support ticket
- `reply_ticket` - Reply to ticket (client/admin/note)
- `get_ticket_departments` - List support departments

### Governed lists & reporting

- `list_client_services`, `list_client_domains`, `list_client_invoices`, `list_client_tickets`, `list_client_orders` — paginated per-client lists (honest client-side filters where WHMCS lacks server-side status filters)
- `list_invoices`, `list_services` — global reporting lists (paid revenue, paying clients, etc.)
- `get_activity_log` — activity log with canonical mapping when governance is enabled
- `get_ticket_thread` — full ticket thread (tool; also available as resource URI)

### Aggregators & capability

- `get_account_360`, `get_billing_snapshot`, `get_support_snapshot`, `get_renewal_snapshot`
- `get_capability_matrix` — version/capability status for integrators
- `list_client_transactions`, `get_stats`, `get_todo_items`, `get_automation_log`
- `list_users` — present but **unverified** on production matrix (do not rely without probe)

### Controlled write-flow (Phase F–G+)

These tools perform **no WHMCS mutation** until `execute_write_intent` passes the execution gate (and `MCP_MODE` / authorizer allowlists permit the underlying action):

- `draft_write_intent`, `validate_write_intent`, `approve_write_intent`, `execute_write_intent`, `get_write_intent`

Scopes are consumer-gated and environment-sealed by default in production. See [docs/phase-f-controlled-write-automation.md](docs/phase-f-controlled-write-automation.md).

## Authentication & Access Modes

### Shared-Secret Auth (Optional, tool calls only)
If `MCP_AUTH_TOKEN` is set, every tool call must include an `auth_token` parameter that matches it. This applies to **tool calls only**.

Example tool call payload:
```json
{
  "auth_token": "your_shared_secret",
  "invoiceid": 123
}
```

**Resources are not authenticated via a URI-query token.** This server speaks
MCP over **stdio**, so the process that launches it is the trust boundary, and
the MCP SDK's `$`-anchored URI matching makes a `?token=` query on resource
URIs unworkable (the read would 404 before any auth code runs). MCP resources
are instead protected by process/transport isolation plus the access-mode and
client-scope guardrails below. Keep `MCP_AUTH_TOKEN`, `WHMCS_*` secrets, and
local config files out of version control.

### Access Modes
This server always uses WHMCS **admin** API credentials under the hood. `MCP_ACCESS_MODE=client` adds an extra guardrail layer to prevent cross-client access and admin actions.

**Client mode requires**:
- `MCP_ALLOWED_CLIENT_IDS` to scope all client operations

**Client mode allows only:**
- `check_domain_availability`
- `list_products`
- `get_invoice` (scoped to allowed client IDs)
- `get_client_details` (scoped)
- `get_service_details` (scoped)
- `create_ticket` (scoped)
- `reply_ticket` (client replies only, scoped)
- `get_ticket_departments`
- Resources: client-summary, invoice-history, ticket-thread, client-log, ops-playbook

**Admin-only tools blocked in client mode:**
- `create_client`, `search_clients`, `update_client`
- `mark_invoice_paid`, `record_refund`, `capture_payment`, `create_invoice`, `add_credit`, `apply_credit`
- `accept_order`
- `suspend_service`, `unsuspend_service`, `terminate_service`
- `register_domain`, `renew_domain`, `transfer_domain`, `sync_domain`
- Resource: system-activity

For **chatbots** and customer-facing integrations, run in `client` mode with a strict allowlist and a dedicated WHMCS API role. For **admin workflows** (Cursor IDE, internal ops), use `admin` mode.

### Real-World Isolation Patterns
- **Two MCP instances**: one `client` mode (low-privilege WHMCS API role), one `admin` mode (full role), each with separate credentials and tokens.
- **Per-tenant instances**: run one MCP server per client or tenant and set `MCP_ALLOWED_CLIENT_IDS` to a single ID.
- **Network controls**: restrict WHMCS API access by IP and use `WHMCS_ACCESS_KEY` for IP-restricted setups.
- **Least-privilege API roles**: in WHMCS, define roles with only the exact API actions needed by each MCP instance.

## Operation Modes

| Mode        | Behavior                                                        |
| ----------- | --------------------------------------------------------------- |
| `read_only` | Only read operations work. Write operations return error.       |
| `simulate`  | Write operations log but don't execute. Returns mock responses. |
| `full`      | All operations execute against WHMCS.                           |

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Type check
npm run lint

# Build for production
npm run build

# Start production server
npm start
```

## Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests (requires WHMCS credentials in .env)
npm run test:integration

# Run tests with coverage
npm run test:coverage
```

**Test Safety:**

- Integration tests are READ-ONLY by default
- Write operations are SKIPPED unless `MCP_TEST_WRITE_MODE=true`
- Never run write tests against production data

**Integration tests and 403 / unreachable API:**

- Integration tests call the WHMCS API directly (using `.env` credentials). If the test runner's IP is not in the WHMCS API allowlist, or the API is unreachable, the API may return **403** or a network error.
- In that case, the integration test run **skips** all live API tests with a clear message (e.g. "WHMCS API returned 403; skipping integration tests (check IP allowlist and credentials)").
- To skip integration tests entirely (e.g. in CI where WHMCS is never reachable), set `MCP_INTEGRATION_SKIP=1`.

### Local WHMCS dev/test

For full end-to-end testing (including **write** tools) against a disposable
local WHMCS instead of read-only-against-production, this repo ships a
self-contained dual stack (WHMCS **8.13** @ `localhost:8813` and **9.0** @
`localhost:8890`) via `docker-compose.whmcs-test.yml` + `npm run whmcs:test:*`:

No install wizard: both legs are populated by a non-wizard DB-snapshot
restore. Pick **one** seed path:

```bash
npm run whmcs:test:source && npm run whmcs:test:licenses
npm run whmcs:test:up && npm run whmcs:test:license-install
# Primary: prod-derived, PII-scrubbed data into both legs, then run the 8→9 migration:
npm run whmcs:test:seed-prod && npm run whmcs:test:upgrade9
# (or) Clean fallback: pristine fresh-install snapshot, no prod data:
#   npm run whmcs:test:bootstrap
npm run whmcs:test:fixup && npm run whmcs:test:snapshot
# create/regenerate API creds in the local WHMCS admin (admin / DevOnly#2026!secure), then:
cp .env.local.example .env.local      # fill WHMCS_IDENTIFIER / WHMCS_SECRET
MCP_ENV=local npm run build && MCP_ENV=local npm test
```

Prod-derived data and `deploy/whmcs-test/.prodseed/` are gitignored and never
committed (the raw dump is deleted right after PII scrubbing).

`MCP_ENV` selects the env profile (`.env.<MCP_ENV>` layered over base `.env`);
the `local` profile targets the local stack over http (SEC-005 stays strict
for staging/production). Full runbook: **[docs/local-whmcs-testing.md](docs/local-whmcs-testing.md)**.

### Verifying read-only in Cursor

To confirm read-only tools and resources work against a real WHMCS instance from Cursor:

1. **Prerequisites:** Run `npm run build` so `dist/index.js` exists. Ensure Cursor is using this project's MCP server (e.g. copy [cursor-mcp-config.json](cursor-mcp-config.json) into **Cursor Settings → MCP → Edit config**). If WHMCS has an API IP allowlist, ensure the machine running Cursor is allowed.
2. **Read-only tools to try:** `list_products`, `get_ticket_departments`, `check_domain_availability`, `search_clients` (admin mode), `get_client_details`, `get_invoice`, `get_service_details` (use real IDs from your WHMCS).
3. **Resources to try:** `whmcs://docs/ops-playbook`, `whmcs://clients/{id}/summary`, `whmcs://system/activity` (admin).
4. **Success looks like:** Tool calls return JSON with expected shape (e.g. `clients`, `products`, `invoiceid`) and no stack traces. Resources read without any `auth_token`/`token` and respect `MCP_ACCESS_MODE`. In `read_only` mode, write tools (e.g. `mark_invoice_paid`) return a clear "not available in read_only mode" error.

See [cursor-mcp-config.json](cursor-mcp-config.json) for the reference MCP config and [docs/cursor-skills.md](docs/cursor-skills.md) for recommended Cursor skills.

## Security Considerations

- Never expose the MCP server directly to untrusted clients
- Use `MCP_TOOL_ALLOWLIST` to restrict available tools per deployment
- Start with `read_only` mode and only enable `full` when needed
- Keep `WHMCS_SECRET` and `MCP_AUTH_TOKEN` secure and rotate regularly
- All logs go to stderr (stdout reserved for JSON-RPC)
- Sensitive data (passwords, secrets, CVV) is automatically redacted from logs
- Auth tokens are compared in constant time and are never returned in resource URIs (query params are stripped from responses)

## Technical Details

- **Retry Policy**: 3 retries with exponential backoff (1-10s) for 5xx errors
- **Rate Limiting**: Token bucket algorithm with configurable rate
- **Idempotency**: High-risk operations cached for 60s to prevent duplicates
- **Input Sanitization**: HTML tags and control characters removed from user input
- **Graceful Shutdown**: SIGTERM/SIGINT handlers clean up timers and connections

## Cursor Skills

This project uses [antigravity-awesome-skills](https://github.com/sickn33/antigravity-awesome-skills) with Cursor. Install once with:

```bash
npx antigravity-awesome-skills --cursor
```

Then in Cursor chat use `@skill-name` (e.g. `@mcp-builder`, `@api-security-best-practices`, `@typescript-expert`). Recommended bundles for this repo: **Security Developer** and **Agent Architect** from [docs/BUNDLES.md](https://github.com/sickn33/antigravity-awesome-skills/blob/main/docs/BUNDLES.md). A full curated list with rationale is in [docs/cursor-skills.md](docs/cursor-skills.md).

## Development Standards

This project follows strict AI coding rules to ensure production-grade quality, security, and maintainability.

**Core Principles:**

1. **Correctness & Security** (Sanitize inputs, secure secrets, handle errors explicitly)
2. **Readability & Maintainability** (Clean Architecture, SOLID, DRY)
3. **Idiomatic Style** (Strict TypeScript, consistent formatting)
4. **Performance** (Efficient algorithms, proper resource management)

For detailed rules, see [.cursorrules](.cursorrules) and [.cursor/rules/whmcs-mcp-server.mdc](.cursor/rules/whmcs-mcp-server.mdc).

## License

ISC
