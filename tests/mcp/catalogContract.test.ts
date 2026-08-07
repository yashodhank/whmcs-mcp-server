import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createContractHarness,
  type ContractHarness,
  type PublicMcpCatalog,
} from './contractHarness.js';

const FIXTURE_URL = new URL('../fixtures/mcp/catalog-v1.json', import.meta.url);

function fixture(): PublicMcpCatalog {
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as PublicMcpCatalog;
}

function duplicates(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

describe('public MCP catalog v1 contract', () => {
  let harness: ContractHarness;
  let catalog: PublicMcpCatalog;

  beforeAll(async () => {
    harness = await createContractHarness();
    catalog = await harness.catalog();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('matches the compatibility-significant saved catalog exactly', () => {
    expect(catalog).toEqual(fixture());
    expect(harness.whmcsCalls).toEqual([]);
  });

  it('discovers the same normalized catalog repeatedly', async () => {
    expect(await harness.catalog()).toEqual(catalog);
    expect(harness.whmcsCalls).toEqual([]);
  });

  it('has unique tool, prompt, resource and template identities', () => {
    expect(duplicates(catalog.tools.map(({ name }) => name))).toEqual([]);
    expect(duplicates(catalog.prompts.map(({ name }) => name))).toEqual([]);
    expect(duplicates(catalog.resources.map(({ uri }) => uri))).toEqual([]);
    expect(duplicates(catalog.resourceTemplates.map(({ uriTemplate }) => uriTemplate))).toEqual([]);
  });

  it('publishes compilable input and output JSON Schemas without stripping annotations', () => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);

    for (const tool of catalog.tools) {
      expect(tool.inputSchema.type, `${tool.name} inputSchema`).toBe('object');
      expect(() => ajv.compile(tool.inputSchema), `${tool.name} inputSchema`).not.toThrow();

      if (tool.outputSchema !== undefined) {
        expect(tool.outputSchema.type, `${tool.name} outputSchema`).toBe('object');
        expect(() => ajv.compile(tool.outputSchema), `${tool.name} outputSchema`).not.toThrow();
      }

      if (tool.annotations !== undefined) {
        for (const hint of [
          'readOnlyHint',
          'destructiveHint',
          'idempotentHint',
          'openWorldHint',
        ] as const) {
          const value = tool.annotations[hint];
          if (value !== undefined) expect(typeof value, `${tool.name}.${hint}`).toBe('boolean');
        }
      }
    }

    expect(catalog.tools.some(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
    expect(catalog.tools.some(({ annotations }) => annotations !== undefined)).toBe(true);
    expect(harness.whmcsCalls).toEqual([]);
  });
});
