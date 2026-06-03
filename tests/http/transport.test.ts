/**
 * MCP Adoption #10 — Streamable HTTP transport integration tests.
 *
 * Two concerns:
 *  1. Transport SELECTION default is unchanged — `MCP_TRANSPORT` defaults to
 *     `stdio` so the server behaves exactly as before unless opted in.
 *  2. The HTTP server enforces the auth bridge over a REAL socket: 401 on
 *     missing/bad bearer, 403 on bad Origin, and a happy-path `initialize`
 *     with a valid token that returns an `mcp-session-id` and an InitializeResult.
 *
 * config is mocked (it is a module singleton loaded at import). buildServer is
 * passed a minimal real McpServer so the SDK transport completes a real
 * initialize handshake. The consumer registry comes from process.env, parsed by
 * the real loadConsumerRegistry.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const VALID_TOKEN = 'http-transport-test-token-xyz';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_ENV: 'local' as 'local' | 'staging' | 'production',
    MCP_TRANSPORT: 'http' as 'stdio' | 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: 0, // OS-assigned free port
    MCP_HTTP_PATH: '/mcp',
    MCP_HTTP_ALLOWED_ORIGINS: [] as string[],
  },
}));
vi.mock('../../src/config.js', () => cfg);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/httpServer.js';
import { hashToken } from '../../src/governance/consumers.js';

const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function buildServer(): McpServer {
  return new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: {} });
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

let handle: HttpServerHandle;
let base: string;

beforeAll(async () => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'http-test',
      token_sha256: hashToken(VALID_TOKEN),
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
  ]);
  handle = await startHttpServer({ logger, buildServer });
  base = `http://127.0.0.1:${handle.port}/mcp`;
});

afterAll(async () => {
  await handle.close();
  delete process.env.MCP_CONSUMER_REGISTRY;
});

const ACCEPT = 'application/json, text/event-stream';

describe('Streamable HTTP transport — auth bridge over a real socket', () => {
  it('401 with WWW-Authenticate when no bearer token is sent', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
    const json = await res.json();
    // No token / internals leaked.
    expect(JSON.stringify(json)).not.toContain(VALID_TOKEN);
    expect(json.error).toBeDefined();
  });

  it('401 when the bearer token is unknown', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('403 when Origin header is present and not allowlisted', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: `Bearer ${VALID_TOKEN}`,
        Origin: 'https://evil.test',
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('happy path: valid token initializes a session and returns mcp-session-id', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();

    // Body may be JSON or an SSE event stream depending on negotiation; either
    // way it must carry the InitializeResult with our server's name.
    const text = await res.text();
    expect(text).toContain('serverInfo');
    expect(text).toContain('"name":"test"');
  });

  it('malformed JSON body yields a JSON-RPC parse error, not a crash', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: '{ this is not json',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe(-32700);
  });
});

describe('Transport selection default', () => {
  it('MCP_TRANSPORT defaults to stdio when unset (default unchanged)', async () => {
    // Verify against the REAL config module (not the mock): with MCP_TRANSPORT
    // unset in the environment, the parsed value is 'stdio', so index.ts takes
    // the StdioServerTransport branch exactly as before HTTP was added.
    const hadTransport = 'MCP_TRANSPORT' in process.env;
    const prev = process.env.MCP_TRANSPORT;
    delete process.env.MCP_TRANSPORT;
    try {
      vi.resetModules();
      const real = await vi.importActual<typeof import('../../src/config.js')>(
        '../../src/config.js'
      );
      expect(real.config.MCP_TRANSPORT).toBe('stdio');
    } finally {
      if (hadTransport) process.env.MCP_TRANSPORT = prev;
    }
  });
});
