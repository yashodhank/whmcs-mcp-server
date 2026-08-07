import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_ENV: 'local' as const,
    MCP_TRANSPORT: 'http' as const,
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: 0,
    MCP_HTTP_PATH: '/mcp',
    MCP_HTTP_ALLOWED_ORIGINS: [] as string[],
    MCP_HTTP_ALLOWED_HOSTS: ['127.0.0.1', 'localhost', '[::1]'],
    MCP_HTTP_MAX_SESSIONS: 256,
    MCP_HTTP_SESSION_IDLE_MS: 300_000,
    MCP_HTTP_DRAIN_TIMEOUT_MS: 2_000,
    MCP_OAUTH_ENABLED: false,
  },
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, ...cfg.config } };
});

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  McpServer as LegacyMcpServer,
  type ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OperationCatalog } from '../../src/catalog/registry.js';
import type { OperationDefinition } from '../../src/catalog/types.js';
import type { AppConfig } from '../../src/config.js';
import { hashToken } from '../../src/governance/consumers.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/httpServer.js';
import { createModernHttpAdapter } from '../../src/http/httpServerV2.js';
import type { Logger } from '../../src/logging.js';
import { InMemoryWhmcsTelemetry } from '../../src/observability/whmcsTelemetry.js';
import {
  createRequestContext,
  getCurrentRequestContext,
  runWithRequestContext,
  type RequestContext,
} from '../../src/mcp/requestContext.js';
import { buildModernServer } from '../../src/mcp/serverFactory.js';
import { registerCapabilityCatalogResource } from '../../src/resources/capabilityCatalog.js';
import { WhmcsClient } from '../../src/whmcs/WhmcsClient.js';
import type { WhmcsTransport, WhmcsTransportResponse } from '../../src/whmcs/request/types.js';

const ALLOWED_TOKEN = 'context-integration-allowed';
const DENIED_TOKEN = 'context-integration-denied';
const clients: Client[] = [];

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  logWhmcsCall: vi.fn(),
  child(): unknown {
    return this;
  },
} as unknown as Logger;

function clientConfig(mode: 'read_only' | 'full' = 'read_only'): AppConfig {
  return {
    WHMCS_API_URL: 'https://whmcs.invalid',
    WHMCS_IDENTIFIER: 'context-test-id',
    WHMCS_SECRET: 'context-test-secret',
    WHMCS_AUTO_IP_HEAL: false,
    MCP_MODE: mode,
    MCP_READ_CACHE_TTL_MS: 0,
    MCP_READ_CACHE_ACTIONS: [],
    MCP_READ_COALESCE_ENABLED: true,
    MCP_READ_MAX_CONCURRENCY: 1,
  } as unknown as AppConfig;
}

function cancellationError(): Error {
  const error = new Error('cancelled');
  error.name = 'CanceledError';
  Object.assign(error, { code: 'ERR_CANCELED', isAxiosError: true });
  return error;
}

class BlockingTransport implements WhmcsTransport {
  readonly calls: { readonly body: URLSearchParams; readonly signal?: AbortSignal }[] = [];
  readonly post = vi.fn(
    (body: URLSearchParams, signal?: AbortSignal): Promise<WhmcsTransportResponse> => {
      this.calls.push({ body, signal });
      return new Promise((_resolve, reject) => {
        const cancel = (): void => reject(cancellationError());
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
      });
    }
  );
  readonly resetConnections = vi.fn();
}

