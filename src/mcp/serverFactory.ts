import { createHash } from 'node:crypto';
import {
  McpServer as ModernMcpServer,
  ResourceTemplate as ModernResourceTemplate,
  fromJsonSchema,
  type CallToolResult as ModernCallToolResult,
  type GetPromptResult as ModernGetPromptResult,
  type Icon,
  type JsonSchemaType,
  type McpRequestContext as SdkRequestContext,
  type ReadResourceResult as ModernReadResourceResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport as LegacyInMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestOptions as LegacyRequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { TRANSPORT_BOUND_PREFIX } from '../governance/consumers.js';
import type { Logger } from '../logging.js';
import { createRequestContext, type RequestContext } from './requestContext.js';

interface LegacyToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaType;
  readonly outputSchema?: JsonSchemaType;
  readonly annotations?: ToolAnnotations;
  readonly icons?: Icon[];
  readonly _meta?: Record<string, unknown>;
}

interface LegacyPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

interface LegacyPromptDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly LegacyPromptArgument[];
  readonly icons?: Icon[];
  readonly _meta?: Record<string, unknown>;
}

interface LegacyResourceDescriptor {
  readonly uri: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly icons?: Icon[];
  readonly _meta?: Record<string, unknown>;
}

interface LegacyResourceTemplateDescriptor {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly icons?: Icon[];
  readonly _meta?: Record<string, unknown>;
}

interface LegacyBridge {
  readonly client: LegacyClient;
  close(): Promise<void>;
}

const CATALOG_CACHE_TTL_MS = 30_000;

export interface ServerFactoryDeps {
  readonly buildLegacyServer: () => LegacyMcpServer;
  readonly logger: Logger;
  readonly requestTimeoutMs?: number;
}

export interface ModernServerBuild {
  readonly server: ModernMcpServer;
  readonly context: RequestContext;
}

async function createLegacyBridge(buildLegacyServer: () => LegacyMcpServer): Promise<LegacyBridge> {
  const [clientTransport, serverTransport] = LegacyInMemoryTransport.createLinkedPair();
  const server = buildLegacyServer();
  const client = new LegacyClient({ name: 'whmcs-mcp-v2-bridge', version: '1.0.0' });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()]);
    throw error;
  }
  let closed = false;
  return {
    client,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: readonly T[]; nextCursor?: string }>
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function bridgeRequestOptions(context: RequestContext): LegacyRequestOptions {
  const remainingMs = Math.max(1, context.deadline - Date.now());
  return {
    signal: context.signal,
    timeout: remainingMs,
    maxTotalTimeout: remainingMs,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function catalogRevision(catalog: {
  readonly tools: readonly LegacyToolDescriptor[];
  readonly prompts: readonly LegacyPromptDescriptor[];
  readonly resources: readonly LegacyResourceDescriptor[];
  readonly resourceTemplates: readonly LegacyResourceTemplateDescriptor[];
}): string {
  return createHash('sha256').update(canonicalJson(catalog)).digest('hex').slice(0, 12);
}

function promptArgumentsSchema(argumentsList: readonly LegacyPromptArgument[] | undefined) {
  const properties = Object.fromEntries(
    (argumentsList ?? []).map((argument) => [
      argument.name,
      {
        type: 'string',
        ...(argument.description === undefined ? {} : { description: argument.description }),
      },
    ])
  );
  const required = (argumentsList ?? [])
    .filter((argument) => argument.required === true)
    .map((argument) => argument.name);
  return fromJsonSchema<Record<string, string>>({
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
  });
}

function withTransportIdentity(args: unknown, context: RequestContext): Record<string, unknown> {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};
  if (context.identity.authMode !== 'stdio') {
    record.auth_token = `${TRANSPORT_BOUND_PREFIX}${context.identity.consumerId}`;
  }
  return record;
}

function installCloseBoundary(server: ModernMcpServer, bridge: LegacyBridge): void {
  const closeModern = server.close.bind(server);
  Object.defineProperty(server, 'close', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: async (): Promise<void> => {
      await bridge.close();
      await closeModern();
    },
  });
}

/**
 * Construct one v2 server for one modern request. The existing v1 domain
 * surface is reached only through a linked JSON-RPC transport, so v1/v2 SDK
 * objects never cross the nominal package boundary. Plan 003 can replace this
 * bridge with the unified catalog without changing the HTTP adapter.
 */
