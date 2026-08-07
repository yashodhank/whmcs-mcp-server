import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import {
  bucketWhmcsResponseSizeBytes,
  classifyWhmcsResponseSize,
  InMemoryWhmcsTelemetry,
} from '../../src/observability/whmcsTelemetry.js';
import { classifyWhmcsError } from '../../src/whmcs/request/classifier.js';
import { decodeWhmcsResponse } from '../../src/whmcs/request/decoder.js';
import { encodeWhmcsRequest, normalizeWhmcsParams } from '../../src/whmcs/request/encoder.js';
import { WhmcsBusinessError, WhmcsTransportError } from '../../src/whmcs/request/errors.js';
import { WhmcsRequestPipeline } from '../../src/whmcs/request/pipeline.js';
import type { WhmcsTransport, WhmcsTransportResponse } from '../../src/whmcs/request/types.js';

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    WHMCS_IDENTIFIER: 'identifier-value',
    WHMCS_SECRET: 'secret-value',
    WHMCS_ACCESS_KEY: 'access-value',
    WHMCS_AUTO_IP_HEAL: false,
    ...over,
  } as AppConfig;
}

function logger(): any {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logWhmcsCall: vi.fn(),
  };
}

function axiosError(status: number, data: unknown = ''): any {
  return {
    isAxiosError: true,
    name: 'AxiosError',
    message: `status ${status}`,
    response: { status, data },
  };
}

class QueueTransport implements WhmcsTransport {
  readonly post = vi.fn<() => Promise<WhmcsTransportResponse>>();
  readonly resetConnections = vi.fn();
}

describe('WHMCS request stages', () => {
  it.each([
    [0, '0'],
    [1, '1-10'],
    [10 * 1024, '1-10'],
    [10 * 1024 + 1, '11-100'],
    [100 * 1024, '11-100'],
    [100 * 1024 + 1, '101+'],
  ] as const)('buckets %i UTF-8 response bytes as %s', (bytes, expected) => {
    expect(bucketWhmcsResponseSizeBytes(bytes)).toBe(expected);
  });

  it('measures UTF-8 bytes and safely classifies unserializable values', () => {
    expect(classifyWhmcsResponseSize('é'.repeat(5 * 1024))).toBe('1-10');
    expect(classifyWhmcsResponseSize('é'.repeat(5 * 1024 + 1))).toBe('11-100');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(classifyWhmcsResponseSize(circular)).toBe('unknown');
  });

  it('normalizes before encoding and keeps credentials inside the body boundary', () => {
    const normalized = normalizeWhmcsParams({ enabled: true, disabled: false, omitted: undefined });
    expect(normalized).toEqual({ enabled: 1, disabled: 0 });
    const encoded = encodeWhmcsRequest('GetProducts', normalized, {
      identifier: 'id',
      secret: 'secret',
      accessKey: 'key',
    });
    expect(encoded.get('action')).toBe('GetProducts');
    expect(encoded.get('identifier')).toBe('id');
    expect(encoded.get('secret')).toBe('secret');
    expect(encoded.get('accesskey')).toBe('key');
  });

  it('decodes successes and preserves the existing business error contract', () => {
    expect(
      decodeWhmcsResponse(200, { result: 'success', value: 1 }, 'GetCurrencies', false, 'x')
    ).toEqual({ result: 'success', value: 1 });
    expect(() =>
      decodeWhmcsResponse(200, { result: 'error', message: 'Nope' }, 'GetCurrencies', true, 'x')
    ).toThrow(WhmcsBusinessError);
  });

  it('classifies retryable and non-retryable transport failures', () => {
    expect(classifyWhmcsError(axiosError(429)).retryable).toBe(true);
    expect(classifyWhmcsError(axiosError(503)).retryable).toBe(true);
    expect(classifyWhmcsError(axiosError(400)).retryable).toBe(false);
    expect(
      classifyWhmcsError(axiosError(403, { result: 'error', message: 'Invalid IP 2001:db8::1' }))
    ).toMatchObject({ whmcsMessage: 'Invalid IP 2001:db8::1', reportedIp: '2001:db8::1' });
  });
});

