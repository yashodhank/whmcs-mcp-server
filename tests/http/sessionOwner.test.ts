/**
 * MCP Adoption #10 — Streamable HTTP transport: session-owner binding.
 *
 * Sessions are routed by the `mcp-session-id` header alone. Without an owner
 * check, an authenticated consumer presenting ANOTHER consumer's session id
 * reaches that session. This test pins the fix: each session is bound to the
 * `profile.id` of the consumer that initialized it, and a subsequent request
 * authenticating as a different (but valid) consumer is rejected with 403.
 *
 * Harness mirrors transport.test.ts: a hoisted config mock (OAuth disabled,
 * registry-token auth), a minimal real McpServer, and a real socket. Two
 * consumers come from two registry tokens.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const TOKEN_A = 'session-owner-test-token-aaa';
const TOKEN_B = 'session-owner-test-token-bbb';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_ENV: 'local' as 'local' | 'staging' | 'production',
    MCP_TRANSPORT: 'http' as 'stdio' | 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: 0, // OS-assigned free port
    MCP_HTTP_PATH: '/mcp',
    MCP_HTTP_ALLOWED_ORIGINS: [] as string[],
    MCP_HTTP_MAX_SESSIONS: 256,
    MCP_HTTP_SESSION_IDLE_MS: 300000,
    MCP_OAUTH_ENABLED: false,
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

// A non-initialize request that targets an existing session (routes by the
// `mcp-session-id` header). tools/list is enough to exercise the owner check.
const LIST_BODY = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

const ACCEPT = 'application/json, text/event-stream';

let handle: HttpServerHandle;
let base: string;

beforeAll(async () => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'consumer-a',
      token_sha256: hashToken(TOKEN_A),
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
    {
      id: 'consumer-b',
      token_sha256: hashToken(TOKEN_B),
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

/** Initialize a session as the given token; returns its mcp-session-id. */
async function initSession(token: string): Promise<string> {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(INIT_BODY),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  await res.text(); // drain
  return sid as string;
}

describe('Streamable HTTP transport — session-owner binding', () => {
  it("rejects (403) a valid consumer reusing another consumer's session id", async () => {
    const sidA = await initSession(TOKEN_A);

    // Consumer B is fully authenticated (valid token) but does NOT own sidA.
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: `Bearer ${TOKEN_B}`,
        'mcp-session-id': sidA,
      },
      body: JSON.stringify(LIST_BODY),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeDefined();
    // No token / session id leaked in the error body.
    expect(JSON.stringify(json)).not.toContain(sidA);
    expect(JSON.stringify(json)).not.toContain(TOKEN_A);
    expect(JSON.stringify(json)).not.toContain(TOKEN_B);
  });

  it('allows the owning consumer to reuse its own session id (not 403)', async () => {
    const sidA = await initSession(TOKEN_A);

    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: `Bearer ${TOKEN_A}`,
        'mcp-session-id': sidA,
      },
      body: JSON.stringify(LIST_BODY),
    });
    expect(res.status).not.toBe(403);
  });
});