export async function buildModernServer(
  deps: ServerFactoryDeps,
  sdkContext: SdkRequestContext
): Promise<ModernServerBuild> {
  const context = createRequestContext(sdkContext, { timeoutMs: deps.requestTimeoutMs });
  const bridge = await createLegacyBridge(deps.buildLegacyServer);
  let server!: ModernMcpServer;

  try {
    const capabilities = bridge.client.getServerCapabilities();
    const [tools, prompts, resources, resourceTemplates] = await Promise.all([
      capabilities?.tools === undefined
        ? Promise.resolve([])
        : collectPages<LegacyToolDescriptor>(async (cursor) => {
            const page = await bridge.client.listTools(
              cursor === undefined ? undefined : { cursor },
              bridgeRequestOptions(context)
            );
            return { items: page.tools as LegacyToolDescriptor[], nextCursor: page.nextCursor };
          }),
      capabilities?.prompts === undefined
        ? Promise.resolve([])
        : collectPages<LegacyPromptDescriptor>(async (cursor) => {
            const page = await bridge.client.listPrompts(
              cursor === undefined ? undefined : { cursor },
              bridgeRequestOptions(context)
            );
            return { items: page.prompts as LegacyPromptDescriptor[], nextCursor: page.nextCursor };
          }),
      capabilities?.resources === undefined
        ? Promise.resolve([])
        : collectPages<LegacyResourceDescriptor>(async (cursor) => {
            const page = await bridge.client.listResources(
              cursor === undefined ? undefined : { cursor },
              bridgeRequestOptions(context)
            );
            return {
              items: page.resources as LegacyResourceDescriptor[],
              nextCursor: page.nextCursor,
            };
          }),
      capabilities?.resources === undefined
        ? Promise.resolve([])
        : collectPages<LegacyResourceTemplateDescriptor>(async (cursor) => {
            const page = await bridge.client.listResourceTemplates(
              cursor === undefined ? undefined : { cursor },
              bridgeRequestOptions(context)
            );
            return {
              items: page.resourceTemplates as LegacyResourceTemplateDescriptor[],
              nextCursor: page.nextCursor,
            };
          }),
    ]);

    const revision = catalogRevision({ tools, prompts, resources, resourceTemplates });
    server = new ModernMcpServer(
      { name: 'whmcs-mcp-server', version: `1.0.0+catalog.${revision}` },
      {
        capabilities: { logging: {} },
        instructions:
          'Use tools/list, resources/list, and resources/templates/list for the WHMCS business catalog; use get_capability_matrix for verified WHMCS action evidence.',
        cacheHints: {
          'server/discover': { ttlMs: CATALOG_CACHE_TTL_MS, cacheScope: 'private' },
          'tools/list': { ttlMs: CATALOG_CACHE_TTL_MS, cacheScope: 'private' },
          'prompts/list': { ttlMs: CATALOG_CACHE_TTL_MS, cacheScope: 'private' },
          'resources/list': { ttlMs: CATALOG_CACHE_TTL_MS, cacheScope: 'private' },
          'resources/templates/list': {
            ttlMs: CATALOG_CACHE_TTL_MS,
            cacheScope: 'private',
          },
          'resources/read': { ttlMs: 0, cacheScope: 'private' },
        },
      }
    );

    for (const tool of tools) {
      const inputSchema = fromJsonSchema(tool.inputSchema);
      const callback = async (args: unknown): Promise<ModernCallToolResult> =>
        (await bridge.client.callTool(
          {
            name: tool.name,
            arguments: withTransportIdentity(args, context),
          },
          undefined,
          bridgeRequestOptions(context)
        )) as unknown as ModernCallToolResult;
      const baseConfig = {
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
        icons: tool.icons,
        _meta: tool._meta,
      };
      if (tool.outputSchema === undefined) {
        server.registerTool(tool.name, baseConfig, callback);
      } else {
        server.registerTool(
          tool.name,
          { ...baseConfig, outputSchema: fromJsonSchema(tool.outputSchema) },
          callback
        );
      }
    }

    for (const prompt of prompts) {
      server.registerPrompt(
        prompt.name,
        {
          title: prompt.title,
          description: prompt.description,
          argsSchema: promptArgumentsSchema(prompt.arguments),
          icons: prompt.icons,
          _meta: prompt._meta,
        },
        async (args): Promise<ModernGetPromptResult> =>
          (await bridge.client.getPrompt(
            {
              name: prompt.name,
              arguments: args,
            },
            bridgeRequestOptions(context)
          )) as unknown as ModernGetPromptResult
      );
    }

    for (const resource of resources) {
      server.registerResource(
        resource.name ?? resource.uri,
        resource.uri,
        {
          title: resource.title,
          description: resource.description,
          mimeType: resource.mimeType,
          icons: resource.icons,
          _meta: resource._meta,
          cacheHint: { ttlMs: 0, cacheScope: 'private' },
        },
        async (uri: URL): Promise<ModernReadResourceResult> =>
          (await bridge.client.readResource(
            { uri: uri.href },
            bridgeRequestOptions(context)
          )) as unknown as ModernReadResourceResult
      );
    }

    for (const template of resourceTemplates) {
      server.registerResource(
        template.name,
        new ModernResourceTemplate(template.uriTemplate, { list: undefined }),
        {
          title: template.title,
          description: template.description,
          mimeType: template.mimeType,
          icons: template.icons,
          _meta: template._meta,
          cacheHint: { ttlMs: 0, cacheScope: 'private' },
        },
        async (uri: URL): Promise<ModernReadResourceResult> =>
          (await bridge.client.readResource(
            { uri: uri.href },
            bridgeRequestOptions(context)
          )) as unknown as ModernReadResourceResult
      );
    }
  } catch (error) {
    await bridge.close();
    throw error;
  }

  installCloseBoundary(server, bridge);
  deps.logger.debug('Built stateless MCP request server', {
    protocol_era: context.era,
    transport: context.identity.authMode === 'stdio' ? 'stdio' : 'http',
    client_name: context.identity.consumerId.slice(0, 64),
    auth_mode: context.identity.authMode,
    outcome: 'ready',
  });
  return { server, context };
}
