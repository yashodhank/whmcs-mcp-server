import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config so importing WhmcsClient is side-effect free (no dotenv/zod load).
vi.mock('../../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'id',
    WHMCS_SECRET: 'secret',
    MCP_MODE: 'full',
  },
  getWhmcsApiEndpoint: () => 'https://test.whmcs.com/includes/api.php',
}));

// axios: post() is a controllable spy; isAxiosError detects our fake errors.
const post = vi.fn();
vi.mock('axios', () => {
  const isAxiosError = (e: any) => !!(e?.isAxiosError);
  const create = vi.fn(() => ({ post }));
  return { default: { create, isAxiosError }, create, isAxiosError };
});

// Spy on the heal so we assert WHETHER it fires and WITH WHICH reported IP.
const attemptIpAllowlistHeal = vi.fn();
vi.mock('../../src/whmcs/ipAllowlistHeal.js', () => ({
  attemptIpAllowlistHeal: (...args: any[]) => attemptIpAllowlistHeal(...args),
}));

import { WhmcsClient } from '../../src/whmcs/WhmcsClient.js';
import type { AppConfig } from '../../src/config.js';

function makeLogger(): any {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logWhmcsCall: vi.fn(),
  };
}

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    WHMCS_IDENTIFIER: 'id',
    WHMCS_SECRET: 'secret',
    MCP_MODE: 'full',
    MCP_READ_CACHE_TTL_MS: 0,
    MCP_READ_CACHE_ACTIONS: [],
    WHMCS_AUTO_IP_HEAL: true,
    ...over,
  } as unknown as AppConfig;
}

function axios403(message: string): any {
  return {
    isAxiosError: true,
    message: 'Request failed with status code 403',
    response: { status: 403, data: { result: 'error', message } },
  };
}

beforeEach(() => {
  post.mockReset();
  attemptIpAllowlistHeal.mockReset();
});

describe('WhmcsClient 403 auto-heal discrimination', () => {
  it('heals + retries on an "Invalid IP" 403, passing the WHMCS-reported IP', async () => {
    post
      .mockRejectedValueOnce(axios403('Invalid IP 117.217.28.213'))
      .mockResolvedValueOnce({ status: 200, data: { result: 'success' } });
    attemptIpAllowlistHeal.mockResolvedValue(true);

    const client = new WhmcsClient(cfg(), makeLogger());
    const result: any = await client.call('GetCurrencies', {}, { normalize: false });

    expect(result.result).toBe('success');
    expect(attemptIpAllowlistHeal).toHaveBeenCalledTimes(1);
    // 3rd arg is the reported IP parsed from the 403 body.
    expect(attemptIpAllowlistHeal.mock.calls[0][2]).toBe('117.217.28.213');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does NOT heal on a permissions 403 (different message, same status)', async () => {
    post.mockRejectedValue(axios403('Invalid Permissions: API action "whmcsdetails" is not allowed'));

    const client = new WhmcsClient(cfg(), makeLogger());
    await expect(client.call('GetCurrencies', {}, { normalize: false })).rejects.toThrow();

    expect(attemptIpAllowlistHeal).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does NOT heal when WHMCS_AUTO_IP_HEAL is off, even for an Invalid IP 403', async () => {
    post.mockRejectedValue(axios403('Invalid IP 117.217.28.213'));

    const client = new WhmcsClient(cfg({ WHMCS_AUTO_IP_HEAL: false } as Partial<AppConfig>), makeLogger());
    await expect(client.call('GetCurrencies', {}, { normalize: false })).rejects.toThrow();

    expect(attemptIpAllowlistHeal).not.toHaveBeenCalled();
  });
});
