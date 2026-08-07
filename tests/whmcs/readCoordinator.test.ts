import { describe, expect, it, vi } from 'vitest';
import { ReadCoordinator } from '../../src/whmcs/readCoordinator.js';

const opts = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  actionClass: 'reference' as const,
  coalesce: true,
  ...over,
});

describe('ReadCoordinator coalescing', () => {
  it.each([1, 10, 100])(
    'characterizes %i identical reads as one operation with isolated copies',
    async (count) => {
      const coordinator = new ReadCoordinator({ maxConcurrency: 4 });
      const operation = vi.fn(async () => ({ rows: [{ id: 1 }] }));
      const results = await Promise.all(
        Array.from({ length: count }, () => coordinator.run(operation, opts('same')))
      );
      expect(operation).toHaveBeenCalledTimes(1);
      if (count > 1) {
        results[0].rows.push({ id: 2 });
        expect(results[1].rows).toEqual([{ id: 1 }]);
      }
      expect(coordinator.inflightCount).toBe(0);
    }
  );

  it('does not join reads with different governance scopes/keys', async () => {
    const coordinator = new ReadCoordinator({ maxConcurrency: 2 });
    const operation = vi.fn(async () => ({ ok: true }));
    await Promise.all([
      coordinator.run(operation, opts('scope-a')),
      coordinator.run(operation, opts('scope-b')),
    ]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('cleans up failed work so the next read can retry independently', async () => {
    const coordinator = new ReadCoordinator({ maxConcurrency: 1 });
    const operation = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });
    await expect(coordinator.run(operation, opts('same'))).rejects.toThrow('boom');
    await expect(coordinator.run(operation, opts('same'))).resolves.toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(coordinator.inflightCount).toBe(0);
  });

  it('lets one subscriber cancel without aborting another subscriber', async () => {
    const coordinator = new ReadCoordinator({ maxConcurrency: 1 });
    let release: (() => void) | undefined;
    const operation = vi.fn(
      async () =>
        new Promise<{ ok: boolean }>((resolve) => {
          release = () => resolve({ ok: true });
        })
    );
    const controller = new AbortController();
    const first = coordinator.run(operation, opts('same', { signal: controller.signal }));
    const second = coordinator.run(operation, opts('same'));
    controller.abort();
    await expect(first).rejects.toBeTruthy();
    release?.();
    await expect(second).resolves.toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('ReadCoordinator scheduler', () => {
  it('enforces the configured peak bound and drains without leaks', async () => {
    const coordinator = new ReadCoordinator({ maxConcurrency: 2 });
    let active = 0;
    let peak = 0;
    const operation = async (): Promise<number> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return active;
    };
    const pending = Array.from({ length: 6 }, (_, i) =>
      coordinator.run(operation, opts(`k${i}`, { coalesce: false }))
    );
    await Promise.all(pending);
    expect(peak).toBe(2);
    expect(coordinator.activeCount).toBe(0);
    expect(coordinator.queued).toBe(0);
  });

  it('round-robins queued consumer lanes', async () => {
    const coordinator = new ReadCoordinator({ maxConcurrency: 1 });
    const starts: string[] = [];
    const releases: (() => void)[] = [];
    const run = (name: string, consumerKey: string) =>
      coordinator.run(
        async () => {
          starts.push(name);
          await new Promise<void>((resolve) => releases.push(resolve));
          return name;
        },
        opts(name, { consumerKey, coalesce: false })
      );
    const pending = [run('a1', 'a'), run('a2', 'a'), run('b1', 'b')];
    await vi.waitFor(() => expect(starts).toEqual(['a1']));
    releases.shift()?.();
    await vi.waitFor(() => expect(starts).toEqual(['a1', 'b1']));
    releases.shift()?.();
    await vi.waitFor(() => expect(starts).toEqual(['a1', 'b1', 'a2']));
    releases.shift()?.();
    await Promise.all(pending);
  });

  it('removes an aborted queued read before it executes', async () => {
    const coordinator = new ReadCoordinator({ maxConcurrency: 1 });
    let release: (() => void) | undefined;
    const blocker = coordinator.run(
      async () => new Promise<void>((resolve) => (release = resolve)),
      opts('blocker', { coalesce: false })
    );
    const controller = new AbortController();
    const queuedOperation = vi.fn(async () => 'unexpected');
    const queued = coordinator.run(
      queuedOperation,
      opts('queued', { coalesce: false, signal: controller.signal })
    );
    controller.abort();
    await expect(queued).rejects.toBeTruthy();
    release?.();
    await blocker;
    expect(queuedOperation).not.toHaveBeenCalled();
  });

  it('does not enqueue or dispatch an already-aborted read', async () => {
    const coordinator = new ReadCoordinator({ maxConcurrency: 1 });
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => 'unexpected');
    await expect(
      coordinator.run(operation, opts('aborted', { coalesce: false, signal: controller.signal }))
    ).rejects.toBeTruthy();
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.queued).toBe(0);
  });
});
