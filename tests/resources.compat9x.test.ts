import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/config.js', () => ({ config: {}, isToolAllowed: () => true }));
vi.mock('../src/security.js', () => ({ stripAuthFromUri: (u: URL) => u.href }));
import { registerCompat9xResource } from '../src/resources/compat9x.js';

describe('whmcs://docs/compat-9x resource', () => {
  it('registers and serves the 8.13/9.x compatibility markdown', async () => {
    const resources: Record<string, (uri: URL) => Promise<{ contents: { uri: string; mimeType?: string; text: string }[] }>> = {};
    const server = { resource: (n: string, _u: string, cb: unknown) => { resources[n] = cb as never; } };
    const logger = { info: vi.fn(), debug: vi.fn() };
    registerCompat9xResource(server as never, logger as never);

    expect(typeof resources['compat-9x']).toBe('function');
    const out = await resources['compat-9x'](new URL('whmcs://docs/compat-9x'));
    const text = out.contents[0].text;
    expect(out.contents[0].mimeType).toBe('text/markdown');
    expect(text).toMatch(/immutable non-draft invoices/i);
    expect(text).toMatch(/credit ?\/ ?debit notes/i);
    expect(text).toMatch(/2026-05-31/);
    expect(text).toMatch(/read-only/i);
  });
});
