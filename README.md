# WHMCS MCP Server

A production-ready **Model Context Protocol (MCP)** server that enables AI agents (via Cursor or other MCP hosts) to administrate WHMCS installations through the External API.

## Features

- **24 MCP Tools** for comprehensive WHMCS management:
  - Client management (create, search, get details, update)
  - Billing operations (invoices, payments, refunds, credits)
  - Order processing (products, accept orders)
  - Service lifecycle (suspend, unsuspend, terminate, details)
  - Domain management (availability, register, renew, transfer, sync)
  - Support ticketing (create, reply, departments)

- **6 MCP Resources** for passive context:
  - Client summaries
  - Client activity log (recent orders, invoices, tickets)
  - Invoice history
  - Ticket threads
  - System activity (global activity + admin logs)
  - Ops playbook

- **Safety Features**:
  - Three operation modes: `read_only`, `simulate`, `full`
  - Rate limiting with configurable limits
  - Idempotency protection for high-risk operations
  - Tool allowlist for principle of least privilege
  - Large refund threshold warnings ($1000)
  - Unpaid invoice warnings before service termination
  - Failed capture detection before payment retry
  - Input sanitization (HTML tags, control characters)
  - Email/domain normalization and validation (IDN support)
  - Graceful shutdown with cleanup
  - Retry policy with exponential backoff for transient errors

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
| `MCP_MODE`           | `read_only` | Operation mode: `read_only`, `simulate`, `full` |
| `MCP_RATE_LIMIT`     | `10`        | Max WHMCS API calls per second                  |
| `MCP_DEBUG`          | `false`     | Enable verbose logging                          |
| `MCP_MAX_PAGE_SIZE`  | `100`       | Maximum pagination size                         |
| `MCP_TOOL_ALLOWLIST` | (empty)     | Comma-separated list of allowed tools           |

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
- `sync_domain` - Sync domain status with registrar

### Support

- `create_ticket` - Create a support ticket
- `reply_ticket` - Reply to ticket (client/admin/note)
- `get_ticket_departments` - List support departments

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

## Security Considerations

- Never expose the MCP server directly to untrusted clients
- Use `MCP_TOOL_ALLOWLIST` to restrict available tools per deployment
- Start with `read_only` mode and only enable `full` when needed
- Keep `WHMCS_SECRET` secure and rotate regularly
- All logs go to stderr (stdout reserved for JSON-RPC)
- Sensitive data (passwords, secrets, CVV) is automatically redacted from logs

## Technical Details

- **Retry Policy**: 3 retries with exponential backoff (1-10s) for 5xx errors
- **Rate Limiting**: Token bucket algorithm with configurable rate
- **Idempotency**: High-risk operations cached for 60s to prevent duplicates
- **Input Sanitization**: HTML tags and control characters removed from user input
- **Graceful Shutdown**: SIGTERM/SIGINT handlers clean up timers and connections

## Development Standards

This project follows strict AI coding rules to ensure production-grade quality, security, and maintainability.

**Core Principles:**

1. **Correctness & Security** (Sanitize inputs, secure secrets, handle errors explicitly)
2. **Readability & Maintainability** (Clean Architecture, SOLID, DRY)
3. **Idiomatic Style** (Strict TypeScript, consistent formatting)
4. **Performance** (Efficient algorithms, proper resource management)

For detailed rules, see [.cursorrules](.cursorrules).

## License

ISC
