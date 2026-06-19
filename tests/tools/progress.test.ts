/**
 * ToolProgress unit tests — the shared MCP progress-notification helper.
 *
 * Proves the zero-risk invariants:
 *  - NO-OP when the client did not arm progress (missing token or sender);
 *  - emits cumulative notifications/progress when armed (token + sender);
 *  - setTotal() revises a dynamic fan-out count without going backwards;
 *  - NEVER THROWS even when the transport's sendNotification throws/rejects.
 */

import { describe, it, expect } from 'vitest';
import { ToolProgress, type ProgressExtra } from '../../src/tools/progress.js';

interface Captured {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

/** An armed extra that captures every emitted progress notification. */
function armedExtra(token: string | number = 'tok-1'): {
  extra: ProgressExtra;
  sent: Captured[];
} {
  const sent: Captured[] = [];
  const extra: ProgressExtra = {
    _meta: { progressToken: token },
    sendNotification: (n) => {
      sent.push(n.params);
      return Promise.resolve();
    },
  };
  return { extra, sent };
}

describe('ToolProgress — feature-detect / no-op', () => {
  it('emits nothing when extra is undefined', () => {
    const p = new ToolProgress(3);
    expect(p.active).toBe(false);
    p.step('a');
    p.finish();
    // No throw, nothing to assert beyond inactivity.
  });

  it('emits nothing when a sender is present but no progressToken', () => {
    const sent: Captured[] = [];
    const extra: ProgressExtra = {
      sendNotification: (n) => {
        sent.push(n.params);
        return Promise.resolve();
      },
    };
    const p = new ToolProgress(3, extra);
    expect(p.active).toBe(false);
    p.step('a');
    p.finish();
    expect(sent).toHaveLength(0);
  });

  it('emits nothing when a token is present but no sender', () => {
    const p = new ToolProgress(3, { _meta: { progressToken: 7 } });
    expect(p.active).toBe(false);
    p.step('a');
    expect(p.active).toBe(false);
  });
});

describe('ToolProgress — armed emission', () => {
  it('emits cumulative progress per step, then a terminal finish ping', () => {
    const { extra, sent } = armedExtra();
    const p = new ToolProgress(2, extra);
    p.step('first');
    p.step('second');
    p.finish();

    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ progressToken: 'tok-1', progress: 1, total: 2 });
    expect(sent[0].message).toContain('first 1/2');
    expect(sent[1]).toMatchObject({ progress: 2, total: 2 });
    expect(sent[2]).toMatchObject({ progress: 2, total: 2 });
    expect(sent[2].message).toContain('complete 2/2');
  });

  it('step never exceeds total', () => {
    const { extra, sent } = armedExtra(42);
    const p = new ToolProgress(1, extra);
    p.step('a');
    p.step('b'); // would exceed; clamped
    expect(sent.every((s) => (s.progress ?? 0) <= 1)).toBe(true);
    expect(sent[sent.length - 1].progress).toBe(1);
  });

  it('setTotal revises a dynamic count and never drops below work already done', () => {
    const { extra, sent } = armedExtra();
    const p = new ToolProgress(0, extra);
    p.setTotal(3); // count known after a fan-out read
    p.step('x');
    p.setTotal(1); // a smaller revision must not lose the step already reported
    p.finish();
    expect(sent[0]).toMatchObject({ progress: 1, total: 3 });
    // finish reports total >= done (1), never a total below the work done.
    expect(sent[sent.length - 1].total).toBeGreaterThanOrEqual(1);
  });

  it('section() is an alias of step()', () => {
    const { extra, sent } = armedExtra();
    const p = new ToolProgress(1, extra);
    p.section('client');
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain('client 1/1');
  });
});

describe('ToolProgress — never throws', () => {
  it('swallows a synchronous sender throw', () => {
    const extra: ProgressExtra = {
      _meta: { progressToken: 'tok' },
      sendNotification: () => {
        throw new Error('sync transport boom');
      },
    };
    const p = new ToolProgress(1, extra);
    expect(() => {
      p.step('a');
      p.finish();
    }).not.toThrow();
  });

  it('swallows an async sender rejection', async () => {
    const extra: ProgressExtra = {
      _meta: { progressToken: 'tok' },
      sendNotification: () => Promise.reject(new Error('async transport boom')),
    };
    const p = new ToolProgress(1, extra);
    expect(() => p.step('a')).not.toThrow();
    // Let the rejection settle; the internal .catch() must absorb it.
    await Promise.resolve();
    await Promise.resolve();
  });
});
