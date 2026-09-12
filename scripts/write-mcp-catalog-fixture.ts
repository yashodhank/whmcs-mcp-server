/**
 * Refresh tests/fixtures/mcp/catalog-v1.json from the live MCP catalog.
 * Invoked by `npm run catalog:update` (via catalog-contract-runner --write).
 * Never prints secrets.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContractHarness } from '../tests/mcp/contractHarness.js';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/mcp/catalog-v1.json', import.meta.url));

const harness = await createContractHarness();
try {
  const catalog = await harness.catalog();
  writeFileSync(fixturePath, `${JSON.stringify(catalog, null, 2)}\n`);
  process.stderr.write(
    `Updated MCP catalog fixture: ${String(catalog.tools.length)}/${String(catalog.prompts.length)}/${String(catalog.resources.length)}/${String(catalog.resourceTemplates.length)} (tools/prompts/resources/templates)\n`
  );
} finally {
  await harness.close();
}