describe('WhmcsRequestPipeline characterization', () => {
  it('uses the exact three-attempt read budget for retryable failures', async () => {
    const transport = new QueueTransport();
    transport.post
      .mockRejectedValueOnce(axiosError(429))
      .mockRejectedValueOnce(axiosError(503))
      .mockResolvedValueOnce({ status: 200, data: { result: 'success' } });
    const sleep = vi.fn(async () => undefined);
    const pipeline = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport,
      sleep,
      random: () => 0,
    });

    await expect(pipeline.execute('GetProducts', {}, 'read')).resolves.toMatchObject({
      result: 'success',
    });
    expect(transport.post).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries a mutation, even when allowRetry is requested', async () => {
    const transport = new QueueTransport();
    transport.post.mockRejectedValue(axiosError(503));
    const pipeline = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport,
      sleep: vi.fn(async () => undefined),
    });
    await expect(
      pipeline.execute('UpdateClient', {}, 'write', { allowRetry: true })
    ).rejects.toBeInstanceOf(WhmcsTransportError);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ordinary 4xx but retries a network reset within the read budget', async () => {
    const badRequest = new QueueTransport();
    badRequest.post.mockRejectedValue(axiosError(400));
    const first = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport: badRequest,
      sleep: vi.fn(async () => undefined),
    });
    await expect(first.execute('GetProducts', {}, 'read')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(badRequest.post).toHaveBeenCalledTimes(1);

    const reset = new QueueTransport();
    const network = new Error('socket reset');
    Object.assign(network, { isAxiosError: true, code: 'ECONNRESET', request: {} });
    reset.post
      .mockRejectedValueOnce(network)
      .mockResolvedValueOnce({ status: 200, data: { result: 'success' } });
    const second = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport: reset,
      sleep: vi.fn(async () => undefined),
    });
    await expect(second.execute('GetProducts', {}, 'read')).resolves.toBeTruthy();
    expect(reset.post).toHaveBeenCalledTimes(2);
  });

  it('adds one IP-repair attempt without reducing or resetting the ordinary retry budget', async () => {
    const transport = new QueueTransport();
    transport.post
      .mockRejectedValueOnce(
        axiosError(403, { result: 'error', message: 'Invalid IP 203.0.113.7' })
      )
      .mockRejectedValueOnce(axiosError(503))
      .mockRejectedValueOnce(axiosError(503))
      .mockResolvedValueOnce({ status: 200, data: { result: 'success' } });
    const heal = vi.fn(async () => true);
    const pipeline = new WhmcsRequestPipeline(
      config({ WHMCS_AUTO_IP_HEAL: true }),
      logger(),
      'https://example.test/api',
      { transport, heal, sleep: vi.fn(async () => undefined), random: () => 0 }
    );
    await expect(pipeline.execute('GetProducts', {}, 'read')).resolves.toBeTruthy();
    expect(heal).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledTimes(4);
  });

  it('adds one socket-reset attempt without reducing the ordinary retry budget', async () => {
    const transport = new QueueTransport();
    transport.post
      .mockRejectedValueOnce(axiosError(403))
      .mockRejectedValueOnce(axiosError(503))
      .mockRejectedValueOnce(axiosError(503))
      .mockResolvedValueOnce({ status: 200, data: { result: 'success' } });
    const sleep = vi.fn(async () => undefined);
    const pipeline = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport,
      sleep,
      random: () => 0,
    });
    await expect(pipeline.execute('GetProducts', {}, 'read')).resolves.toBeTruthy();
    expect(transport.resetConnections).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('honors a deadline before dispatch and reports no mutation ambiguity', async () => {
    const transport = new QueueTransport();
    const pipeline = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport,
    });
    const error = await pipeline
      .execute('GetProducts', {}, 'read', { deadlineAt: Date.now() - 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WhmcsTransportError);
    expect((error as Error).message).toMatch(/deadline exceeded/);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('cancels an in-progress retry backoff before another transport dispatch', async () => {
    const transport = new QueueTransport();
    transport.post.mockRejectedValue(axiosError(503));
    const controller = new AbortController();
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      controller.abort();
      throw signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError');
    });
    const pipeline = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport,
      sleep,
    });
    await expect(
      pipeline.execute('GetProducts', {}, 'read', { signal: controller.signal })
    ).rejects.toThrow(/cancelled/);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('marks a cancelled dispatched mutation as outcome-unknown', async () => {
    const transport = new QueueTransport();
    transport.post.mockImplementation(
      (_body: URLSearchParams, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.name = 'CanceledError';
            Object.assign(error, { code: 'ERR_CANCELED' });
            reject(error);
          });
        })
    );
    const controller = new AbortController();
    const pipeline = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport,
    });
    const pending = pipeline.execute('UpdateClient', {}, 'write', { signal: controller.signal });
    await vi.waitFor(() => expect(transport.post).toHaveBeenCalledTimes(1));
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcomeUnknown: true });
    expect((error as Error).message).toMatch(/outcome may be unknown/);
  });

  it('emits only allowlisted low-cardinality telemetry fields', async () => {
    const transport = new QueueTransport();
    transport.post.mockResolvedValue({ status: 200, data: { result: 'success' } });
    const telemetry = new InMemoryWhmcsTelemetry();
    const pipeline = new WhmcsRequestPipeline(config(), logger(), 'https://example.test/api', {
      transport,
      telemetry,
    });
    await pipeline.execute('GetClientsDetails', { clientid: 42, secret: 'never-emit' }, 'read');
    const serialized = JSON.stringify(telemetry.events);
    expect(serialized).not.toMatch(/42|never-emit|identifier-value|secret-value|GetClientsDetails/);
    expect(telemetry.events.every((event) => event.actionClass === 'account')).toBe(true);
    expect(
      telemetry.events.find((event) => event.phase === 'transport' && event.outcome === 'success')
        ?.sizeBucket
    ).toBe('1-10');
  });
});
