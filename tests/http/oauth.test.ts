/**
 * OAuth 2.1 resource-server HTTP path: PRM discovery, JWT validation (mocked
 * verifier), boundary scope enforcement, and consumer mapping. The verifier is
 * mocked (its own crypto is unit-tested in tests/auth/tokenVerifier.test.ts);
 * here we assert the httpServer WIRING: PRM route, 401 + WWW-Authenticate, 403
 * insufficient-scope, and that a valid token + scope gets past the auth gate.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_ENV: 'production' as const,
    MCP_TRANSPORT: 'http' as const,
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: 0,
    MCP_HTTP_PATH: '/mcp',
    MCP_HTTP_ALLOWED_ORIGINS: [] as string[],
    MCP_HTTP_MAX_SESSIONS: 256,
    MCP_HTTP_SESSION_IDLE_MS: 300000,
    MCP_OAUTH_ENABLED: true,
    MCP_OAUTH_RESOURCE: 'https://rs.example.com',
    MCP_OAUTH_AUDIENCE: 'https://rs.example.com',
    MCP_OAUTH_ISSUERS: ['https://as.example.com'],
  },
}));
vi.mock('../../src/config.js', () => cfg);

// Mock the verifier: 'good' → valid claims; anything else → reject.
vi.mock('../../src/auth/tokenVerifier.js', () => ({
  createTokenVerifier: () => ({
    verify: (token: string) =>
      Promise.resolve(
        token === 'good'
          ? { ok: true, claims: { client_id: 'oc-1', scopes: ['whmcs:read'] } }
          : { ok: false, reason: 'audience_mismatch' }
      ),
  }),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/httpServer.js';
import { hashToken } from '../../src/governance/consumers.js';

const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const buildServer = (): McpServer => new McpServer({ name: 't', version: '0' }, { capabilities: {} });

let handle: HttpServerHandle;
let base: string;

beforeAll(async () => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'oc-1',
      token_sha256: hashToken('unused'),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      allowedWriteScopes: ['service:terminate'],
      envRestrictions: [],
      anonymous: false,
    },
  ]);
  handle = await startHttpServer({ logger, buildServer });
  base = `http://127.0.0.1:${String(handle.port)}`;
});
afterAll(async () => {
  await handle.close();
  delete process.env.MCP_CONSUMER_REGISTRY;
});

const toolCall = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('OAuth resource-server HTTP path', () => {
  it('serves PRM (RFC 9728) unauthenticated', async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.resource).toBe('https://rs.example.com');
    expect(j.authorization_servers).toEqual(['https://as.example.com']);
  });

  it('401 + WWW-Authenticate(resource_metadata) when no bearer', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toolCall('get_stats', {})),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('401 on an invalid token', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bad' },
      body: JSON.stringify(toolCall('get_stats', {})),
    });
    expect(r.status).toBe(401);
  });

  it('403 insufficient_scope: read-only token cannot call a high-risk write', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify(toolCall('write', { scope: 'service:terminate', params: {} })),
    });
    expect(r.status).toBe(403);
  });

  it('valid token + sufficient scope passes the auth/scope gate (read tools/call)', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer good',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(toolCall('get_stats', {})),
    });
    // Past auth + scope (read scope satisfies a read tool). No session id ⇒ the
    // transport rejects with a JSON-RPC error, NOT 401/403 — proving the gate passed.
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });
});
