import { describe, it, expect, vi } from 'vitest';
import { requireSingleClient, resolvePrincipal } from '../../src/identity/resolvePrincipal.js';

describe('resolvePrincipal', () => {
  it('never guesses when multiple clients match', async () => {
    const whmcs = {
      read: vi.fn().mockResolvedValue({
        result: 'success',
        id: 1,
        email: 'a@example.com',
        users: [
          {
            email: 'a@example.com',
            clients: [
              { id: 10, isOwner: true },
              { id: 20, isOwner: false },
            ],
          },
        ],
      }),
    };
    const r = await resolvePrincipal(whmcs as never, { email: 'a@example.com' });
    expect(r.picker_required).toBe(true);
    expect(r.clients).toHaveLength(2);
    expect(r.get_users).toBe('not_used');
    expect(requireSingleClient(r).ok).toBe(false);
    expect(requireSingleClient(r, 20).ok).toBe(true);
  });

  it('returns a single client without a picker', async () => {
    const whmcs = {
      read: vi.fn().mockResolvedValue({
        result: 'success',
        id: 42,
        firstname: 'Ada',
        lastname: 'Lovelace',
        email: 'ada@example.com',
        status: 'Active',
      }),
    };
    const r = await resolvePrincipal(whmcs as never, { email: 'ada@example.com' });
    expect(r.picker_required).toBe(false);
    expect(requireSingleClient(r)).toEqual({ ok: true, clientid: 42 });
    expect(whmcs.read.mock.calls.some((c: unknown[]) => c[0] === 'GetUsers')).toBe(false);
  });

  it('unwraps WHMCS users.user / clients.client wrappers', async () => {
    const whmcs = {
      read: vi.fn().mockResolvedValue({
        result: 'success',
        users: {
          user: [
            {
              email: 'a@example.com',
              clients: {
                client: [
                  { id: 10, isOwner: true },
                  { id: 11, isOwner: false },
                ],
              },
            },
          ],
        },
      }),
    };
    const r = await resolvePrincipal(whmcs as never, { email: 'a@example.com' });
    expect(r.clients.map((c) => c.clientid)).toEqual([10, 11]);
    expect(r.picker_required).toBe(true);
  });
});