function buildReadServer(
  whmcs: WhmcsClient,
  observeContext?: (context: RequestContext | undefined) => void
): LegacyMcpServer {
  const server = new LegacyMcpServer({ name: 'context-read-test', version: '1.0.0' });
  server.tool('context_read', { marker: z.string() }, async ({ marker }) => {
    observeContext?.(getCurrentRequestContext());
    const result = await whmcs.read('GetProducts', { marker }, { bypassCoalescing: true });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  return server;
}

async function startModern(
  buildLegacyServer: () => LegacyMcpServer,
  requestTimeoutMs = 2_000
): Promise<HttpServerHandle> {
  const modernAdapter = createModernHttpAdapter({
    logger,
    buildLegacyServer,
    requestTimeoutMs,
    drainTimeoutMs: 2_000,
  });
  return startHttpServer({ logger, buildServer: buildLegacyServer, modernAdapter });
}

async function connect(handle: HttpServerHandle, token: string): Promise<Client> {
  const client = new Client(
    { name: 'request-context-integration', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  clients.push(client);
  return client;
}

function contextFor(consumerId: string, signal: AbortSignal, deadline: number): RequestContext {
  return Object.freeze({
    era: 'modern',
    clientName: 'request-context-test',
    identity: Object.freeze({
      consumerId,
      scopes: Object.freeze([]),
      capabilityActionGrants: Object.freeze([]),
      authMode: 'registry',
    }),
    requestId: `request-${consumerId}`,
    deadline,
    signal,
  });
}

function filteredCatalog(): OperationCatalog {
  const inertHandler = (() => {
    throw new Error('not executable');
  }) as unknown as ToolCallback<z.ZodRawShape>;
  const definition: OperationDefinition = {
    id: 'clients.list.context-test',
    publicName: 'context_list_clients',
    domain: 'clients',
    description: 'Consumer-filtered request-context test operation.',
    inputSchema: { limit: z.number().int().max(100).default(25) },
    outputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
    effects: 'read',
    riskTier: 'low',
    whmcsActions: ['GetClients'],
    capability: { mode: 'all', probe: 'read_safe' },
    governance: { scope: null, output: 'canonical', rawWhmcsOutput: true },
    cache: { mode: 'none' },
    cost: { kind: 'constant', maxWhmcsCalls: 1, maxItems: 100 },
    auth: { toolAuthRequired: true, consumerFiltered: true },
    pagination: { defaultLimit: 25, maxLimit: 100 },
    prerequisites: [],
    fallbacks: [],
    protocolFeatures: ['resources', 'tools'],
    handler: inertHandler,
    version: 1,
  };
  return new OperationCatalog([definition], 2, 100);
}

beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'context-allowed',
      token_sha256: hashToken(ALLOWED_TOKEN),
      allowedActions: ['GetClients'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
    {
      id: 'context-denied',
      token_sha256: hashToken(DENIED_TOKEN),
      allowedActions: [],
      defaultContract: 'llm_safe_summary',
      allowedContracts: ['llm_safe_summary'],
      writeCapability: 'false',
    },
  ]);
});

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  delete process.env.MCP_CONSUMER_REGISTRY;
});

