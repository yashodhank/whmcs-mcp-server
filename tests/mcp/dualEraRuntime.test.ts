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
import { SERVER_INFO_META_KEY, type McpRequestContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hashToken, TRANSPORT_BOUND_PREFIX } from '../../src/governance/consumers.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/httpServer.js';
import { createModernHttpAdapter } from '../../src/http/httpServerV2.js';
import type { Logger } from '../../src/logging.js';
import {
  createRequestContext,
  getCurrentRequestContext,
  type RequestContext,
} from '../../src/mcp/requestContext.js';
import { buildModernServer } from '../../src/mcp/serverFactory.js';
import { buildContractServer, createContractHarness } from './contractHarness.js';

const TOKEN = 'dual-era-runtime-test-token';
// Full-suite worker contention can exceed Vitest's default for these two
// integration-heavy catalog paths; focused contract coverage remains bounded.
const MODERN_CATALOG_TEST_TIMEOUT_MS = 30_000;
const errorLog = vi.fn();
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: errorLog,
} as unknown as Logger;

function buildIdentityServer(): LegacyMcpServer {
  const server = new LegacyMcpServer({ name: 'identity-test', version: '1.0.0' });
  server.tool(
    'echo_transport_identity',
    { auth_token: z.string().optional() },
    async ({ auth_token }) => ({
      content: [{ type: 'text', text: auth_token ?? 'missing' }],
    })
  );
  return server;
}

async function startModernServer(
  buildLegacyServer: () => LegacyMcpServer,
  options: { readonly requestTimeoutMs?: number; readonly drainTimeoutMs?: number } = {}
): Promise<HttpServerHandle> {
  const modernAdapter = createModernHttpAdapter({
    logger,
    buildLegacyServer,
    requestTimeoutMs: options.requestTimeoutMs,
    drainTimeoutMs: options.drainTimeoutMs ?? 2_000,
  });
  return startHttpServer({
    logger,
    buildServer: buildLegacyServer,
    modernAdapter,
  });
}

async function connectModern(
  handle: HttpServerHandle,
  observedSessionHeaders: (string | null)[] = []
): Promise<Client> {
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    observedSessionHeaders.push(response.headers.get('mcp-session-id'));
    return response;
  };
  const client = new Client(
    { name: 'dual-era-contract-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      fetch: recordingFetch,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
  );
  return client;
}

let first: HttpServerHandle;
let second: HttpServerHandle;
const clients: Client[] = [];

beforeAll(async () => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'dual-era-client',
      token_sha256: hashToken(TOKEN),
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
  ]);
  first = await startModernServer(() => buildContractServer());
  second = await startModernServer(() => buildContractServer());
});

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  await Promise.allSettled([first.close(), second.close()]);
  delete process.env.MCP_CONSUMER_REGISTRY;
});

