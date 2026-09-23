import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_ENV: 'local',
    WHMCS_API_URL: 'https://my.securiace.com',
    MCP_OAUTH_ENABLED: false,
    MCP_OAUTH_RESOURCE: undefined,
    MCP_OAUTH_ISSUERS: [],
    MCP_STAFF_CONSUMER_IDS: '',
    MCP_STAFF_OIDC_SUBS: '',
    MCP_WHMCS_OIDC_ISSUER: undefined,
    MCP_READ_AUDIT_PATH: '',
    MCP_EFFECT_LEDGER_PATH: '',
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
    source: 'GetAdminDetails',
  }),
}));

vi.mock('../../src/governance/capabilities.js', () => ({
  getCapability: () => ({ action: 'GetUsers', status: 'unverified', capability: 'list_users' }),
}));

import { config } from '../../src/config.js';
import { registerMcpDoctorTools } from '../../src/tools/mcpDoctor.js';

function registerDoctor(
  read: ReturnType<typeof vi.fn> = vi.fn().mockRejectedValue(new Error('denied'))
) {
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
  registerMcpDoctorTools(
    server as never,
    { read } as never,
    logger as never,
    { tryConsume: () => true } as never
  );
  return handlers;
}

describe('mcp_doctor', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('openid-configuration.php')) {
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
        if (url.includes('.well-known')) {
          return { ok: false, status: 404, text: async () => 'not found' };
        }
        if (url.includes('certs.php')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [] }) };
        }
        return { ok: false, status: 500, text: async () => '' };
      })
    );
  });

  it('reports 8.13 family, empty JWKS, and staff allow-list warning', async () => {
    const handlers = registerDoctor();
    const res = (await handlers.mcp_doctor({})) as { structuredContent: Record<string, unknown> };
    const sc = res.structuredContent;
    expect(sc.whmcs_version).toMatchObject({ family: '8.13', version: '8.13.7' });
    expect(sc.whmcs_api).toEqual({ status: 'degraded', version_source: 'unavailable' });
    expect((sc.oidc as { jwks: { key_count: number } }).jwks.key_count).toBe(0);
    expect((sc.warnings as string[]).some((w) => w.includes('JWKS'))).toBe(true);
    expect((sc.warnings as string[]).some((w) => w.includes('MCP_STAFF_CONSUMER_IDS'))).toBe(true);
    expect((sc.oauth_rs as { federation: string }).federation).toBe('required');
    expect((sc.oauth_rs as { whmcs_issuer_rejected: boolean }).whmcs_issuer_rejected).toBe(true);
    expect(sc.empty_allowed_actions).toEqual(['wide']);
    expect(
      (sc.grok_write as { order_accept: { autosetup_default: boolean } }).order_accept
        .autosetup_default
    ).toBe(false);
    expect(
      (sc.grok_write as { package_change: { set_local_pid: string } }).package_change.set_local_pid
    ).toBe('service:product:set');
  });

  it('classifies denied optional WhmcsDetails as healthy when a fallback supplied the version', async () => {
    const read = vi.fn(async (action: string) => {
      if (action === 'WhmcsDetails') {
        throw new Error('HTTP 403 — Invalid Permissions: WhmcsDetails is not allowed');
      }
      if (action === 'GetAdminDetails' || action === 'GetConfigurationValue') {
        return { result: 'success' };
      }
      throw new Error(`unexpected ${action}`);
    });
    const handlers = registerDoctor(read);
    const res = (await handlers.mcp_doctor({})) as { structuredContent: Record<string, unknown> };
    const health = res.structuredContent.whmcs_api as {
      status: string;
      version_source: string;
    };
    const role = res.structuredContent.api_role as Record<
      string,
      { status: string; required: boolean; fallback_source?: string }
    >;

    expect(health).toEqual({ status: 'healthy', version_source: 'GetAdminDetails' });
    expect(role.WhmcsDetails).toMatchObject({
      status: 'optional_denied_with_fallback',
      required: false,
      fallback_source: 'GetAdminDetails',
    });
    expect(role.GetAdminDetails).toMatchObject({ status: 'allowed', required: true });
  });

  it('warns when MCP_OAUTH_ISSUERS includes the WHMCS origin', async () => {
    config.MCP_OAUTH_ISSUERS.push('https://my.securiace.com');
    try {
      const handlers = registerDoctor();
      const res = (await handlers.mcp_doctor({})) as { structuredContent: Record<string, unknown> };
      const warnings = res.structuredContent.warnings as string[];
      expect(warnings.some((w) => w.includes('federation AS'))).toBe(true);
      expect(
        (res.structuredContent.oauth_rs as { issuers_include_whmcs_origin: boolean })
          .issuers_include_whmcs_origin
      ).toBe(true);
    } finally {
      config.MCP_OAUTH_ISSUERS.length = 0;
    }
  });
});
