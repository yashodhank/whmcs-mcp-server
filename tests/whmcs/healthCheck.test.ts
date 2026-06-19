/**
 * Boot-time WHMCS connectivity self-check (Plan 022 enhancement).
 * Validates the pure failure classifier and the probe wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { classifyConnectivityError, checkWhmcsConnectivity } from '../../src/whmcs/healthCheck.js';
import type { WhmcsClient } from '../../src/whmcs/WhmcsClient.js';

const EP = 'https://h.example.com/includes/api.php';

describe('classifyConnectivityError', () => {
  it('flags the doubled-path / admin-context failure with the URL hint + endpoint', () => {
    const r = classifyConnectivityError(new Error('An admin user is required'), EP);
    expect(r.reason).toBe('admin-context-unresolved');
    expect(r.hint).toMatch(/base origin/i);
    expect(r.hint).toContain(EP);
    expect(r.hint).toMatch(/api-connectivity-troubleshooting\.md/);
  });
  it('flags bad credentials', () => {
    expect(classifyConnectivityError(new Error('Authentication Failed'), EP).reason).toBe(
      'auth-failed'
    );
  });
  it('flags DNS resolution failures', () => {
    expect(
      classifyConnectivityError(new Error('getaddrinfo ENOTFOUND h.example.com'), EP).reason
    ).toBe('dns');
  });
  it('flags unreachable host (connection refused / timeout)', () => {
    expect(classifyConnectivityError(new Error('connect ECONNREFUSED'), EP).reason).toBe(
      'unreachable'
    );
    expect(classifyConnectivityError(new Error('timeout of 30000ms exceeded'), EP).reason).toBe(
      'unreachable'
    );
  });
  it('flags 403 as an IP-allowlist likelihood', () => {
    expect(classifyConnectivityError(new Error('WHMCS returned HTTP 403'), EP).reason).toBe(
      'forbidden'
    );
  });
  it('falls back to unknown for unrecognized errors', () => {
    const r = classifyConnectivityError(new Error('teapot'), EP);
    expect(r.reason).toBe('unknown');
    expect(r.hint).toContain('teapot');
  });
});

describe('checkWhmcsConnectivity', () => {
  it('returns ok on a successful probe read', async () => {
    const read = vi.fn().mockResolvedValue({ result: 'success' });
    const client = { read } as unknown as WhmcsClient;
    const r = await checkWhmcsConnectivity(client);
    expect(r.ok).toBe(true);
    expect(read).toHaveBeenCalledWith('GetAdminDetails');
  });
  it('returns a classified, non-thrown result on failure', async () => {
    const client = {
      read: vi.fn().mockRejectedValue(new Error('An admin user is required')),
    } as unknown as WhmcsClient;
    const r = await checkWhmcsConnectivity(client);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('admin-context-unresolved');
    expect(r.hint).toBeTruthy();
  });
});
