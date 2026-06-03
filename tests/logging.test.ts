/**
 * Tests for src/logging.ts redaction behavior.
 *
 * Focus: redactSensitive must recurse into array ELEMENTS so secrets nested
 * inside arrays-of-objects are redacted, while behavior for plain objects and
 * scalars is unchanged.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '../src/logging.js';

/**
 * Capture the structured `data` object that the logger writes to stderr by
 * intercepting process.stderr.write and parsing the JSON line.
 */
function captureLogData(fn: (logger: Logger) => void): Record<string, unknown> | undefined {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    fn(new Logger('test-correlation-id'));
    expect(spy).toHaveBeenCalled();
    const line = spy.mock.calls[0][0] as string;
    const entry = JSON.parse(line) as { data?: Record<string, unknown> };
    return entry.data;
  } finally {
    spy.mockRestore();
  }
}

describe('logging redactSensitive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts sensitive keys on a flat object', () => {
    const data = captureLogData((logger) =>
      logger.info('msg', { password: 'secret', clientid: 7 })
    );
    expect(data?.password).toBe('[REDACTED]');
    expect(data?.clientid).toBe(7);
  });

  it('redacts sensitive keys nested in a plain object', () => {
    const data = captureLogData((logger) =>
      logger.info('msg', { creds: { auth_token: 'abc', name: 'alice' } })
    );
    const creds = data?.creds as Record<string, unknown>;
    expect(creds.auth_token).toBe('[REDACTED]');
    expect(creds.name).toBe('alice');
  });

  it('redacts sensitive keys inside an array of objects', () => {
    const data = captureLogData((logger) =>
      logger.info('msg', {
        entries: [
          { auth_token: 'x', password: 'y', user: 'bob' },
          { auth_token: 'z', user: 'carol' },
        ],
      })
    );
    const entries = data?.entries as Record<string, unknown>[];
    expect(entries[0].auth_token).toBe('[REDACTED]');
    expect(entries[0].password).toBe('[REDACTED]');
    expect(entries[0].user).toBe('bob');
    expect(entries[1].auth_token).toBe('[REDACTED]');
    expect(entries[1].user).toBe('carol');
  });

  it('redacts sensitive keys in deeply nested arrays-of-objects', () => {
    const data = captureLogData((logger) =>
      logger.info('msg', { outer: [{ inner: [{ secret: 's', ok: 1 }] }] })
    );
    const outer = data?.outer as Record<string, unknown>[];
    const inner = outer[0].inner as Record<string, unknown>[];
    expect(inner[0].secret).toBe('[REDACTED]');
    expect(inner[0].ok).toBe(1);
  });

  it('leaves scalar arrays untouched', () => {
    const data = captureLogData((logger) =>
      logger.info('msg', { tags: ['a', 'b', 'c'], count: 3 })
    );
    expect(data?.tags).toEqual(['a', 'b', 'c']);
    expect(data?.count).toBe(3);
  });
});
