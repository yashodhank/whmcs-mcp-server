# Local CI parity before push

Run these commands from the repository root on **Node.js 22** (matches
`.github/workflows/ci.yml`). Do not push or open a PR until they are green.

The Node job is one script so local and GitHub cannot drift:

```bash
npm ci
npm run ci:node
```

That is: build, typecheck, lint (`--max-warnings 0`), format, the full Vitest
suite with dummy WHMCS placeholders (`npm run test:ci`), MCP catalog/transport
contracts, and the capability catalog check.

Optional (matches the `mcp-conformance` job; also runs a second build):

```bash
npm run mcp:test:conformance
```

Or both Node jobs: `npm run ci`.

## Job: `python-php-check`

```bash
php -v
python3 -m py_compile scripts/whmcs-ip-updater/whmcs_ip_updater.py
python3 -m pip install --quiet pytest
python3 -m pytest scripts/whmcs-ip-updater/tests/ -q
php -l scripts/whmcs-ip-updater/remote/whmcs_api_ip_updater.php
```

## Catalog fixtures

When tools/prompts/resources/templates **or** capability-catalog descriptors
change, refresh fixtures in the same commit:

```bash
npm run catalog:update
```

That writes:

- `tests/fixtures/catalog/capability-catalog-v2.json`
- `tests/fixtures/mcp/catalog-v1.json`

The hermetic catalog sentinel (`scripts/mcp-catalog-environment-sentinel.mjs`)
reads **counts from `catalog-v1.json`**. Do not hardcode tool counts. After
`npm run build`:

```bash
node scripts/mcp-catalog-environment-sentinel.mjs
```

GitHub requires the `ci-ok` job (all of `build-test`, `mcp-conformance`, and
`python-php-check`) before merge.
