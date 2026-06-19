import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Controllable spawn mock.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
// Make the configured updater script path always "exist".
vi.mock('node:fs', () => ({ existsSync: () => true }));

import {
  attemptIpAllowlistHeal,
  _resetIpHealStateForTests,
} from '../../src/whmcs/ipAllowlistHeal.js';
import type { AppConfig } from '../../src/config.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function makeLogger(): any {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const baseConfig = {
  WHMCS_AUTO_IP_HEAL: true,
  WHMCS_IP_UPDATER_SCRIPT: '/fake/whmcs_ip_updater.py',
  WHMCS_IP_UPDATER_PYTHON: 'python3',
  WHMCS_AUTO_IP_HEAL_COOLDOWN_MS: 120000,
  WHMCS_AUTO_IP_HEAL_TIMEOUT_MS: 60000,
  WHMCS_API_URL: 'https://whmcs.example/includes/api.php',
  WHMCS_IDENTIFIER: 'id',
  WHMCS_SECRET: 'secret',
} as unknown as AppConfig;

beforeEach(() => {
  _resetIpHealStateForTests();
  spawnMock.mockReset();
});

describe('attemptIpAllowlistHeal', () => {
  it('runs the updater oneshot and returns true on exit code 0', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = attemptIpAllowlistHeal(baseConfig, makeLogger());
    child.stdout.emit('data', JSON.stringify({ data: { action: 'updated' } }));
    child.emit('close', 0);

    await expect(p).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'python3',
      ['/fake/whmcs_ip_updater.py', 'oneshot', '--no-stability-check'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('returns false when the updater exits non-zero', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = attemptIpAllowlistHeal(baseConfig, makeLogger());
    child.emit('close', 1);
    await expect(p).resolves.toBe(false);
  });

  it('passes mapped WHMCS_API_* credentials to the updater env', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = attemptIpAllowlistHeal(baseConfig, makeLogger());
    child.emit('close', 0);
    await p;
    const env = spawnMock.mock.calls[0][2].env;
    expect(env.WHMCS_API_IDENTIFIER).toBe('id');
    expect(env.WHMCS_API_SECRET).toBe('secret');
    expect(env.WHMCS_API_URL).toBe('https://whmcs.example/includes/api.php');
  });

  it('is a no-op (no spawn) when WHMCS_AUTO_IP_HEAL is false', async () => {
    const r = await attemptIpAllowlistHeal(
      { ...baseConfig, WHMCS_AUTO_IP_HEAL: false } as AppConfig,
      makeLogger()
    );
    expect(r).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('enforces the cooldown after a completed heal', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const first = attemptIpAllowlistHeal(baseConfig, makeLogger());
    child.emit('close', 0);
    await first;

    // Second call within cooldown must not spawn again.
    const r2 = await attemptIpAllowlistHeal(baseConfig, makeLogger());
    expect(r2).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent callers onto one updater run', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const a = attemptIpAllowlistHeal(baseConfig, makeLogger());
    const b = attemptIpAllowlistHeal(baseConfig, makeLogger());
    child.emit('close', 0);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(true);
    expect(rb).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
