# Local CI parity before push

Run these commands from the repository root on **Node.js 22** (matches `.github/workflows/ci.yml`). Use dummy WHMCS placeholders for tests; they are not real credentials.

## Job: `build-test`

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
WHMCS_API_URL=https://whmcs.invalid/includes/api.php \
WHMCS_IDENTIFIER=ci-dummy-identifier \
WHMCS_SECRET=ci-dummy-secret \
npm test
npm run mcp:test:contracts
npm run catalog:check
```

## Job: `mcp-conformance`

```bash
npm ci   # if not already installed from build-test
npm run mcp:test:conformance
```

## Job: `python-php-check`

```bash
python3 -m py_compile scripts/whmcs-ip-updater/whmcs_ip_updater.py
python3 -m pip install --quiet pytest
python3 -m pytest scripts/whmcs-ip-updater/tests/ -q
php -l scripts/whmcs-ip-updater/remote/whmcs_api_ip_updater.php
```

## Catalog sentinel counts

When tools/prompts/resources/templates change, update **both**:

- `tests/fixtures/mcp/catalog-v1.json` (Vitest catalog contract)
- `scripts/mcp-catalog-environment-sentinel.mjs` `expected` block (hermetic child in `mcp:test:contracts`)

After `npm run build`, confirm live counts:

```bash
node scripts/mcp-catalog-environment-sentinel.mjs
```

The line should match the fixture (currently `77/10/5/9` for tools/prompts/resources/resourceTemplates).
