import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  _resetVersionProfileCacheForTests,
  getWhmcsVersionProfile,
  is813,
  isAtLeast9,
} from '../../src/whmcs/versionProfile.js';

beforeEach(() => {
  _resetVersionProfileCacheForTests();
});

describe('versionProfile', () => {
  it('classifies WHMCS 8.13.x', async () => {
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      whmcs: { version: '8.13.1', canonicalversion: '8.13.1-release.1' },
    });
    const profile = await getWhmcsVersionProfile({ read } as never);
    expect(profile.family).toBe('8.13');
    expect(profile.version).toBe('8.13.1');
    expect(is813(profile)).toBe(true);
    expect(isAtLeast9(profile)).toBe(false);
  });

  it('classifies WHMCS 9.x', async () => {
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      whmcs: { version: '9.0.0', canonicalversion: '9.0.0-release.1' },
    });
    const profile = await getWhmcsVersionProfile({ read } as never);
    expect(profile.family).toBe('9.x');
    expect(isAtLeast9(profile)).toBe(true);
  });

  it('classifies other 8.x', async () => {
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      whmcs: { version: '8.10.1' },
    });
    const profile = await getWhmcsVersionProfile({ read } as never);
    expect(profile.family).toBe('8.x');
  });

  it('returns unknown on probe failure', async () => {
    const read = vi.fn().mockRejectedValue(new Error('403'));
    const profile = await getWhmcsVersionProfile({ read } as never);
    expect(profile.family).toBe('unknown');
    expect(profile.version).toBeNull();
  });

  it('caches the profile for 15 minutes', async () => {
    let t = 1_000_000;
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      whmcs: { version: '9.1.0' },
    });
    const now = () => t;
    const client = { read } as never;
    await getWhmcsVersionProfile(client, now);
    t += 5 * 60 * 1000;
    await getWhmcsVersionProfile(client, now);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
