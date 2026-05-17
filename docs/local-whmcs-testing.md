# Local WHMCS dev/test environment

A self-contained dual WHMCS stack so the MCP can be exercised end-to-end
(including **write** tools) against a disposable local WHMCS — instead of
read-only against production `my.securiace.com` (IP-allowlist 403s, prod-only
500s).

This stack was **replicated and customized** from
`securiace-vps-platform/deploy/whmcs-test/`. It is fully independent of that
project: distinct ports, container/network/volume names, compose project
name, and env prefix, so both stacks can run simultaneously without conflict.

| URL | WHMCS | PHP | DB | Compose services |
|---|---|---|---|---|
| <http://localhost:8813/> | 8.13.1 | 7.4 | MariaDB 10.11 | `mcpw8`, `mcpw8-php`, `mcpw8-db` |
| <http://localhost:8890/> | 9.0.1 | 8.3 | MariaDB 11 | `mcpw9`, `mcpw9-php`, `mcpw9-db` |

- Compose project: `whmcsmcp-whmcs-test` · networks `mcpw{8,9}-net` · volumes `mcpw{8,9}_{db,storage}`
- Env overrides: `WMCP_WHMCS_8_PORT` (8813), `WMCP_WHMCS_9_PORT` (8890), `WMCP_WHMCS_{8,9}_DB_*`, `WMCP_WHMCS_{8,9}_PHP_IMAGE`
- **Isolation vs `securiace-vps-platform`** (ports 8013/8090, `whmcs8*`/`SECVPS_`): nothing shared. Never modify that repo.

## Prerequisites (host inputs, not committed)

In `~/Downloads/` (gitignored when staged; third-party + sensitive):

- `whmcs_v8131_full.zip`, `whmcs_v901_full.zip` — WHMCS source bundles
- `License8.13.0.php`, `License9.php` — **bypass** `License.php` (LOCAL DEV/TEST ONLY; production uses a real licensed install)

Plus Docker + Docker Compose v2. The runtime images are amd64-only; on Apple
Silicon they run under qemu (stable, ~2–5× slower).

## One-time setup

```bash
npm run whmcs:test:source          # extract bundles → deploy/whmcs-test/source/{8.13,9.0}
npm run whmcs:test:licenses        # stage License.php → deploy/whmcs-test/licenses/
npm run whmcs:test:up              # bring up both stacks
npm run whmcs:test:ps              # both should reach healthy (~20s; longer under qemu)
npm run whmcs:test:license-install # docker cp bypass License.php into both containers
```

Walk each install wizard once in a browser:

- 8.13 → <http://localhost:8813/install/install.php>
- 9.0 → <http://localhost:8890/install/install.php>

DB connection details for the wizard:

| Leg | DB host | DB name | DB user | DB password |
|---|---|---|---|---|
| 8.13 | `mcpw8-db` | `whmcs8` | `whmcs` | `whmcs_8_password` |
| 9.0 | `mcpw9-db` | `whmcs9` | `whmcs` | `whmcs_9_password` |

Then:

```bash
npm run whmcs:test:fixup     # rm install/, patch SystemURL, kill dev-hostile session-IP check, health-probe
npm run whmcs:test:snapshot  # capture DB + configuration.php so you can reset without re-walking the wizard
```

`fixup` fails loudly if any URL still serves `<title>Security Warning</title>`
(WHMCS' install-folder boot guard) — that is the single source of truth for
"the stack is healthy and snapshottable".

## Create WHMCS API credentials

In each local WHMCS admin (`/admin/`):

1. **System Settings → API Credentials → Generate New API Credential**
2. Role: a full-admin API role for dev (or scope per test).
3. Leave **API IP Access Restriction blank** (the MCP connects from the host).
4. Copy the Identifier + Secret into `.env.local` (see below).

## Point the MCP at it (env separation)

```bash
cp .env.local.example .env.local
# edit .env.local: set WHMCS_IDENTIFIER / WHMCS_SECRET from the step above
```

`.env.local` is gitignored. `MCP_ENV=local` makes `src/config.ts` layer
`.env.local` over the base `.env` (env-specific wins; real exported env wins
over both). `.env.local.example` sets `WHMCS_API_URL=http://localhost:8813`
and `WHMCS_ALLOW_HTTP=true` — SEC-005 still enforces https for
staging/production (those profiles never set `WHMCS_ALLOW_HTTP`).

```bash
MCP_ENV=local npm run build
MCP_ENV=local node dist/index.js        # smoke: starts clean, no SEC-005 rejection
MCP_ENV=local npm test                  # integration tests now RUN (no 403/skip)
```

Point at the 9.0 leg by setting `WHMCS_API_URL=http://localhost:8890` in
`.env.local`.

## Reset / teardown

```bash
npm run whmcs:test:reset   # restore the snapshot WITHOUT re-walking the wizard (~5s). Canonical "start over".
npm run whmcs:test:down    # tear down + purge DB/storage volumes (keeps host-side source/)
```

Per-leg: pass `mcpw8` / `mcpw9` to the underlying scripts
(`bash deploy/whmcs-test/reset.sh mcpw8`).

## Why this matters / what it unblocks

- **Write paths** (`mark_invoice_paid`, `record_refund`, `capture_payment`,
  `reply_ticket` in client mode, `suspend_service`/`terminate_service`) can be
  exercised safely on a disposable instance — they were never tested against a
  real WHMCS before (prod was read-only + IP-blocked).
- The `DomainWhois` 500 can be **reproduced and diagnosed** here on 8.13 vs
  9.0 instead of being written off as "server-side, unfixable".
- Matrix coverage: 8.13 (matches prod major) and 9.0 (upgrade target).

## Caveats

- Bypass `License.php` disables only the license check, not the rest of
  WHMCS anti-tamper; some admin pages may still warn.
- Community licenses can break across WHMCS minor releases — restage with
  `bash deploy/whmcs-test/stage-licenses.sh --force` then re-run license-install.
- Never commit `deploy/whmcs-test/{licenses,source,snapshot}` — `.gitignore`
  enforces; `.gitkeep`s keep the dirs.
