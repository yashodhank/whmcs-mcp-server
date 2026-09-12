import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_ENV: 'local',
    WHMCS_API_URL: 'https://my.securiace.com',
    MCP_OAUTH_ENABLED: false,
    MCP_OAUTH_RESOURCE: undefined,
    MCP_OAUTH_ISSUERS: [],
    MCP_STAFF_CONSUMER_IDS: '',
    MCP_READ_AUDIT_PATH: '',
    MCP_WRITE_INTENT_STORE_PATH: '',
    MCP_CUSTOMER_USER_API_PROVEN: false,
  },
  isToolAllowed: () => true,
  getWhmcsApiEndpoint: () => 'https://my.securiace.com/includes/api.php',
  resolveWhmcsApiEndpoint: (u: string) =>
    u.endsWith('/includes/api.php') ? u : `${u}/includes/api.php`,
}));

vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
}));

vi.mock('../../src/auth/trustedStdioDefault.js', () => ({
  hasStdioDefaultToken: () => false,
}));

vi.mock('../../src/governance/pipeline.js', () => ({
  getConsumerRegistry: () => [
    {
      id: 'wide',
      allowedActions: [],
      anonymous: false,
    },
  ],
}));

vi.mock('../../src/whmcs/versionProfile.js', () => ({
  getWhmcsVersionProfile: async () => ({
    family: '8.13',
    version: '8.13.7',
    release: '8.13.7-release.1',
    probedAt: '2026-09-12T00:00:00.000Z',
  }),
}));

vi.mock('../../src/governance/capabilities.js', () => ({
  getCapability: () => ({ action: 'GetUsers', status: 'unverified', capability: 'list_users' }),
}));

import { registerMcpDoctorTools } from '../../src/tools/mcpDoctor.js';

describe('mcp_doctor', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('openid-configuration.php')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                issuer: 'https://my.securiace.com',
                scopes_supported: ['openid', 'email', 'profile'],
                jwks_uri: 'https://my.securiace.com/oauth/certs.php',
              }),
          };
        }
        if (String(url).includes('.well-known')) {
          return { ok: false, status: 404, text: async () => 'not found' };
        }
        if (String(url).includes('certs.php')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [] }) };
        }
        return { ok: false, status: 500, text: async () => '' };
      })
    );
  });

  it('reports 8.13 family, empty JWKS, and staff allow-list warning', async () => {
    const handlers: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {};
    const server = {
      registerTool: (
        n: string,
        _c: unknown,
        cb: (p: Record<string, unknown>) => Promise<unknown>
      ) => {
        handlers[n] = cb;
      },
    };
    const logger = { child: () => ({ logToolCall: vi.fn(), logToolResult: vi.fn() }) };
    const read = vi.fn().mockRejectedValue(new Error('denied'));
    registerMcpDoctorTools(
      server as never,
      { read } as never,
      logger as never,
      {
        tryConsume: () => true,
      } as never
    );
    const res = (await handlers.mcp_doctor({})) as { structuredContent: Record<string, unknown> };
    const sc = res.structuredContent;
    expect(sc.whmcs_version).toMatchObject({ family: '8.13', version: '8.13.7' });
    expect((sc.oidc as { jwks: { key_count: number } }).jwks.key_count).toBe(0);
    expect((sc.warnings as string[]).some((w) => w.includes('JWKS'))).toBe(true);
    expect((sc.warnings as string[]).some((w) => w.includes('MCP_STAFF_CONSUMER_IDS'))).toBe(true);
    expect(sc.empty_allowed_actions).toEqual(['wide']);
  });
});
