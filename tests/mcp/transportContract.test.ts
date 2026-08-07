import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const configOverride = vi.hoisted(() => ({
  host: '127.0.0.1',
  port: 0,
  path: '/mcp-contract',
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      MCP_ENV: 'local',
      MCP_TRANSPORT: 'http',
      MCP_HTTP_HOST: configOverride.host,
      MCP_HTTP_PORT: configOverride.port,
      MCP_HTTP_PATH: configOverride.path,
      MCP_HTTP_ALLOWED_ORIGINS: [],
      MCP_HTTP_MAX_SESSIONS: 32,
      MCP_HTTP_SESSION_IDLE_MS: 300_000,
      MCP_OAUTH_ENABLED: false,
    },
  };
});

import { ErrorCode, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { hashToken } from '../../src/governance/consumers.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/httpServer.js';
import {
  buildContractServer,
  createContractHarness,
  type ContractHarness,
} from './contractHarness.js';

const VALID_TOKEN = 'mcp-contract-http-token';
const ACCEPT = 'application/json, text/event-stream';
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function initializeBody(protocolVersion = LATEST_PROTOCOL_VERSION): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'whmcs-contract-http-client', version: '1.0.0' },
    },
  };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: ACCEPT,
    Authorization: `Bearer ${VALID_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

describe('MCP transport and auth contract', () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let inMemory: ContractHarness;
  const whmcsCalls: string[] = [];

  beforeAll(async () => {
    process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
      {
        id: 'mcp-contract-client',
        token_sha256: hashToken(VALID_TOKEN),
        defaultContract: 'ops_operator',
        allowedContracts: ['ops_operator'],
        writeCapability: 'false',
      },
    ]);
    handle = await startHttpServer({
      logger,
      buildServer: () => buildContractServer(whmcsCalls),
    });
    baseUrl = `http://${configOverride.host}:${handle.port}${configOverride.path}`;
    inMemory = await createContractHarness();
  });

  afterAll(async () => {
    await inMemory.close();
    await handle.close();
    delete process.env.MCP_CONSUMER_REGISTRY;
  });

  it('rejects missing and invalid bearer authentication without leaking credentials', async () => {
    for (const authorization of [undefined, 'Bearer invalid-contract-token']) {
      const requestHeaders = headers();
      if (authorization === undefined) delete requestHeaders.Authorization;
      else requestHeaders.Authorization = authorization;

      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(initializeBody()),
      });
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/Bearer/);
      expect(body).toContain(`"code":${-32001}`);
      expect(body).not.toContain(VALID_TOKEN);
      expect(body).not.toContain('invalid-contract-token');
    }
    expect(whmcsCalls).toEqual([]);
  });

  it('returns a protocol-shaped parse error for malformed JSON', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(),
      body: '{ malformed json',
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain(`"code":${ErrorCode.ParseError}`);
    expect(body).not.toContain(VALID_TOKEN);
    expect(whmcsCalls).toEqual([]);
  });

  it('rejects unsupported content types before establishing a session', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'text/plain' }),
      body: JSON.stringify(initializeBody()),
    });
    const body = await response.text();

    expect(response.status).toBe(415);
    expect(body).toContain('Unsupported Media Type');
    expect(body).not.toContain(VALID_TOKEN);
    expect(whmcsCalls).toEqual([]);
  });

  it('negotiates an unsupported requested version back to the supported version', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(initializeBody('2099-01-01')),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(`"protocolVersion":"${LATEST_PROTOCOL_VERSION}"`);
    expect(response.headers.get('mcp-session-id')).toBeTruthy();
    expect(whmcsCalls).toEqual([]);
  });

  it('rejects unsupported HTTP methods with a bounded protocol response', async () => {
    const response = await fetch(baseUrl, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(initializeBody()),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain(`"code":${-32000}`);
    expect(body).not.toContain(VALID_TOKEN);
    expect(whmcsCalls).toEqual([]);
  });

  it('returns bounded errors for unknown capabilities and invalid arguments', async () => {
    const unknownTool = await inMemory.client.callTool({ name: '__unknown_tool__', arguments: {} });
    expect(unknownTool.isError).toBe(true);
    expect(JSON.stringify(unknownTool)).toContain('not found');

    const invalidArguments = await inMemory.client.callTool({
      name: 'get_invoice',
      arguments: {},
    });
    expect(invalidArguments.isError).toBe(true);
    expect(JSON.stringify(invalidArguments)).toContain('invoiceid or invoiceids is required');

    await expect(
      inMemory.client.getPrompt({ name: '__unknown_prompt__', arguments: {} })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      inMemory.client.readResource({ uri: 'whmcs://contract/unknown' })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    expect(inMemory.whmcsCalls).toEqual([]);
    expect(whmcsCalls).toEqual([]);
  });
});