describe('MCP v2 stateless dual-era runtime', () => {
  it('builds an immutable, bounded, transport-authenticated request context', () => {
    const controller = new AbortController();
    const sdkContext: McpRequestContext = {
      era: 'modern',
      requestInfo: new Request('http://localhost/mcp', {
        headers: { 'Mcp-Name': 'x'.repeat(200) },
        signal: controller.signal,
      }),
      authInfo: {
        token: 'not-logged',
        clientId: 'dual-era-client',
        scopes: ['whmcs:read'],
        extra: { authMode: 'oauth' },
      },
    };
    const context = createRequestContext(sdkContext, {
      requestId: 'request-1',
      timeoutMs: 1_000,
    });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.identity)).toBe(true);
    expect(Object.isFrozen(context.identity.scopes)).toBe(true);
    expect(context.clientName).toHaveLength(64);
    expect(context.identity).toEqual({
      consumerId: 'dual-era-client',
      scopes: ['whmcs:read'],
      capabilityActionGrants: [],
      authMode: 'oauth',
    });
    controller.abort();
    expect(context.signal.aborted).toBe(true);
  });

  // prettier-ignore
  it('serves a modern request without initialize or protocol session state', async () => {
    const sessionHeaders: (string | null)[] = [];
    const client = await connectModern(first, sessionHeaders);
    clients.push(client);

    expect(client.getProtocolEra()).toBe('modern');
    await expect(client.listTools()).resolves.toMatchObject({
      tools: expect.any(Array),
      ttlMs: 30_000,
      cacheScope: 'private',
    });
    expect(client.getInstructions()).toContain('get_capability_matrix');
    expect(client.getDiscoverResult()).toMatchObject({
      ttlMs: 30_000,
      cacheScope: 'private',
      capabilities: { tools: expect.any(Object) },
    });
    expect(client.getServerCapabilities()).not.toHaveProperty('tasks');
    await expect(client.readResource({ uri: 'whmcs://docs/ops-playbook' })).resolves.toMatchObject({
      ttlMs: 0,
      cacheScope: 'private',
    });
    expect(sessionHeaders.length).toBeGreaterThan(0);
    expect(sessionHeaders).toEqual(sessionHeaders.map(() => null));
  }, MODERN_CATALOG_TEST_TIMEOUT_MS);

  // prettier-ignore
  it('keeps the published catalog equal across protocol eras', async () => {
    const legacy = await createContractHarness();
    const modern = await connectModern(first);
    clients.push(modern);
    try {
      const legacyCatalog = await legacy.catalog();
      const [tools, prompts, resources, resourceTemplates] = await Promise.all([
        modern.listTools(),
        modern.listPrompts(),
        modern.listResources(),
        modern.listResourceTemplates(),
      ]);

      const normalize = <T extends Record<string, unknown>>(
        values: readonly T[],
        key: keyof T,
        stripExecution = false
      ): T[] => {
        const cloned = JSON.parse(JSON.stringify(values)) as T[];
        for (const value of cloned) if (stripExecution) delete value.execution;
        return cloned.sort((left, right) => String(left[key]).localeCompare(String(right[key])));
      };
      expect(normalize(tools.tools, 'name')).toEqual(normalize(legacyCatalog.tools, 'name', true));
      expect(normalize(prompts.prompts, 'name')).toEqual(normalize(legacyCatalog.prompts, 'name'));
      expect(normalize(resources.resources, 'uri')).toEqual(
        normalize(legacyCatalog.resources, 'uri')
      );
      expect(normalize(resourceTemplates.resourceTemplates, 'uriTemplate')).toEqual(
        normalize(legacyCatalog.resourceTemplates, 'uriTemplate')
      );
    } finally {
      await legacy.close();
    }
  }, MODERN_CATALOG_TEST_TIMEOUT_MS);

  it('routes 100 concurrent calls across independent instances without stickiness', async () => {
    const leftHandle = await startModernServer(buildIdentityServer);
    const rightHandle = await startModernServer(buildIdentityServer);
    const left = await connectModern(leftHandle);
    const right = await connectModern(rightHandle);
    clients.push(left, right);
    try {
      const roundRobin = [left, right] as const;
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, index) => roundRobin[index % 2].listTools())
      );
      expect(results).toHaveLength(100);
      expect(results.every((result) => result.tools.length === 1)).toBe(true);
    } finally {
      await Promise.allSettled([leftHandle.close(), rightHandle.close()]);
    }
  });

  it('overwrites a body-supplied identity with transport-authenticated identity', async () => {
    const handle = await startModernServer(buildIdentityServer);
    const client = await connectModern(handle);
    clients.push(client);
    try {
      const result = await client.callTool({
        name: 'echo_transport_identity',
        arguments: { auth_token: 'attacker-controlled' },
      });
      expect(result.content).toEqual([
        { type: 'text', text: `${TRANSPORT_BOUND_PREFIX}dual-era-client` },
      ]);
    } finally {
      await handle.close();
    }
  });

  it('changes the private cache identity when the published catalog changes', async () => {
    const buildExpandedServer = (): LegacyMcpServer => {
      const server = buildIdentityServer();
      server.tool('second_catalog_tool', {}, async () => ({
        content: [{ type: 'text', text: 'second' }],
      }));
      return server;
    };
    const baseHandle = await startModernServer(buildIdentityServer);
    const expandedHandle = await startModernServer(buildExpandedServer);
    const baseClient = await connectModern(baseHandle);
    const expandedClient = await connectModern(expandedHandle);
    clients.push(baseClient, expandedClient);
    try {
      const serverVersion = (client: Client): string | undefined => {
        const metadata = client.getDiscoverResult()?._meta;
        const serverInfo = metadata?.[SERVER_INFO_META_KEY] as { version?: string } | undefined;
        return serverInfo?.version;
      };
      const baseVersion = serverVersion(baseClient);
      const expandedVersion = serverVersion(expandedClient);
      expect(baseVersion).toMatch(/^1\.0\.0\+catalog\.[a-f0-9]{12}$/);
      expect(expandedVersion).toMatch(/^1\.0\.0\+catalog\.[a-f0-9]{12}$/);
      expect(expandedVersion).not.toBe(baseVersion);
    } finally {
      await Promise.allSettled([baseHandle.close(), expandedHandle.close()]);
    }
  });

  it('propagates client cancellation through the v1 JSON-RPC bridge', async () => {
    let startedResolve: (() => void) | undefined;
    let cancelledResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      cancelledResolve = resolve;
    });
    const buildCancellationServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'cancel-test', version: '1.0.0' });
      server.tool('wait_for_cancel', {}, async (_args, extra) => {
        startedResolve?.();
        await new Promise<void>((resolve) => {
          if (extra.signal.aborted) resolve();
          else extra.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelledResolve?.();
        return { content: [{ type: 'text', text: 'cancelled' }] };
      });
      return server;
    };

    const handle = await startModernServer(buildCancellationServer);
    const client = await connectModern(handle);
    clients.push(client);
    const abort = new AbortController();
    try {
      const call = client.callTool(
        { name: 'wait_for_cancel', arguments: {} },
        { signal: abort.signal }
      );
      await started;
      abort.abort();
      await expect(call).rejects.toBeDefined();
      await expect(cancelled).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('propagates the request deadline through the v1 JSON-RPC bridge', async () => {
    let cancelledResolve: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancelledResolve = resolve;
    });
    const buildDeadlineServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'deadline-test', version: '1.0.0' });
      server.tool('wait_for_deadline', {}, async (_args, extra) => {
        await new Promise<void>((resolve) => {
          if (extra.signal.aborted) resolve();
          else extra.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelledResolve?.();
        return { content: [{ type: 'text', text: 'deadline' }] };
      });
      return server;
    };

    const handle = await startModernServer(buildDeadlineServer, { requestTimeoutMs: 100 });
    const client = await connectModern(handle);
    clients.push(client);
    try {
      const call = client
        .callTool({ name: 'wait_for_deadline', arguments: {} })
        .catch(() => undefined);
      await expect(cancelled).resolves.toBeUndefined();
      await call;
    } finally {
      await handle.close();
    }
  });

  it('contains a modern factory failure as a bounded HTTP 500', async () => {
    const handle = await startModernServer(() => {
      throw new Error('factory failure sentinel');
    });
    try {
      await expect(connectModern(handle)).rejects.toMatchObject({ status: 500 });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('Modern MCP'),
        expect.objectContaining({ error_name: 'Error' })
      );
    } finally {
      await handle.close();
    }
  });

  it('serves modern stdio framing while preserving stdio consumer credentials', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const eras: string[] = [];
    const handle = serveStdio(
      async (sdkContext) => {
        eras.push(sdkContext.era);
        return (
          await buildModernServer({ logger, buildLegacyServer: buildIdentityServer }, sdkContext)
        ).server;
      },
      { legacy: 'serve', transport: serverTransport }
    );
    const client = new Client(
      { name: 'modern-stdio-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'echo_transport_identity',
        arguments: { auth_token: 'stdio-consumer-token' },
      });
      expect(client.getProtocolEra()).toBe('modern');
      expect(eras).toEqual(['modern']);
      expect(result.content).toEqual([{ type: 'text', text: 'stdio-consumer-token' }]);
    } finally {
      await Promise.allSettled([client.close(), handle.close()]);
    }
  });

  it('refreshes persistent stdio callback deadlines after the factory context expires', async () => {
    let factoryContext: RequestContext | undefined;
    let lateContext: RequestContext | undefined;
    let startedResolve: (() => void) | undefined;
    let cancelledResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      cancelledResolve = resolve;
    });
    const buildPersistentStdioServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'persistent-stdio-test', version: '1.0.0' });
      server.tool('late_stdio_dispatch', {}, async () => {
        lateContext = getCurrentRequestContext();
        return { content: [{ type: 'text', text: 'late-dispatch-ok' }] };
      });
      server.tool('cancel_stdio_dispatch', {}, async () => {
        const context = getCurrentRequestContext();
        startedResolve?.();
        await new Promise<void>((resolve) => {
          if (context?.signal.aborted) resolve();
          else context?.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelledResolve?.();
        return { content: [{ type: 'text', text: 'cancelled' }] };
      });
      return server;
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(
      async (sdkContext) => {
        const built = await buildModernServer(
          {
            logger,
            buildLegacyServer: buildPersistentStdioServer,
            requestTimeoutMs: 50,
          },
          sdkContext
        );
        factoryContext = built.context;
        return built.server;
      },
      { legacy: 'serve', transport: serverTransport }
    );
    const client = new Client(
      { name: 'persistent-stdio-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await client.connect(clientTransport);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(factoryContext?.signal.aborted).toBe(true);

      const late = await client.callTool({ name: 'late_stdio_dispatch', arguments: {} });
      expect(late.content).toEqual([{ type: 'text', text: 'late-dispatch-ok' }]);
      expect(lateContext?.signal.aborted).toBe(false);
      expect(lateContext?.requestId).not.toBe(factoryContext?.requestId);
      expect(lateContext?.deadline).toBeGreaterThan(Date.now());

      const abort = new AbortController();
      const pending = client.callTool(
        { name: 'cancel_stdio_dispatch', arguments: {} },
        { signal: abort.signal }
      );
      await started;
      abort.abort();
      await expect(pending).rejects.toBeDefined();
      await expect(cancelled).resolves.toBeUndefined();
    } finally {
      await Promise.allSettled([client.close(), handle.close()]);
    }
  });

  it('rejects mismatched modern routing headers before dispatch', async () => {
    const response = await fetch(`http://127.0.0.1:${first.port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'routing-mismatch',
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'dual-era-contract-client',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).toContain('-32020');

    const nameResponse = await fetch(`http://127.0.0.1:${first.port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'different_tool',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'name-mismatch',
        method: 'tools/call',
        params: {
          name: 'echo_transport_identity',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'dual-era-contract-client',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(nameResponse.status).toBe(400);
    expect(await nameResponse.text()).toContain('-32020');
  });

  it('rejects new work while draining and lets an in-flight read finish', async () => {
    let startedResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const buildSlowServer = (): LegacyMcpServer => {
      const server = new LegacyMcpServer({ name: 'drain-test', version: '1.0.0' });
      server.tool('slow_read', {}, async () => {
        startedResolve?.();
        await release;
        return { content: [{ type: 'text', text: 'finished' }] };
      });
      return server;
    };

    const handle = await startModernServer(buildSlowServer);
    const client = await connectModern(handle);
    clients.push(client);
    const inFlight = client.callTool({ name: 'slow_read', arguments: {} });
    await started;
    const closing = handle.close();
    await expect(client.listTools()).rejects.toMatchObject({ status: 503 });
    releaseResolve?.();
    await expect(inFlight).resolves.toMatchObject({
      content: [{ type: 'text', text: 'finished' }],
    });
    await closing;
  });
});
