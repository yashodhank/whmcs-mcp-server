import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capabilityShellCatalogMachineView } from '../src/catalog/packs/capabilityShell.js';
import { config } from '../src/config.js';
import type { CatalogMachineView } from '../src/catalog/types.js';

const fixturePath = fileURLToPath(
  new URL('../tests/fixtures/catalog/capability-catalog-v2.json', import.meta.url)
);
const actual = capabilityShellCatalogMachineView(config.MCP_MAX_PAGE_SIZE);
const rendered = `${JSON.stringify(actual, null, 2)}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(fixturePath, rendered, 'utf8');
  process.stderr.write(`Updated ${fixturePath}\n`);
  process.exit(0);
}

if (!existsSync(fixturePath)) {
  process.stderr.write(`Missing catalog fixture: ${fixturePath}. Run npm run catalog:update.\n`);
  process.exit(1);
}

const expectedText = readFileSync(fixturePath, 'utf8');
const expected = JSON.parse(expectedText) as CatalogMachineView;
if (JSON.stringify(expected) === JSON.stringify(actual)) {
  process.stderr.write('Capability catalog fixture matches.\n');
  process.exit(0);
}

const expectedById = new Map(expected.operations.map((operation) => [operation.id, operation]));
const actualById = new Map(actual.operations.map((operation) => [operation.id, operation]));
const added = [...actualById.keys()].filter((id) => !expectedById.has(id)).sort();
const removed = [...expectedById.keys()].filter((id) => !actualById.has(id)).sort();
const changed = [...actualById.keys()]
  .filter(
    (id) =>
      expectedById.has(id) &&
      JSON.stringify(expectedById.get(id)) !== JSON.stringify(actualById.get(id))
  )
  .sort();

process.stderr.write(
  `Capability catalog semantic diff: added=${added.join(',') || '-'} removed=${removed.join(',') || '-'} changed=${changed.join(',') || '-'}\n`
);
process.stderr.write(
  'Run npm run catalog:update only for an intentional reviewed catalog change.\n'
);
process.exit(1);
