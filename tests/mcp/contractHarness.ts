import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../../src/index.js';
import type { Logger } from '../../src/logging.js';
import type { RateLimiter } from '../../src/rateLimiter.js';
import type { WhmcsClient } from '../../src/whmcs/WhmcsClient.js';

export interface PublicMcpCatalog {
  protocolVersion: string;
  serverInfo: ReturnType<Client['getServerVersion']>;
  capabilities: ReturnType<Client['getServerCapabilities']>;
  tools: Awaited<ReturnType<Client['listTools']>>['tools'];
  prompts: Awaited<ReturnType<Client['listPrompts']>>['prompts'];
  resources: Awaited<ReturnType<Client['listResources']>>['resources'];
  resourceTemplates: Awaited<ReturnType<Client['listResourceTemplates']>>['resourceTemplates'];
}

export interface ContractHarness {
  readonly client: Client;
  readonly server: McpServer;
  readonly whmcsCalls: readonly string[];
  catalog(): Promise<PublicMcpCatalog>;
  close(): Promise<void>;
}

interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

async function collectPages<T>(load: (cursor?: string) => Promise<CursorPage<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error(`MCP catalog returned a repeated cursor: ${cursor}`);
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return items;
}

/** Sort object keys and catalog entries, preserving all schema and annotation data. */
export function normalizeCatalog(catalog: PublicMcpCatalog): PublicMcpCatalog {
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)])
      );
    }
    return value;
  }

  const normalized = normalize(catalog) as PublicMcpCatalog;
  normalized.tools.sort((left, right) => left.name.localeCompare(right.name));
  normalized.prompts.sort((left, right) => left.name.localeCompare(right.name));
  normalized.resources.sort((left, right) => left.uri.localeCompare(right.uri));
  normalized.resourceTemplates.sort((left, right) =>
    left.uriTemplate.localeCompare(right.uriTemplate)
  );
  return normalized;
}

export function createTripwireWhmcsClient(calls: string[]): WhmcsClient {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'then') return undefined;
        return (..._args: unknown[]) => {
          const method = String(property);
          calls.push(method);
          throw new Error(`WHMCS contract tripwire invoked: ${method}`);
        };
      },
    }
  ) as WhmcsClient;
}

export function buildContractServer(calls: string[] = []): McpServer {
  const logger = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'child') return () => logger;
        if (property === 'getCorrelationId') return () => 'mcp-contract-harness';
        return () => undefined;
      },
    }
  ) as Logger;
  const rateLimiter = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('Rate limiter contract tripwire invoked');
      },
    }
  ) as RateLimiter;

  return buildServer({
    whmcsClient: createTripwireWhmcsClient(calls),
    logger,
    rateLimiter,
  });
}

export async function createContractHarness(): Promise<ContractHarness> {
  const whmcsCalls: string[] = [];
  const server = buildContractServer(whmcsCalls);
  const client = new Client(
    { name: 'whmcs-mcp-contract-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    get whmcsCalls() {
      return whmcsCalls;
    },
    async catalog(): Promise<PublicMcpCatalog> {
      const tools = await collectPages(async (cursor) => {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor });
        return { items: result.tools, nextCursor: result.nextCursor };
      });
      const prompts = await collectPages(async (cursor) => {
        const result = await client.listPrompts(cursor === undefined ? undefined : { cursor });
        return { items: result.prompts, nextCursor: result.nextCursor };
      });
      const resources = await collectPages(async (cursor) => {
        const result = await client.listResources(cursor === undefined ? undefined : { cursor });
        return { items: result.resources, nextCursor: result.nextCursor };
      });
      const resourceTemplates = await collectPages(async (cursor) => {
        const result = await client.listResourceTemplates(
          cursor === undefined ? undefined : { cursor }
        );
        return { items: result.resourceTemplates, nextCursor: result.nextCursor };
      });

      return normalizeCatalog({
        protocolVersion:
          client.getServerCapabilities() === undefined ? 'uninitialized' : LATEST_PROTOCOL_VERSION,
        serverInfo: client.getServerVersion(),
        capabilities: client.getServerCapabilities(),
        tools,
        prompts,
        resources,
        resourceTemplates,
      });
    },
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
}
