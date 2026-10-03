/**
 * Tests for the WHMCS event receiver: HMAC verification, duplicate drop,
 * allowlist filtering, and happy-path forward.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifySignature,
  createDedupStore,
  createEventReceiver,
  ALLOWED_EVENTS,
  type EventPayload,
} from '../../src/http/eventReceiver.js';

const TEST_SECRET = 'test-hmac-secret-never-production';

function sign(body: string, secret: string = TEST_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makeEvent(overrides?: Partial<EventPayload>): EventPayload {
  return {
    event: 'invoice.paid',
    timestamp: '2026-10-01T12:00:00Z',
    event_id: 'aabbccdd00112233aabbccdd00112233',
    payload: { invoiceid: 42 },
    ...overrides,
  };
}

function makeBody(overrides?: Partial<EventPayload>): string {
  return JSON.stringify(makeEvent(overrides));
}

// ── Signature verification ─────────────────────────────────────────────────

describe('verifySignature', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const body = makeBody();
    expect(verifySignature(body, sign(body), TEST_SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = makeBody();
    const tampered = body.replace('42', '99');
    expect(verifySignature(tampered, sign(body), TEST_SECRET)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const body = makeBody();
    expect(verifySignature(body, sign(body, 'wrong-secret'), TEST_SECRET)).toBe(false);
  });

  it('rejects missing sha256= prefix', () => {
    const body = makeBody();
    const raw = createHmac('sha256', TEST_SECRET).update(body).digest('hex');
    expect(verifySignature(body, raw, TEST_SECRET)).toBe(false);
  });

  it('rejects empty signature', () => {
    expect(verifySignature('{}', '', TEST_SECRET)).toBe(false);
  });
});

// ── Dedup store ────────────────────────────────────────────────────────────

describe('createDedupStore', () => {
  it('detects duplicates within the window', () => {
    const store = createDedupStore(60_000);
    expect(store.has('id-1')).toBe(false);
    store.add('id-1');
    expect(store.has('id-1')).toBe(true);
  });

  it('does not flag unseen ids', () => {
    const store = createDedupStore(60_000);
    store.add('id-1');
    expect(store.has('id-2')).toBe(false);
  });

  it('disabled store (windowMs=0) never deduplicates', () => {
    const store = createDedupStore(0);
    store.add('id-1');
    expect(store.has('id-1')).toBe(false);
  });
});

// ── Allowlist ──────────────────────────────────────────────────────────────

describe('ALLOWED_EVENTS', () => {
  it.each([
    'invoice.paid',
    'ticket.opened',
    'service.suspended',
    'module.create_failed',
    'domain.grace_or_expired',
  ])('includes %s', (evt) => {
    expect(ALLOWED_EVENTS.has(evt)).toBe(true);
  });

  it('rejects unknown events', () => {
    expect(ALLOWED_EVENTS.has('client.deleted')).toBe(false);
    expect(ALLOWED_EVENTS.has('')).toBe(false);
  });
});

// ── Full receiver integration ──────────────────────────────────────────────

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    logWhmcsCall: vi.fn(),
    getCorrelationId: vi.fn().mockReturnValue('test-corr'),
  };
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      res.statusCode = status;
      if (headers) res.headers = { ...res.headers, ...headers };
    }),
    end: vi.fn((body?: string) => {
      res.body = body ?? '';
    }),
  };
  return res;
}

function mockReq(body: string, headers: Record<string, string> = {}, method = 'POST') {
  const chunks = [Buffer.from(body)];
  let idx = 0;
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (idx < chunks.length) {
            return Promise.resolve({ value: chunks[idx++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  } as unknown as import('node:http').IncomingMessage;
}

describe('createEventReceiver.handle', () => {
  const logger = mockLogger();
  let notifierUrl: string;
  let receiver: ReturnType<typeof createEventReceiver>;

  beforeEach(() => {
    notifierUrl = '';
    receiver = createEventReceiver({
      logger: logger as unknown as import('../../src/logging.js').Logger,
      hmacSecret: TEST_SECRET,
      notifierUrl,
      dedupWindowMs: 300_000,
    });
  });

  it('rejects non-POST methods', async () => {
    const res = mockRes();
    await receiver.handle(
      mockReq('', {}, 'GET'),
      res as unknown as import('node:http').ServerResponse
    );
    expect(res.statusCode).toBe(405);
  });

  it('rejects missing signature', async () => {
    const body = makeBody();
    const res = mockRes();
    await receiver.handle(mockReq(body), res as unknown as import('node:http').ServerResponse);
    expect(res.statusCode).toBe(401);
  });

  it('rejects invalid signature', async () => {
    const body = makeBody();
    const res = mockRes();
    await receiver.handle(
      mockReq(body, { 'x-mcp-signature': 'sha256=0000' }),
      res as unknown as import('node:http').ServerResponse
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects events not in allowlist', async () => {
    const body = makeBody({ event: 'client.deleted' });
    const res = mockRes();
    await receiver.handle(
      mockReq(body, { 'x-mcp-signature': sign(body) }),
      res as unknown as import('node:http').ServerResponse
    );
    expect(res.statusCode).toBe(422);
  });

  it('accepts a valid signed allowlisted event (202)', async () => {
    const body = makeBody();
    const res = mockRes();
    await receiver.handle(
      mockReq(body, { 'x-mcp-signature': sign(body) }),
      res as unknown as import('node:http').ServerResponse
    );
    expect(res.statusCode).toBe(202);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe('accepted');
  });

  it('drops duplicates (same event_id)', async () => {
    const body = makeBody({ event_id: 'dup-test-id-00000000000000000000' });
    const sig = sign(body);

    const res1 = mockRes();
    await receiver.handle(
      mockReq(body, { 'x-mcp-signature': sig }),
      res1 as unknown as import('node:http').ServerResponse
    );
    expect(res1.statusCode).toBe(202);

    const res2 = mockRes();
    await receiver.handle(
      mockReq(body, { 'x-mcp-signature': sig }),
      res2 as unknown as import('node:http').ServerResponse
    );
    expect(res2.statusCode).toBe(200);
    const parsed = JSON.parse(res2.body);
    expect(parsed.status).toBe('duplicate');
  });

  it('forwards accepted events to notifier URL (best-effort)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const receiverWithNotifier = createEventReceiver({
      logger: logger as unknown as import('../../src/logging.js').Logger,
      hmacSecret: TEST_SECRET,
      notifierUrl: 'https://grokbot.example.com/webhook',
      dedupWindowMs: 300_000,
    });

    const body = makeBody({ event_id: 'forward-test-id-000000000000' });
    const res = mockRes();
    await receiverWithNotifier.handle(
      mockReq(body, { 'x-mcp-signature': sign(body) }),
      res as unknown as import('node:http').ServerResponse
    );
    expect(res.statusCode).toBe(202);

    // Wait a tick for the async forward
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://grokbot.example.com/webhook');
    expect((opts as RequestInit).method).toBe('POST');

    fetchSpy.mockRestore();
  });

  it('notifier failure does not affect the 202 response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const receiverWithNotifier = createEventReceiver({
      logger: logger as unknown as import('../../src/logging.js').Logger,
      hmacSecret: TEST_SECRET,
      notifierUrl: 'https://broken.example.com/webhook',
      dedupWindowMs: 300_000,
    });

    const body = makeBody({ event_id: 'fail-forward-test-0000000000' });
    const res = mockRes();
    await receiverWithNotifier.handle(
      mockReq(body, { 'x-mcp-signature': sign(body) }),
      res as unknown as import('node:http').ServerResponse
    );
    expect(res.statusCode).toBe(202);

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'Event notifier forward error',
      expect.objectContaining({ error: 'network down' })
    );

    fetchSpy.mockRestore();
  });

  it('rejects when HMAC secret is not configured', async () => {
    const receiverNoSecret = createEventReceiver({
      logger: logger as unknown as import('../../src/logging.js').Logger,
      hmacSecret: '',
      notifierUrl: '',
      dedupWindowMs: 300_000,
    });

    const body = makeBody();
    const res = mockRes();
    await receiverNoSecret.handle(
      mockReq(body, { 'x-mcp-signature': sign(body) }),
      res as unknown as import('node:http').ServerResponse
    );
    expect(res.statusCode).toBe(503);
  });
});
