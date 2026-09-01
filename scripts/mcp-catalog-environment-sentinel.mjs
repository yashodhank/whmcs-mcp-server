#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../dist/index.js';

const expected = Object.freeze({
  tools: 77,
  prompts: 10,
  resources: 5,
  resourceTemplates: 9,
});
const whmcsCalls = [];
const whmcsClient = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'then') return undefined;
      return () => {
        const method = String(property);
        whmcsCalls.push(method);
        throw new Error(`WHMCS catalog sentinel invoked: ${method}`);
      };
    },
  }
);
const logger = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'child') return () => logger;
      if (property === 'getCorrelationId') return () => 'mcp-catalog-environment-sentinel';
      return () => undefined;
    },
  }
);
const rateLimiter = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error('Rate limiter catalog sentinel invoked');
      };
    },
  }
);

const server = buildServer({ whmcsClient, logger, rateLimiter });
const client = new Client(
  { name: 'whmcs-mcp-catalog-environment-sentinel', version: '1.0.0' },
  { capabilities: {} }
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const [tools, prompts, resources, resourceTemplates] = await Promise.all([
    client.listTools(),
    client.listPrompts(),
    client.listResources(),
    client.listResourceTemplates(),
  ]);
  const actual = {
    tools: tools.tools.length,
    prompts: prompts.prompts.length,
    resources: resources.resources.length,
    resourceTemplates: resourceTemplates.resourceTemplates.length,
  };

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `hostile environment changed the MCP catalog: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
  if (whmcsCalls.length > 0) {
    throw new Error(`catalog discovery invoked WHMCS methods: ${whmcsCalls.join(', ')}`);
  }
  process.stdout.write(
    `Hermetic MCP catalog sentinel: ${actual.tools}/${actual.prompts}/${actual.resources}/${actual.resourceTemplates}.\n`
  );
} finally {
  await client.close();
  await server.close();
}
