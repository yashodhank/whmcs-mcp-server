/**
 * WhmcsClient enriches the WHMCS "An admin user is required" business error with
 * an actionable, self-diagnosing hint (Plan 022 enhancement). That message — an
 * HTTP 200 with result:error — is the signature of a misconfigured WHMCS_API_URL
 * (doubled /includes/api.php), a disabled/under-permissioned admin, or an
 * IP-allowlist block. The hint points the operator at the runbook + the checks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'test-id',
    WHMCS_SECRET: 'test-secret',
    MCP_MODE: 'read_only',
  },
  getWhmcsApiEndpoint: () => 'https://test.whmcs.com/includes/api.php',
}));

const post = vi.fn();
vi.mock('axios', () => {
  const create = vi.fn(() => ({ post }));
  return { default: { create, isAxiosError: () => false }, create, isAxiosError: () => false };
});

import { WhmcsClient } from '../../src/whmcs/WhmcsClient.js';
import type { AppConfig } from '../../src/config.js';

function makeLogger(): any {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logWhmcsCall: vi.fn(),
    child(): unknown {
      return this;
    },
  };
}
const cfg = {
  WHMCS_API_URL: 'https://test.whmcs.com',
  WHMCS_IDENTIFIER: 'test-id',
  WHMCS_SECRET: 'test-secret',
  MCP_MODE: 'read_only',
  MCP_READ_CACHE_TTL_MS: 0,
  MCP_READ_CACHE_ACTIONS: [],
} as unknown as AppConfig;

beforeEach(() => post.mockReset());

describe('WhmcsClient — "An admin user is required" hint', () => {
  it('enriches the error with the runbook + resolved endpoint + ordered checks', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { result: 'error', message: 'An admin user is required' },
    });
    const client = new WhmcsClient(cfg, makeLogger());
    await expect(client.read('GetClients', { limitnum: 1 })).rejects.toThrow(
      /An admin user is required/
    );
    await expect(client.read('GetClients', { limitnum: 1 })).rejects.toThrow(
      /api-connectivity-troubleshooting\.md/
    );
    await expect(client.read('GetClients', { limitnum: 1 })).rejects.toThrow(
      /resolved endpoint: https:\/\/test\.whmcs\.com\/includes\/api\.php/i
    );
  });

  it('leaves unrelated business errors untouched', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { result: 'error', message: 'Client ID Not Found' },
    });
    const client = new WhmcsClient(cfg, makeLogger());
    await expect(client.read('GetClientsDetails', { clientid: 999999 })).rejects.toThrow(
      /^Client ID Not Found$/
    );
  });
});