describe('modern MCP request context integration', () => {
  it('bounds and freezes transport-authenticated capability/action grants', () => {
    const grants = Array.from({ length: 300 }, (_, index) => `grant-${index}`);
    const sdkContext = {
      era: 'modern' as const,
      authInfo: {
        token: 'not-observed',
        clientId: 'bounded-consumer',
        scopes: [],
        extra: { authMode: 'registry', capabilityActionGrants: grants },
      },
    };
    const built = createRequestContext(sdkContext, { timeoutMs: 1_000 });
    expect(built.identity.capabilityActionGrants).toHaveLength(256);
    expect(Object.isFrozen(built.identity.capabilityActionGrants)).toBe(true);
  });

  it('preserves isolated context through the linked bridge and cleans it afterward', async () => {
    const buildContextServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'context-test', version: '1.0.0' });
      server.tool('observe_context', { pause_ms: z.number() }, async ({ pause_ms }) => {
        const before = getCurrentRequestContext();
        await new Promise((resolve) => setTimeout(resolve, pause_ms));
        const after = getCurrentRequestContext();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                before: { consumer: before?.identity.consumerId, request: before?.requestId },
                after: { consumer: after?.identity.consumerId, request: after?.requestId },
              }),
            },
          ],
        };
      });
      return server;
    };
    const handle = await startModern(buildContextServer);
    const [allowed, denied] = await Promise.all([
      connect(handle, ALLOWED_TOKEN),
      connect(handle, DENIED_TOKEN),
    ]);
    try {
      const [left, right] = await Promise.all([
        allowed.callTool({ name: 'observe_context', arguments: { pause_ms: 25 } }),
        denied.callTool({ name: 'observe_context', arguments: { pause_ms: 5 } }),
      ]);
      const parse = (result: typeof left) =>
        JSON.parse((result.content[0] as { text: string }).text) as {
          before: { consumer: string; request: string };
          after: { consumer: string; request: string };
        };
      const leftContext = parse(left);
      const rightContext = parse(right);
      expect(leftContext.before.consumer).toBe('context-allowed');
      expect(rightContext.before.consumer).toBe('context-denied');
      expect(leftContext.after).toEqual(leftContext.before);
      expect(rightContext.after).toEqual(rightContext.before);
      expect(leftContext.before.request).not.toBe(rightContext.before.request);
      expect(getCurrentRequestContext()).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('aborts queued real WhmcsClient work when its modern HTTP call is cancelled', async () => {
    const transport = new BlockingTransport();
    const whmcs = new WhmcsClient(clientConfig(), logger, {
      transport,
      maxReadConcurrency: 1,
      coalescingEnabled: false,
    });
    const observedContexts: (RequestContext | undefined)[] = [];
    const handle = await startModern(() =>
      buildReadServer(whmcs, (context) => observedContexts.push(context))
    );
    const [firstClient, secondClient] = await Promise.all([
      connect(handle, ALLOWED_TOKEN),
      connect(handle, ALLOWED_TOKEN),
    ]);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    try {
      const first = firstClient
        .callTool(
          { name: 'context_read', arguments: { marker: 'first' } },
          { signal: firstAbort.signal }
        )
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
      const second = secondClient
        .callTool(
          { name: 'context_read', arguments: { marker: 'second' } },
          { signal: secondAbort.signal }
        )
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(whmcs.getDiagnostics().coordinator.queued).toBe(1));
      const cancelledAt = Date.now();
      secondAbort.abort();
      expect(await second).toBeInstanceOf(Error);
      expect(Date.now() - cancelledAt).toBeLessThan(500);
      await vi.waitFor(() => expect(observedContexts[1]?.signal.aborted).toBe(true));
      expect(transport.post).toHaveBeenCalledTimes(1);
      expect(whmcs.getDiagnostics().coordinator.queued).toBe(0);
      firstAbort.abort();
      await first;
      await vi.waitFor(() => expect(whmcs.getDiagnostics().coordinator.queued).toBe(0));
    } finally {
      await handle.close();
    }
  });

  it('propagates a modern deadline into active real WhmcsClient transport work', async () => {
    const transport = new BlockingTransport();
    const whmcs = new WhmcsClient(clientConfig(), logger, { transport });
    const handle = await startModern(() => buildReadServer(whmcs), 75);
    const client = await connect(handle, ALLOWED_TOKEN);
    try {
      const pending = client
        .callTool({ name: 'context_read', arguments: { marker: 'deadline' } })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(transport.calls[0]?.signal?.aborted).toBe(true));
      await pending;
    } finally {
      await handle.close();
    }
  });

  it('preserves an inherited read deadline as deadline, not generic cancellation', async () => {
    const transport = new BlockingTransport();
    const telemetry = new InMemoryWhmcsTelemetry();
    const whmcs = new WhmcsClient(clientConfig(), logger, { transport, telemetry });
    const controller = new AbortController();
    const explicitDeadline = Date.now() + 50;
    const pending = runWithRequestContext(
      contextFor('deadline-consumer', controller.signal, Date.now() + 5_000),
      () =>
        whmcs.read(
          'GetProducts',
          {},
          {
            bypassCoalescing: true,
            deadlineAt: explicitDeadline,
          }
        )
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
    const error = await pending;
    expect((error as Error).message).toMatch(/deadline exceeded/);
    expect(telemetry.events.find(({ phase }) => phase === 'complete')?.outcome).toBe('deadline');
  });

  it('combines explicit and inherited cancellation and partitions coalescing by consumer', async () => {
    const transport = new BlockingTransport();
    const whmcs = new WhmcsClient(clientConfig(), logger, {
      transport,
      maxReadConcurrency: 2,
      coalescingEnabled: true,
    });
    const inheritedA = new AbortController();
    const inheritedB = new AbortController();
    const explicit = new AbortController();
    const deadline = Date.now() + 5_000;
    const left = runWithRequestContext(contextFor('consumer-a', inheritedA.signal, deadline), () =>
      whmcs.read('GetProducts', { pid: 1 }, { signal: explicit.signal, bypassCache: true })
    ).catch((error: unknown) => error);
    const right = runWithRequestContext(contextFor('consumer-b', inheritedB.signal, deadline), () =>
      whmcs.read('GetProducts', { pid: 1 }, { bypassCache: true })
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(transport.post).toHaveBeenCalledTimes(2));
    inheritedA.abort();
    inheritedB.abort();
    await Promise.all([left, right]);
    expect(transport.calls.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(explicit.signal.aborted).toBe(false);
  });

  it('filters capability discovery by authenticated profile grants and fails closed otherwise', async () => {
    const catalog = filteredCatalog();
    const buildDiscoveryServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'discovery-test', version: '1.0.0' });
      registerCapabilityCatalogResource(server, catalog);
      return server;
    };
    const handle = await startModern(buildDiscoveryServer);
    const [allowed, denied] = await Promise.all([
      connect(handle, ALLOWED_TOKEN),
      connect(handle, DENIED_TOKEN),
    ]);
    try {
      const allowedResult = await allowed.readResource({ uri: 'whmcs://capabilities/v2' });
      const deniedResult = await denied.readResource({ uri: 'whmcs://capabilities/v2' });
      const operations = (result: typeof allowedResult): { name: string }[] =>
        (
          JSON.parse((result.contents[0] as { text: string }).text) as {
            operations: { name: string }[];
          }
        ).operations;
      expect(operations(allowedResult).map(({ name }) => name)).toEqual(['context_list_clients']);
      expect(operations(deniedResult)).toEqual([]);

      const injected = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${DENIED_TOKEN}`,
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'resources/read',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'grant-injection',
          method: 'resources/read',
          params: {
            uri: 'whmcs://capabilities/v2',
            _meta: {
              auth_token: 'context-allowed',
              allowedCapabilityIds: ['list_clients'],
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': {
                name: 'request-context-integration',
                version: '1.0.0',
              },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      // Untrusted body metadata cannot become transport grants: this malformed
      // override attempt is rejected, while the authenticated denied profile's
      // valid resource read above remains an empty discovery result.
      expect(injected.status).toBe(400);
      expect(await injected.text()).not.toContain('context_list_clients');
    } finally {
      await handle.close();
    }
  });

  it('keeps modern stdio capability discovery consumer-filtered and fail closed', async () => {
    const catalog = filteredCatalog();
    const buildDiscoveryServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'stdio-discovery-test', version: '1.0.0' });
      registerCapabilityCatalogResource(server, catalog);
      return server;
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(
      async (sdkContext) =>
        (await buildModernServer({ logger, buildLegacyServer: buildDiscoveryServer }, sdkContext))
          .server,
      { legacy: 'serve', transport: serverTransport }
    );
    const client = new Client(
      { name: 'stdio-context-integration', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await client.connect(clientTransport);
      const result = await client.readResource({ uri: 'whmcs://capabilities/v2' });
      const payload = JSON.parse((result.contents[0] as { text: string }).text) as {
        operations: unknown[];
      };
      expect(payload.operations).toEqual([]);
    } finally {
      await Promise.allSettled([client.close(), handle.close()]);
    }
  });

  it('keeps no-context calls unchanged and marks inherited post-dispatch mutation cancellation unknown', async () => {
    const noContextTransport = new BlockingTransport();
    const noContextClient = new WhmcsClient(clientConfig(), logger, {
      transport: noContextTransport,
    });
    const explicit = new AbortController();
    const noContext = noContextClient
      .read('GetProducts', {}, { signal: explicit.signal, bypassCoalescing: true })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(noContextTransport.post).toHaveBeenCalledTimes(1));
    expect(noContextTransport.calls[0]?.signal).not.toBe(explicit.signal);
    expect(explicit.signal.aborted).toBe(false);
    explicit.abort();
    await noContext;

    const mutationTransport = new BlockingTransport();
    const mutationClient = new WhmcsClient(clientConfig('full'), logger, {
      transport: mutationTransport,
    });
    const inherited = new AbortController();
    const mutation = runWithRequestContext(
      contextFor('writer', inherited.signal, Date.now() + 5_000),
      () => mutationClient.mutate('UpdateClient', { clientid: 1 })
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(mutationTransport.post).toHaveBeenCalledTimes(1));
    inherited.abort();
    const error = await mutation;
    expect(error).toMatchObject({ outcomeUnknown: true });
    expect((error as Error).message).toMatch(/outcome may be unknown/);
    expect(mutationTransport.post).toHaveBeenCalledTimes(1);
  });

  it('keeps a modern post-dispatch mutation cancellation outcome-unknown without retry', async () => {
    const mutationTransport = new BlockingTransport();
    const mutationClient = new WhmcsClient(clientConfig('full'), logger, {
      transport: mutationTransport,
    });
    let observedResolve: ((error: unknown) => void) | undefined;
    const observed = new Promise<unknown>((resolve) => {
      observedResolve = resolve;
    });
    const buildMutationServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'context-mutation-test', version: '1.0.0' });
      server.tool('context_mutate', {}, async () => {
        try {
          await mutationClient.mutate('UpdateClient', { clientid: 1 });
          return { content: [{ type: 'text', text: 'unexpected' }] };
        } catch (error) {
          observedResolve?.(error);
          throw error;
        }
      });
      return server;
    };
    const handle = await startModern(buildMutationServer);
    const client = await connect(handle, ALLOWED_TOKEN);
    const abort = new AbortController();
    try {
      const pending = client
        .callTool({ name: 'context_mutate', arguments: {} }, { signal: abort.signal })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(mutationTransport.post).toHaveBeenCalledTimes(1));
      abort.abort();
      await pending;
      const error = await observed;
      expect(error).toMatchObject({ outcomeUnknown: true });
      expect((error as Error).message).toMatch(/outcome may be unknown/);
      expect(mutationTransport.post).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });
});
